import type { TargetBilling } from "../routing.ts";
import type { StateStore } from "./store.ts";

/**
 * Unified request service kernel: reserve, execute, settle.
 * Every real provider attempt — main execution, health probes, routing classifiers
 * and auxiliary calls — goes through the same ledger. Unknown usage stays
 * explicitly unknown; it is never written as zero.
 */
export interface UsageQuad { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; }
export type UsagePurpose = "main" | "probe" | "classify" | "auxiliary";
export interface MeteredTarget { id: string; provider: string; model: string; }
export interface UsageRecord {
	/** Stable physical receipt identity; replays of the same id settle exactly once. */
	requestId: string;
	/** Stable logical call identity; repeated reserves of one intent admit exactly once. */
	intent: string;
	purpose: UsagePurpose;
	target: MeteredTarget;
	startedAt: number;
	finishedAt: number;
	outcome: "success" | "failure";
	/** Absent when the provider did not report usage; that is unknown, not zero. */
	usage?: UsageQuad;
	costUsd?: number;
}
export interface UsageLedgerState {
	limit: number;
	used: number;
	intents: Record<string, number>;
	settled: Record<string, number>;
	records: UsageRecord[];
	unknownUsage: number;
}
export class ModelBudgetExhausted extends Error {
	constructor() { super("Model request budget exhausted"); this.name = "ModelBudgetExhausted"; }
}

/** Cost from explicit billing only; without billing parameters the cost stays unknown. */
export function estimateCostUsd(billing: TargetBilling, usage: UsageQuad): number {
	return (usage.inputTokens * billing.inputPerMt + usage.outputTokens * billing.outputPerMt +
		usage.cacheReadTokens * billing.cacheReadPerMt + usage.cacheWriteTokens * billing.cacheWritePerMt) / 1e6;
}

function initialGuard(state: UsageLedgerState): void {
	if (!Number.isSafeInteger(state.limit) || state.limit < 1 || !Number.isSafeInteger(state.used) || state.used < 0 ||
		typeof state.intents !== "object" || state.intents === null || typeof state.settled !== "object" || state.settled === null ||
		!Array.isArray(state.records) || !Number.isSafeInteger(state.unknownUsage) || state.unknownUsage < 0) throw new Error("Invalid usage ledger state");
}
/** JSON object key order is insertion order, so pruning deletes the oldest identities deterministically. */
function prune(map: Record<string, number>, cap: number): void {
	const keys = Object.keys(map);
	if (keys.length <= cap) return;
	for (const key of keys.slice(0, keys.length - Math.floor(cap / 2))) delete map[key];
}
function validateQuad(usage: UsageQuad): void {
	for (const value of [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens]) {
		if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid usage measurement");
	}
}

export class ModelUsageService {
	private readonly store: StateStore<UsageLedgerState>;
	private readonly recordLimit: number;
	private readonly identityLimit: number;
	/** The store's initial state carries the shared limit, matching the StateStore ownership model. */
	constructor(store: StateStore<UsageLedgerState>, options: { recordLimit?: number; identityLimit?: number } = {}) {
		this.store = store;
		this.recordLimit = options.recordLimit ?? 1000;
		this.identityLimit = options.identityLimit ?? 10000;
		if (!Number.isSafeInteger(this.recordLimit) || this.recordLimit < 1 ||
			!Number.isSafeInteger(this.identityLimit) || this.identityLimit < 2) throw new Error("Invalid usage ledger options");
	}
	/** Admission control. The same logical intent never consumes capacity twice. */
	async reserve(intent: string, count = 1): Promise<void> {
		if (!intent || !Number.isSafeInteger(count) || count < 1) throw new Error("Invalid request reservation");
		await this.store.update((state) => {
			initialGuard(state);
			if (state.intents[intent] !== undefined) {
				if (state.intents[intent] !== count) throw new Error("Budget intent changed");
				return;
			}
			if (state.used + count > state.limit) throw new ModelBudgetExhausted();
			state.used += count;
			state.intents[intent] = count;
			prune(state.intents, this.identityLimit);
		});
	}
	/** Post-attempt settlement; idempotent per requestId. Usage may be unknown. */
	async settle(record: UsageRecord): Promise<boolean> {
		if (!record.requestId || !record.intent || !record.target.id ||
			!["main", "probe", "classify", "auxiliary"].includes(record.purpose) ||
			!["success", "failure"].includes(record.outcome) ||
			!Number.isFinite(record.startedAt) || !Number.isFinite(record.finishedAt)) throw new Error("Invalid usage settlement");
		if (record.usage) validateQuad(record.usage);
		if (record.costUsd !== undefined && (!Number.isFinite(record.costUsd) || record.costUsd < 0)) throw new Error("Invalid usage cost");
		return this.store.update((state) => {
			initialGuard(state);
			if (state.settled[record.requestId] !== undefined) return false;
			state.settled[record.requestId] = 1;
			prune(state.settled, this.identityLimit);
			state.records.push(structuredClone(record));
			if (state.records.length > this.recordLimit) state.records.splice(0, state.records.length - this.recordLimit);
			if (record.usage === undefined) state.unknownUsage++;
			return true;
		});
	}
	async totals(): Promise<{ limit: number; used: number; unknownUsage: number; records: number; byPurpose: Record<UsagePurpose, number> }> {
		const state = await this.store.read();
		initialGuard(state);
		const byPurpose: Record<UsagePurpose, number> = { main: 0, probe: 0, classify: 0, auxiliary: 0 };
		for (const record of state.records) byPurpose[record.purpose]++;
		return { limit: state.limit, used: state.used, unknownUsage: state.unknownUsage, records: state.records.length, byPurpose };
	}
}
