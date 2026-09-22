import { randomUUID } from "node:crypto";
import { digest } from "./hash.ts";
import type { ExecutionIdentity } from "./identity.ts";

/**
 * C2 lifecycle contract: pause, cancel, resume, session generations, leases and execution
 * authority. Two invariants: (1) every control transition advances the session generation, so
 * results from an attempt opened before a pause/cancel/resume are rejected as late; (2) lifecycle
 * state and side-effect state are tracked separately - completing a cancellation never claims the
 * external operations did not happen, it reports whether reconciliation is still required.
 */

export type ControlledPhase = "running" | "paused" | "cancelling" | "cancelled" | "settled" | "failed";

export interface SessionToken {
	sessionId: string;
	generation: number;
}

export interface ExecutionPermit {
	permitId: string;
	token: SessionToken;
	issuedAt: number;
}

export interface DispatchRecord {
	operationDigest: string;
	dispatchedAt: number;
	settledAt?: number;
}

export interface LifecycleSnapshot {
	version: 1;
	sessionId: string;
	phase: ControlledPhase;
	generation: number;
	openedAt: number;
	transitionLog: { kind: string; at: number; detail: string }[];
	dispatches: DispatchRecord[];
}

export type PermitOutcome = "accepted" | "rejected-late";

/** Single-owner control state machine; a service must serialize commands and persist snapshots. */
export class SessionLifecycle {
	readonly sessionId: string;
	private readonly openedAt: number;
	private phase: ControlledPhase = "running";
	private generation = 1;
	private readonly transitionLog: { kind: string; at: number; detail: string }[] = [];
	private readonly dispatches = new Map<string, DispatchRecord>();

	constructor(sessionId: string, openedAt: number) {
		if (!sessionId || sessionId.length > 200 || !Number.isFinite(openedAt)) throw new Error("Invalid session identity");
		this.sessionId = sessionId;
		this.openedAt = openedAt;
		this.transitionLog.push({ kind: "open", at: openedAt, detail: "" });
	}

	get currentPhase(): ControlledPhase { return this.phase; }
	get currentToken(): SessionToken { return { sessionId: this.sessionId, generation: this.generation }; }
	get outstandingDispatches(): DispatchRecord[] {
		return [...this.dispatches.values()].filter((record) => record.settledAt === undefined);
	}
	get reconciliationRequired(): boolean { return this.outstandingDispatches.length > 0; }

	pause(reason: string, now: number): void {
		if (this.phase !== "running" || !reason || !Number.isFinite(now)) throw new Error("Only a running session can pause");
		this.phase = "paused";
		this.generation++;
		this.transitionLog.push({ kind: "pause", at: now, detail: reason });
	}

	resume(reason: string, now: number): void {
		if (this.phase !== "paused" || !reason || !Number.isFinite(now)) throw new Error("Only a paused session can resume");
		this.phase = "running";
		this.generation++;
		this.transitionLog.push({ kind: "resume", at: now, detail: reason });
	}

	requestCancel(reason: string, now: number): void {
		if ((this.phase !== "running" && this.phase !== "paused") || !reason || !Number.isFinite(now)) {
			throw new Error("Only an active session can request cancellation");
		}
		this.phase = "cancelling";
		this.generation++;
		this.transitionLog.push({ kind: "request-cancel", at: now, detail: reason });
	}

	/** Completing a cancellation records - never erases - the outstanding side effects. */
	completeCancel(now: number): { reconciliationRequired: boolean } {
		if (this.phase !== "cancelling" || !Number.isFinite(now)) throw new Error("Cancellation has not been requested");
		this.phase = "cancelled";
		this.transitionLog.push({
			kind: "complete-cancel", at: now,
			detail: this.reconciliationRequired ? "outstanding side effects require reconciliation" : "no outstanding side effects",
		});
		return { reconciliationRequired: this.reconciliationRequired };
	}

	settle(outcome: "succeeded" | "failed", detail: string, now: number): void {
		if (this.phase !== "running" || !Number.isFinite(now)) throw new Error("Only a running session can settle");
		this.phase = outcome === "succeeded" ? "settled" : "failed";
		this.transitionLog.push({ kind: "settle", at: now, detail });
	}

	beginExecution(now: number): ExecutionPermit {
		if (this.phase !== "running" || !Number.isFinite(now)) throw new Error("Execution authority requires a running session");
		return { permitId: randomUUID(), token: { ...this.currentToken }, issuedAt: now };
	}

	/** A permit whose generation no longer matches, or that arrives outside a running phase, is late. */
	settleExecution(permit: ExecutionPermit, now: number): PermitOutcome {
		if (!Number.isFinite(now)) throw new Error("Invalid settlement time");
		if (this.phase !== "running" || permit.token.sessionId !== this.sessionId ||
			permit.token.generation !== this.generation) return "rejected-late";
		return "accepted";
	}

	recordDispatch(operationDigest: string, now: number): void {
		if (!operationDigest || this.dispatches.has(operationDigest) || !Number.isFinite(now)) {
			throw new Error("Invalid or duplicate side-effect dispatch");
		}
		this.dispatches.set(operationDigest, { operationDigest, dispatchedAt: now });
	}

	settleSideEffect(operationDigest: string, now: number): void {
		const record = this.dispatches.get(operationDigest);
		if (!record || !Number.isFinite(now)) throw new Error("Unknown side-effect settlement");
		record.settledAt = now;
	}

	exportState(): LifecycleSnapshot {
		return {
			version: 1, sessionId: this.sessionId, phase: this.phase, generation: this.generation,
			openedAt: this.openedAt, transitionLog: structuredClone(this.transitionLog),
			dispatches: [...this.dispatches.values()].map((record) => ({ ...record })),
		};
	}

	restore(snapshot: LifecycleSnapshot): void {
		if (snapshot.version !== 1 || snapshot.sessionId !== this.sessionId ||
			!Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 ||
			!["running", "paused", "cancelling", "cancelled", "settled", "failed"].includes(snapshot.phase)) {
			throw new Error("Invalid lifecycle snapshot");
		}
		this.phase = snapshot.phase;
		this.generation = snapshot.generation + 1; // Never restore execution authority of the lost generation.
		this.transitionLog.length = 0;
		this.transitionLog.push(...structuredClone(snapshot.transitionLog));
		this.dispatches.clear();
		for (const record of snapshot.dispatches) {
			if (!record.operationDigest || !Number.isFinite(record.dispatchedAt) ||
				(record.settledAt !== undefined && !Number.isFinite(record.settledAt))) throw new Error("Invalid dispatch snapshot");
			this.dispatches.set(record.operationDigest, { ...record });
		}
	}
}

/** Cross-process lease record (integration workspaces, coordinator roles, memory distill claims). */
export interface PersistentLease {
	leaseId: string;
	purpose: string;
	owner: string;
	token: string;
	generation: number;
	acquiredAt: number;
	expiresAt: number;
}

export function issueLease(purpose: string, owner: string, generation: number, now: number, leaseMs: number): PersistentLease {
	if (!purpose || !owner || !Number.isSafeInteger(generation) || generation < 1 ||
		!Number.isFinite(now) || !Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("Invalid lease request");
	return { leaseId: randomUUID(), purpose, owner, token: randomUUID(), generation, acquiredAt: now, expiresAt: now + leaseMs };
}

export function leaseValid(lease: PersistentLease, generation: number, now: number): boolean {
	return Number.isSafeInteger(generation) && lease.generation === generation &&
		Number.isFinite(now) && lease.acquiredAt <= now && now < lease.expiresAt;
}

export type WakeReason =
	| "task-finished"
	| "acceptance-recorded"
	| "dependency-released"
	| "plan-appended"
	| "node-recovered"
	| "manual-unblock"
	| "lease-recovered";

export interface WakeEvent {
	version: 1;
	reason: WakeReason;
	subject: string;
	detail: string;
	occurredAt: number;
	eventDigest: string;
	delivered: boolean;
	deliveredAt?: number;
}

/**
 * Persistable wake queue. Every dispatcher exit path (task end, acceptance, dependency release,
 * plan append, node recovery, manual unblock, lease recovery) records an event; an idle scheduler
 * loop consumes pending events instead of exiting. Recording is idempotent by digest so store
 * replays and at-least-once delivery cannot stack duplicates.
 */
export class WakeQueue {
	private readonly events = new Map<string, WakeEvent>();

	record(reason: WakeReason, subject: string, detail: string, occurredAt: number): WakeEvent {
		if (!subject || !detail || !Number.isFinite(occurredAt)) throw new Error("Invalid wake event");
		const eventDigest = digest(["wake", reason, subject, detail, occurredAt]);
		const existing = this.events.get(eventDigest);
		if (existing) return { ...existing };
		const event: WakeEvent = { version: 1, reason, subject, detail, occurredAt, eventDigest, delivered: false };
		this.events.set(eventDigest, event);
		return { ...event };
	}

	pending(): WakeEvent[] {
		return [...this.events.values()].filter((event) => !event.delivered)
			.sort((a, b) => a.occurredAt - b.occurredAt || a.eventDigest.localeCompare(b.eventDigest))
			.map((event) => ({ ...event }));
	}

	acknowledge(eventDigests: readonly string[], now: number): void {
		if (!Number.isFinite(now)) throw new Error("Invalid acknowledgement time");
		for (const eventDigest of eventDigests) {
			const event = this.events.get(eventDigest);
			if (!event) throw new Error(`Unknown wake event: ${eventDigest}`);
			if (!event.delivered) {
				event.delivered = true;
				event.deliveredAt = now;
			}
		}
	}

	exportState(): { version: 1; events: WakeEvent[] } {
		return { version: 1, events: [...this.events.values()].map((event) => ({ ...event })) };
	}

	restore(snapshot: { version: 1; events: WakeEvent[] }): void {
		if (snapshot.version !== 1 || !Array.isArray(snapshot.events)) throw new Error("Invalid wake queue snapshot");
		this.events.clear();
		for (const stored of snapshot.events) {
			const recomputed = digest(["wake", stored.reason, stored.subject, stored.detail, stored.occurredAt]);
			if (stored.version !== 1 || recomputed !== stored.eventDigest) throw new Error("Wake event fails integrity re-derivation");
			this.events.set(stored.eventDigest, { ...stored });
		}
	}
}

/** A wake event may dispatch new work only in a running phase with capacity to observe it. */
export function wakeEligible(phase: ControlledPhase, pendingCount: number, capacityFree: boolean): boolean {
	return phase === "running" && pendingCount > 0 && capacityFree;
}
