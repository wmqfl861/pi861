import { digest } from "./hash.ts";

/**
 * C4 storage contract: requestId idempotency, expected-version compare-and-set, transaction
 * receipts with an explicit commit-unknown state, a transactional outbox, and pagination /
 * incremental cursors. The transaction body must be a pure synchronous function: awaiting
 * external systems (model calls, HTTP, subprocesses) while holding a storage lock violates the
 * contract; external work belongs after the commit, driven by the outbox.
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

/**
 * Idempotent receipt log. A replayed requestId with identical content returns the original
 * receipt without re-executing anything; the same requestId with different content is a
 * conflict. "unknown" receipts are provisional outcomes of interrupted commits and are resolved
 * exactly once through resolveUnknown().
 */
export class ReceiptLog {
	private readonly receipts = new Map<string, TransactionReceipt>();
	private readonly notCommitted = new Set<string>();

	record(requestId: string, contentDigest: string, version: number, now: number): TransactionReceipt {
		this.requireShape(requestId, contentDigest);
		const existing = this.receipts.get(requestId);
		if (existing) {
			if (existing.contentDigest !== contentDigest) throw new IdempotencyConflict(requestId);
			if (existing.state === "committed") return { ...existing };
			const resolved = { ...existing, state: "committed" as const, version, committedAt: now };
			this.receipts.set(requestId, resolved);
			return { ...resolved };
		}
		if (this.notCommitted.has(requestId)) this.notCommitted.delete(requestId);
		const receipt: TransactionReceipt = { requestId, state: "committed", version, contentDigest, committedAt: now };
		this.receipts.set(requestId, receipt);
		return { ...receipt };
	}

	markUnknown(requestId: string, contentDigest: string, attemptedVersion: number): TransactionReceipt {
		this.requireShape(requestId, contentDigest);
		const existing = this.receipts.get(requestId);
		if (existing) {
			if (existing.contentDigest !== contentDigest) throw new IdempotencyConflict(requestId);
			return { ...existing };
		}
		const receipt: TransactionReceipt = { requestId, state: "unknown", version: attemptedVersion, contentDigest };
		this.receipts.set(requestId, receipt);
		return { ...receipt };
	}

	/** Trusted recovery path: decides the truth about an interrupted commit, exactly once. */
	resolveUnknown(requestId: string, outcome: { committed: { version: number; contentDigest: string; at: number } } | { notCommitted: true }, now: number): void {
		const existing = this.receipts.get(requestId);
		if (!existing || existing.state !== "unknown") throw new Error(`No unknown receipt to resolve: ${requestId}`);
		if ("committed" in outcome) {
			if (outcome.committed.contentDigest !== existing.contentDigest) throw new IdempotencyConflict(requestId);
			existing.state = "committed";
			existing.version = outcome.committed.version;
			existing.committedAt = outcome.committed.at;
		} else {
			this.receipts.delete(requestId);
			this.notCommitted.add(requestId);
		}
		if (!Number.isFinite(now)) throw new Error("Invalid resolution time");
	}

	lookup(requestId: string): TransactionReceipt | undefined {
		const receipt = this.receipts.get(requestId);
		return receipt ? { ...receipt } : undefined;
	}

	exportState(): { receipts: TransactionReceipt[]; notCommitted: string[] } {
		return { receipts: [...this.receipts.values()].map((receipt) => ({ ...receipt })), notCommitted: [...this.notCommitted] };
	}

	restore(snapshot: { receipts: TransactionReceipt[]; notCommitted: string[] }): void {
		if (!Array.isArray(snapshot.receipts) || !Array.isArray(snapshot.notCommitted)) throw new Error("Invalid receipt log snapshot");
		const restored = new Map<string, TransactionReceipt>();
		for (const receipt of snapshot.receipts) {
			if (!receipt.requestId || !receipt.contentDigest || restored.has(receipt.requestId) ||
				!Number.isSafeInteger(receipt.version) || receipt.version < 0 ||
				!["committed", "unknown"].includes(receipt.state) ||
				(receipt.committedAt !== undefined && !Number.isFinite(receipt.committedAt))) throw new Error("Invalid receipt snapshot");
			restored.set(receipt.requestId, { ...receipt });
		}
		this.receipts.clear();
		for (const [requestId, receipt] of restored) this.receipts.set(requestId, receipt);
		this.notCommitted.clear();
		for (const requestId of snapshot.notCommitted) {
			if (!requestId || this.notCommitted.has(requestId)) throw new Error("Invalid not-committed snapshot");
			this.notCommitted.add(requestId);
		}
	}

	private requireShape(requestId: string, contentDigest: string): void {
		if (!requestId || requestId.length > 200 || !contentDigest) throw new Error("Invalid receipt identity");
	}
}

export interface OutboxEntry {
	entryId: string;
	eventDigest: string;
	createdAt: number;
	attempts: number;
	nextAttemptAt: number;
	state: "pending" | "dispatched" | "failed";
	lastError?: string;
}

export type OutboxOutcome = "dispatched" | "failed-terminal" | { retryAfterMs: number; error: string };

/**
 * Transactional outbox. Entries are appended in the same transaction as the state change and
 * dispatched afterwards, outside any storage lock. Delivery is at-least-once; consumers must
 * deduplicate on eventDigest.
 */
export class Outbox {
	private readonly entries = new Map<string, OutboxEntry>();
	private readonly retryOptions: { baseRetryMs: number; maxRetryMs: number };
	private sequence = 0;

	constructor(options: { baseRetryMs?: number; maxRetryMs?: number } = {}) {
		if (options.baseRetryMs !== undefined && (!Number.isSafeInteger(options.baseRetryMs) || options.baseRetryMs < 1)) {
			throw new Error("Invalid outbox retry options");
		}
		if (options.maxRetryMs !== undefined && (!Number.isSafeInteger(options.maxRetryMs) || options.maxRetryMs < 1)) {
			throw new Error("Invalid outbox retry options");
		}
		this.retryOptions = { baseRetryMs: options.baseRetryMs ?? 1000, maxRetryMs: options.maxRetryMs ?? 60_000 };
	}

	append(event: unknown, now: number): OutboxEntry {
		if (!Number.isFinite(now)) throw new Error("Invalid outbox timestamp");
		const eventDigest = digest(["outbox", event]);
		const existing = [...this.entries.values()].find((entry) => entry.eventDigest === eventDigest);
		if (existing) return { ...existing };
		const entry: OutboxEntry = {
			entryId: `o-${++this.sequence}`, eventDigest, createdAt: now,
			attempts: 0, nextAttemptAt: now, state: "pending",
		};
		this.entries.set(entry.entryId, entry);
		return { ...entry };
	}

	/** Read-only claim; completion is reported separately so dispatch happens without a lock. */
	claim(now: number, limit: number): OutboxEntry[] {
		if (!Number.isFinite(now) || !Number.isSafeInteger(limit) || limit < 1) throw new Error("Invalid outbox claim");
		return [...this.entries.values()].filter((entry) => entry.state === "pending" && entry.nextAttemptAt <= now)
			.sort((a, b) => a.createdAt - b.createdAt || a.entryId.localeCompare(b.entryId))
			.slice(0, limit).map((entry) => ({ ...entry }));
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
		const base = this.retryOptions.baseRetryMs;
		const max = this.retryOptions.maxRetryMs;
		const delay = Math.min(max, base * 2 ** Math.min(entry.attempts, 16));
		entry.nextAttemptAt = now + Math.min(delay, Math.max(1, outcome.retryAfterMs));
		entry.lastError = outcome.error.slice(0, 500);
	}

	get pendingCount(): number {
		return [...this.entries.values()].filter((entry) => entry.state === "pending").length;
	}

	exportState(): { version: 1; sequence: number; entries: OutboxEntry[] } {
		return { version: 1, sequence: this.sequence, entries: [...this.entries.values()].map((entry) => ({ ...entry })) };
	}

	restore(snapshot: { version: 1; sequence: number; entries: OutboxEntry[] }): void {
		if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0 ||
			!Array.isArray(snapshot.entries)) throw new Error("Invalid outbox snapshot");
		this.entries.clear();
		for (const entry of snapshot.entries) {
			if (this.entries.has(entry.entryId) || !entry.eventDigest ||
				!Number.isSafeInteger(entry.attempts) || entry.attempts < 0 ||
				!Number.isFinite(entry.nextAttemptAt) || !Number.isFinite(entry.createdAt) ||
				!["pending", "dispatched", "failed"].includes(entry.state)) throw new Error("Invalid outbox entry snapshot");
			this.entries.set(entry.entryId, { ...entry });
		}
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
	return { items: structuredClone(slice), nextCursor: nextOffset < items.length ? encodeCursor(nextOffset) : null, hasMore: nextOffset < items.length };
}

export function encodeIncrementalCursor(sinceVersion: number): string {
	if (!Number.isSafeInteger(sinceVersion) || sinceVersion < 0) throw new Error("Incremental cursors are non-negative integers");
	return `d:${sinceVersion}`;
}

export function decodeIncrementalCursor(cursor: string): number {
	const match = /^d:([0-9]+)$/.exec(cursor);
	if (!match?.[1]) throw new Error(`Malformed incremental cursor: ${cursor}`);
	const value = Number(match[1]);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Malformed incremental cursor: ${cursor}`);
	return value;
}

/** Version-ordered incremental window: strictly newer than sinceVersion, ascending, bounded. */
export function incrementalWindow<T extends { version: number }>(items: readonly T[], sinceVersion: number, limit: number): { items: T[]; nextCursor: string | null } {
	if (!Number.isSafeInteger(sinceVersion) || sinceVersion < 0 || !Number.isSafeInteger(limit) || limit < 1) {
		throw new Error("Invalid incremental window");
	}
	const fresh = items.filter((item) => item.version > sinceVersion).sort((a, b) => a.version - b.version).slice(0, limit);
	const last = fresh[fresh.length - 1];
	return { items: structuredClone(fresh), nextCursor: fresh.length === limit && last ? encodeIncrementalCursor(last.version) : null };
}

export interface TransactionPlan<S> {
	requestId: string;
	/** Digest over the intended write payload; an identical retry must present the identical digest. */
	contentDigest: string;
	expectedVersion: number | null;
	/** Pure and synchronous. Performing I/O or external calls here violates the storage-lock contract. */
	mutate: (state: S) => S;
	outboxEvents?: unknown[];
}

/**
 * Single-writer transactional store with version CAS, idempotent replay and an atomic outbox
 * append. persist() must commit durably before returning; the receipt is recorded and the
 * in-memory state swapped only after persist succeeds, so a failed persist leaves no trace that
 * could later masquerade as a committed receipt.
 */
export class TransactionalStore<S> {
	private state: S;
	private version = 0;
	private readonly persist: (state: S, version: number, receipt: TransactionReceipt) => void;
	private readonly receipts = new ReceiptLog();
	private readonly outbox = new Outbox();

	constructor(initial: S, persist:
		(state: S, version: number, receipt: TransactionReceipt) => void = () => {}) {
		this.state = structuredClone(initial);
		this.persist = persist;
	}

	get current(): { version: number; state: S } {
		return { version: this.version, state: structuredClone(this.state) };
	}

	get outboxQueue(): Outbox { return this.outbox; }

	transact(plan: TransactionPlan<S>): { receipt: TransactionReceipt; version: number; state: S } {
		if (!plan.requestId || plan.requestId.length > 200 || !plan.contentDigest) throw new Error("Invalid transaction request");
		const replayed = this.receipts.lookup(plan.requestId);
		if (replayed?.state === "committed") {
			if (replayed.contentDigest !== plan.contentDigest) throw new IdempotencyConflict(plan.requestId);
			return { receipt: { ...replayed }, version: this.version, state: structuredClone(this.state) };
		}
		if (replayed?.state === "unknown") {
			throw new Error(`Transaction has an unresolved unknown commit; resolve it first: ${plan.requestId}`);
		}
		if (plan.expectedVersion !== null && plan.expectedVersion !== this.version) {
			throw new VersionConflict(plan.expectedVersion, this.version);
		}
		const candidate = plan.mutate(structuredClone(this.state));
		const nextVersion = this.version + 1;
		const receipt: TransactionReceipt = { requestId: plan.requestId, state: "committed", version: nextVersion,
			contentDigest: plan.contentDigest, committedAt: nextVersion };
		this.persist(candidate, nextVersion, receipt);
		this.receipts.record(plan.requestId, plan.contentDigest, nextVersion, nextVersion);
		for (const event of plan.outboxEvents ?? []) this.outbox.append(event, nextVersion);
		this.state = candidate;
		this.version = nextVersion;
		return { receipt: { ...receipt }, version: nextVersion, state: structuredClone(this.state) };
	}

	/** Marks a commit whose durable outcome is unknown (crash between write and acknowledgement). */
	markUnknown(requestId: string, contentDigest: string, attemptedVersion: number): TransactionReceipt {
		return this.receipts.markUnknown(requestId, contentDigest, attemptedVersion);
	}

	resolveUnknown(requestId: string, outcome: { committed: { version: number; contentDigest: string; at: number } } | { notCommitted: true }): void {
		this.receipts.resolveUnknown(requestId, outcome, Date.now());
	}

	exportState(): { version: 1; storeVersion: number; state: S; receipts: ReturnType<ReceiptLog["exportState"]>; outbox: ReturnType<Outbox["exportState"]> } {
		return {
			version: 1, storeVersion: this.version, state: structuredClone(this.state),
			receipts: this.receipts.exportState(), outbox: this.outbox.exportState(),
		};
	}

	restore(snapshot: ReturnType<TransactionalStore<S>["exportState"]>): void {
		if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.storeVersion) || snapshot.storeVersion < 0) {
			throw new Error("Invalid store snapshot");
		}
		this.state = structuredClone(snapshot.state);
		this.version = snapshot.storeVersion;
		this.receipts.restore(snapshot.receipts);
		this.outbox.restore(snapshot.outbox);
	}
}
