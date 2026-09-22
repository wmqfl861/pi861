import { digest } from "./hash.ts";

/**
 * C4 storage: synchronous transactions commit state, request receipts and outbox together.
 * External work runs after commit. Persistence and recovery are trusted host boundaries.
 */
export type CommitState = "committed" | "unknown";

export interface TransactionReceipt {
	requestId: string;
	state: CommitState;
	version: number;
	contentDigest: string;
	committedAt?: number;
}

export class IdempotencyConflict extends Error {
	constructor(requestId: string) {
		super(`Request id replayed with different content: ${requestId}`);
	}
}

export class VersionConflict extends Error {
	constructor(expected: number, actual: number) {
		super(`Version conflict: expected ${expected}, store is at ${actual}`);
	}
}

/** Idempotent receipts; an unknown outcome can only be resolved by trusted reconciliation. */
export class ReceiptLog {
	private readonly receipts = new Map<string, TransactionReceipt>();
	private readonly notCommitted = new Set<string>();

	record(requestId: string, contentDigest: string, version: number, now: number): TransactionReceipt {
		this.requireShape(requestId, contentDigest);
		if (!Number.isSafeInteger(version) || version < 0 || !Number.isFinite(now))
			throw new Error("Invalid receipt version or time");
		const existing = this.receipts.get(requestId);
		if (existing) {
			if (existing.contentDigest !== contentDigest) throw new IdempotencyConflict(requestId);
			if (existing.state === "committed") return { ...existing };
			const resolved = { ...existing, state: "committed" as const, version, committedAt: now };
			this.receipts.set(requestId, resolved);
			return { ...resolved };
		}
		this.notCommitted.delete(requestId);
		const receipt: TransactionReceipt = { requestId, state: "committed", version, contentDigest, committedAt: now };
		this.receipts.set(requestId, receipt);
		return { ...receipt };
	}

	markUnknown(requestId: string, contentDigest: string, attemptedVersion: number): TransactionReceipt {
		this.requireShape(requestId, contentDigest);
		if (!Number.isSafeInteger(attemptedVersion) || attemptedVersion < 0) throw new Error("Invalid attempted version");
		const existing = this.receipts.get(requestId);
		if (existing) {
			if (existing.contentDigest !== contentDigest) throw new IdempotencyConflict(requestId);
			return { ...existing };
		}
		const receipt: TransactionReceipt = { requestId, state: "unknown", version: attemptedVersion, contentDigest };
		this.notCommitted.delete(requestId);
		this.receipts.set(requestId, receipt);
		return { ...receipt };
	}

	resolveUnknown(
		requestId: string,
		outcome: { committed: { version: number; contentDigest: string; at: number } } | { notCommitted: true },
		now: number,
	): void {
		if (!Number.isFinite(now)) throw new Error("Invalid resolution time");
		const existing = this.receipts.get(requestId);
		if (!existing || existing.state !== "unknown") throw new Error(`No unknown receipt to resolve: ${requestId}`);
		if ("committed" in outcome) {
			if (outcome.committed.contentDigest !== existing.contentDigest) throw new IdempotencyConflict(requestId);
			if (
				!Number.isSafeInteger(outcome.committed.version) ||
				outcome.committed.version < 0 ||
				!Number.isFinite(outcome.committed.at)
			) {
				throw new Error("Invalid committed resolution");
			}
			existing.state = "committed";
			existing.version = outcome.committed.version;
			existing.committedAt = outcome.committed.at;
		} else {
			if (outcome.notCommitted !== true) throw new Error("Invalid not-committed resolution");
			this.receipts.delete(requestId);
			this.notCommitted.add(requestId);
		}
	}

	lookup(requestId: string): TransactionReceipt | undefined {
		const receipt = this.receipts.get(requestId);
		return receipt ? { ...receipt } : undefined;
	}

	exportState(): { receipts: TransactionReceipt[]; notCommitted: string[] } {
		return {
			receipts: [...this.receipts.values()].map((receipt) => ({ ...receipt })),
			notCommitted: [...this.notCommitted],
		};
	}

	restore(snapshot: ReturnType<ReceiptLog["exportState"]>): void {
		if (!snapshot || !Array.isArray(snapshot.receipts) || !Array.isArray(snapshot.notCommitted))
			throw new Error("Invalid receipt log snapshot");
		const restored = new Map<string, TransactionReceipt>();
		for (const receipt of snapshot.receipts) {
			if (
				!receipt.requestId ||
				!receipt.contentDigest ||
				restored.has(receipt.requestId) ||
				!Number.isSafeInteger(receipt.version) ||
				receipt.version < 0 ||
				!["committed", "unknown"].includes(receipt.state) ||
				(receipt.state === "committed" && !Number.isFinite(receipt.committedAt)) ||
				(receipt.committedAt !== undefined && !Number.isFinite(receipt.committedAt))
			)
				throw new Error("Invalid receipt snapshot");
			restored.set(receipt.requestId, { ...receipt });
		}
		const notCommitted = new Set<string>();
		for (const requestId of snapshot.notCommitted) {
			if (typeof requestId !== "string" || !requestId || notCommitted.has(requestId) || restored.has(requestId))
				throw new Error("Invalid not-committed snapshot");
			notCommitted.add(requestId);
		}
		this.receipts.clear();
		for (const [requestId, receipt] of restored) this.receipts.set(requestId, receipt);
		this.notCommitted.clear();
		for (const requestId of notCommitted) this.notCommitted.add(requestId);
	}

	private requireShape(requestId: string, contentDigest: string): void {
		if (!requestId || requestId.length > 200 || !contentDigest) throw new Error("Invalid receipt identity");
	}
}

export interface OutboxEntry {
	entryId: string;
	eventDigest: string;
	/** Plain JSON payload retained for delivery after a process restart. */
	event: unknown;
	createdAt: number;
	attempts: number;
	nextAttemptAt: number;
	state: "pending" | "dispatched" | "failed";
	lastError?: string;
}

export type OutboxOutcome = "dispatched" | "failed-terminal" | { retryAfterMs: number; error: string };

/** At-least-once delivery after the storage lock; consumers deduplicate on eventDigest. */
export class Outbox {
	private readonly entries = new Map<string, OutboxEntry>();
	private readonly retryOptions: { baseRetryMs: number; maxRetryMs: number };
	private sequence = 0;

	constructor(options: { baseRetryMs?: number; maxRetryMs?: number } = {}) {
		if (options.baseRetryMs !== undefined && (!Number.isSafeInteger(options.baseRetryMs) || options.baseRetryMs < 1))
			throw new Error("Invalid outbox retry options");
		if (options.maxRetryMs !== undefined && (!Number.isSafeInteger(options.maxRetryMs) || options.maxRetryMs < 1))
			throw new Error("Invalid outbox retry options");
		this.retryOptions = { baseRetryMs: options.baseRetryMs ?? 1000, maxRetryMs: options.maxRetryMs ?? 60_000 };
	}

	append(event: unknown, now: number): OutboxEntry {
		if (!Number.isFinite(now)) throw new Error("Invalid outbox timestamp");
		const eventDigest = digest(["outbox", event]);
		const payload = structuredClone(event);
		const existing = [...this.entries.values()].find((entry) => entry.eventDigest === eventDigest);
		if (existing) return structuredClone(existing);
		const entry: OutboxEntry = {
			entryId: `o-${++this.sequence}`,
			eventDigest,
			event: payload,
			createdAt: now,
			attempts: 0,
			nextAttemptAt: now,
			state: "pending",
		};
		this.entries.set(entry.entryId, entry);
		return structuredClone(entry);
	}

	/** Read-only claim; completion is separate so dispatch happens outside the transaction. */
	claim(now: number, limit: number): OutboxEntry[] {
		if (!Number.isFinite(now) || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid outbox claim");
		return [...this.entries.values()]
			.filter((entry) => entry.state === "pending" && entry.nextAttemptAt <= now)
			.sort((a, b) => a.createdAt - b.createdAt || a.entryId.localeCompare(b.entryId))
			.slice(0, limit)
			.map((entry) => structuredClone(entry));
	}

	complete(entryId: string, outcome: OutboxOutcome, now: number): void {
		const entry = this.entries.get(entryId);
		if (!entry || !Number.isFinite(now)) throw new Error(`Unknown outbox entry: ${entryId}`);
		entry.attempts++;
		if (outcome === "dispatched") {
			entry.state = "dispatched";
			return;
		}
		if (outcome === "failed-terminal") {
			entry.state = "failed";
			return;
		}
		const delay = Math.min(
			this.retryOptions.maxRetryMs,
			this.retryOptions.baseRetryMs * 2 ** Math.min(entry.attempts, 16),
		);
		entry.nextAttemptAt = now + Math.min(delay, Math.max(1, outcome.retryAfterMs));
		entry.lastError = outcome.error.slice(0, 500);
	}

	get pendingCount(): number {
		return [...this.entries.values()].filter((entry) => entry.state === "pending").length;
	}

	exportState(): { version: 2; sequence: number; entries: OutboxEntry[] } {
		return {
			version: 2,
			sequence: this.sequence,
			entries: [...this.entries.values()].map((entry) => structuredClone(entry)),
		};
	}

	restore(snapshot: ReturnType<Outbox["exportState"]>): void {
		if (
			!snapshot ||
			snapshot.version !== 2 ||
			!Number.isSafeInteger(snapshot.sequence) ||
			snapshot.sequence < 0 ||
			!Array.isArray(snapshot.entries)
		)
			throw new Error("Invalid outbox snapshot");
		const restored = new Map<string, OutboxEntry>();
		for (const entry of snapshot.entries) {
			const sequence = Number(/^o-([1-9][0-9]*)$/.exec(entry.entryId)?.[1]);
			if (
				restored.has(entry.entryId) ||
				!Number.isSafeInteger(sequence) ||
				sequence > snapshot.sequence ||
				entry.eventDigest !== digest(["outbox", entry.event]) ||
				!Number.isSafeInteger(entry.attempts) ||
				entry.attempts < 0 ||
				!Number.isFinite(entry.nextAttemptAt) ||
				!Number.isFinite(entry.createdAt) ||
				!["pending", "dispatched", "failed"].includes(entry.state)
			)
				throw new Error("Invalid outbox entry snapshot");
			restored.set(entry.entryId, structuredClone(entry));
		}
		this.entries.clear();
		for (const [id, entry] of restored) this.entries.set(id, entry);
		this.sequence = snapshot.sequence;
	}
}

export function encodeCursor(sequence: number): string {
	if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Cursors are non-negative integers");
	return `c:${sequence}`;
}

export function decodeCursor(cursor: string): number {
	const match = /^c:([0-9]+)$/.exec(cursor);
	if (!match?.[1]) throw new Error(`Malformed page cursor: ${cursor}`);
	const value = Number(match[1]);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Malformed page cursor: ${cursor}`);
	return value;
}

export interface Page<T> {
	items: T[];
	nextCursor: string | null;
	hasMore: boolean;
}

/** Offset pagination over a deterministically ordered list; the cursor is opaque to callers. */
export function paginate<T>(items: readonly T[], cursor: string | null | undefined, limit: number): Page<T> {
	if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Page limit must be a positive integer");
	const offset = cursor === undefined || cursor === null ? 0 : decodeCursor(cursor);
	if (offset > items.length) throw new Error("Page cursor beyond the end of the result set");
	const slice = items.slice(offset, offset + limit);
	const nextOffset = offset + slice.length;
	return {
		items: structuredClone(slice),
		nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null,
		hasMore: nextOffset < items.length,
	};
}

export interface IncrementalPosition {
	version: number;
	id: string;
}

export function encodeIncrementalCursor(position: IncrementalPosition): string {
	if (
		!Number.isSafeInteger(position.version) ||
		position.version < 0 ||
		typeof position.id !== "string" ||
		!position.id
	)
		throw new Error("Invalid incremental position");
	return `d2:${position.version}:${encodeURIComponent(position.id)}`;
}

export function decodeIncrementalCursor(cursor: string): IncrementalPosition {
	const match = /^d2:([0-9]+):(.+)$/.exec(cursor);
	if (!match?.[1] || !match[2]) throw new Error(`Malformed incremental cursor: ${cursor}`);
	const position = { version: Number(match[1]), id: decodeURIComponent(match[2]) };
	if (encodeIncrementalCursor(position) !== cursor) throw new Error(`Malformed incremental cursor: ${cursor}`);
	return position;
}

/** Numeric starting versions exclude that entire version; page positions resume after (version,id). */
export function incrementalWindow<T extends IncrementalPosition>(
	items: readonly T[],
	since: number | IncrementalPosition,
	limit: number,
): { items: T[]; nextCursor: string | null } {
	const version = typeof since === "number" ? since : since.version;
	if (!Number.isSafeInteger(version) || version < 0 || !Number.isSafeInteger(limit) || limit < 1)
		throw new Error("Invalid incremental window");
	if (typeof since !== "number") encodeIncrementalCursor(since);
	const seen = new Set<string>();
	for (const item of items) {
		const key = encodeIncrementalCursor(item);
		if (seen.has(key)) throw new Error("Duplicate incremental position");
		seen.add(key);
	}
	const fresh = items
		.filter(
			(item) =>
				item.version > version || (typeof since !== "number" && item.version === version && item.id > since.id),
		)
		.sort((a, b) => a.version - b.version || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	const page = fresh.slice(0, limit);
	const last = page[page.length - 1];
	return {
		items: structuredClone(page),
		nextCursor: fresh.length > limit && last ? encodeIncrementalCursor(last) : null,
	};
}

export interface TransactionPlan<S> {
	requestId: string;
	/** Digest over the intended write; identical retries must present the identical digest. */
	contentDigest: string;
	expectedVersion: number | null;
	/** Pure and synchronous; no external calls or I/O inside the storage lock. */
	mutate: (state: S) => S;
	outboxEvents?: unknown[];
}

export interface StoreSnapshot<S> {
	version: 2;
	storeVersion: number;
	state: S;
	receipts: ReturnType<ReceiptLog["exportState"]>;
	outbox: ReturnType<Outbox["exportState"]>;
}

/**
 * persist must commit the full fourth-argument snapshot atomically and synchronously.
 * It sees the candidate outbox via outboxQueue; a thrown persist leaves the prior state intact.
 * An uncertain external commit must be marked unknown and reconciled before further writes.
 */
export class TransactionalStore<S> {
	private state: S;
	private version = 0;
	private readonly persist: (
		state: S,
		version: number,
		receipt: TransactionReceipt,
		snapshot: StoreSnapshot<S>,
	) => void;
	private readonly receipts = new ReceiptLog();
	private readonly outbox = new Outbox();
	private pendingOutbox: Outbox | undefined;
	private busy = false;

	constructor(
		initial: S,
		persist: (state: S, version: number, receipt: TransactionReceipt, snapshot: StoreSnapshot<S>) => void = () => {},
	) {
		this.state = structuredClone(initial);
		this.persist = persist;
	}

	get current(): { version: number; state: S } {
		return { version: this.version, state: structuredClone(this.state) };
	}

	get outboxQueue(): Outbox {
		return this.pendingOutbox ?? this.outbox;
	}

	transact(plan: TransactionPlan<S>): { receipt: TransactionReceipt; version: number; state: S } {
		if (this.busy) throw new Error("Reentrant transaction is not allowed");
		if (!plan.requestId || plan.requestId.length > 200 || !plan.contentDigest)
			throw new Error("Invalid transaction request");
		const replayed = this.receipts.lookup(plan.requestId);
		if (replayed && replayed.contentDigest !== plan.contentDigest) throw new IdempotencyConflict(plan.requestId);
		if (replayed?.state === "committed") return { receipt: replayed, ...this.current };
		if (this.receipts.exportState().receipts.some((receipt) => receipt.state === "unknown")) {
			throw new Error(`Transaction has an unresolved unknown commit; resolve it first: ${plan.requestId}`);
		}
		if (plan.expectedVersion !== null && plan.expectedVersion !== this.version)
			throw new VersionConflict(plan.expectedVersion, this.version);
		this.busy = true;
		try {
			const candidate = structuredClone(plan.mutate(structuredClone(this.state)));
			const nextVersion = this.version + 1;
			const nextReceipts = new ReceiptLog();
			nextReceipts.restore(this.receipts.exportState());
			const receipt = nextReceipts.record(plan.requestId, plan.contentDigest, nextVersion, nextVersion);
			const nextOutbox = new Outbox();
			nextOutbox.restore(this.outbox.exportState());
			for (const event of plan.outboxEvents ?? []) nextOutbox.append(event, nextVersion);
			const snapshot: StoreSnapshot<S> = {
				version: 2,
				storeVersion: nextVersion,
				state: candidate,
				receipts: nextReceipts.exportState(),
				outbox: nextOutbox.exportState(),
			};
			this.pendingOutbox = new Outbox();
			this.pendingOutbox.restore(snapshot.outbox);
			this.persist(structuredClone(candidate), nextVersion, { ...receipt }, structuredClone(snapshot));
			this.receipts.restore(snapshot.receipts);
			this.outbox.restore(snapshot.outbox);
			this.state = candidate;
			this.version = nextVersion;
			return { receipt, ...this.current };
		} finally {
			this.pendingOutbox = undefined;
			this.busy = false;
		}
	}

	markUnknown(requestId: string, contentDigest: string, attemptedVersion: number): TransactionReceipt {
		if (this.busy) throw new Error("Cannot mark unknown during a transaction");
		return this.receipts.markUnknown(requestId, contentDigest, attemptedVersion);
	}

	/** Complete snapshots must come from authoritative storage, never model-supplied receipt metadata. */
	resolveUnknown(
		requestId: string,
		outcome:
			| { committed: { version: number; contentDigest: string; at: number; snapshot: StoreSnapshot<S> } }
			| { notCommitted: true },
	): void {
		if (this.busy) throw new Error("Cannot resolve during a transaction");
		const existing = this.receipts.lookup(requestId);
		if (!existing || existing.state !== "unknown") throw new Error(`No unknown receipt to resolve: ${requestId}`);
		if (!("committed" in outcome)) {
			this.receipts.resolveUnknown(requestId, outcome, Date.now());
			return;
		}
		const committed = outcome.committed;
		if (!committed.snapshot) throw new Error("Committed recovery requires a complete authoritative snapshot");
		if (committed.contentDigest !== existing.contentDigest) throw new IdempotencyConflict(requestId);
		const recovered = new TransactionalStore(this.state);
		recovered.restore(committed.snapshot);
		const receipt = recovered.receipts.lookup(requestId);
		if (
			!receipt ||
			receipt.state !== "committed" ||
			receipt.version !== committed.version ||
			receipt.contentDigest !== committed.contentDigest ||
			receipt.committedAt !== committed.at ||
			receipt.version !== existing.version ||
			recovered.version < this.version
		)
			throw new Error("Recovery snapshot does not match the unknown commit");
		for (const prior of this.receipts.exportState().receipts) {
			if (prior.requestId === requestId) continue;
			const restored = recovered.receipts.lookup(prior.requestId);
			if (!restored || digest(restored) !== digest(prior))
				throw new Error("Recovery snapshot loses existing receipts");
		}
		this.restore(recovered.exportState());
	}

	exportState(): StoreSnapshot<S> {
		return {
			version: 2,
			storeVersion: this.version,
			state: structuredClone(this.state),
			receipts: this.receipts.exportState(),
			outbox: this.outbox.exportState(),
		};
	}

	restore(snapshot: StoreSnapshot<S>): void {
		if (this.busy) throw new Error("Cannot restore during a transaction");
		if (
			!snapshot ||
			snapshot.version !== 2 ||
			!Object.hasOwn(snapshot, "state") ||
			!Number.isSafeInteger(snapshot.storeVersion) ||
			snapshot.storeVersion < 0
		)
			throw new Error("Invalid store snapshot");
		const state = structuredClone(snapshot.state);
		const receipts = new ReceiptLog();
		receipts.restore(snapshot.receipts);
		if (
			receipts
				.exportState()
				.receipts.some((receipt) => receipt.state === "committed" && receipt.version > snapshot.storeVersion)
		) {
			throw new Error("Store snapshot is older than its committed receipts");
		}
		const outbox = new Outbox();
		outbox.restore(snapshot.outbox);
		this.receipts.restore(receipts.exportState());
		this.outbox.restore(outbox.exportState());
		this.state = state;
		this.version = snapshot.storeVersion;
	}
}
