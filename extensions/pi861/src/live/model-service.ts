import { randomUUID } from "node:crypto";
import { digest } from "../memory.ts";
import {
	BudgetExhausted,
	type BudgetLimits,
	type MeteredKind,
	type UsageMeasure,
	TaskTreeBudget,
} from "../contracts/budget.ts";
import {
	type Attempt,
	inferWithRecovery,
	ModelFailure,
	ModelRecovery,
	type ModelTarget,
	type TargetBilling,
} from "../routing.ts";
import type { AuxiliaryAttemptBoundary } from "./auxiliary-models.ts";
import { abortable } from "./deadline.ts";
import type { ModelPolicy } from "./model-runtime.ts";
import type { StateStore } from "./store.ts";

export interface UsageQuad {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}
/** Missing fields are unknown, including on an interrupted response. */
export interface UsageMeasurement extends Partial<UsageQuad> {
	costUsd?: number;
}
export type UsagePurpose = MeteredKind;
export interface MeteredTarget {
	id: string;
	provider: string;
	model: string;
	revision?: string;
	/** Optional pricing used to compute cost when the provider did not report one. */
	billing?: TargetBilling;
}
export interface UsageRecord {
	requestId: string;
	purpose: UsagePurpose;
	target: MeteredTarget;
	startedAt: number;
	finishedAt: number;
	outcome: "success" | "failure";
	usage?: Partial<UsageQuad>;
	costUsd?: number;
	/** C3 reservation this attempt was admitted and settled against. */
	reservationId: string;
	/** True when usage or cost was incomplete and a conservative booking was applied. */
	settledUnknown: boolean;
}
export interface ModelAdmission {
	reservationId: string;
	/** true means newly admitted; false confirms an existing admission, never authority to execute again. */
	admitted: boolean;
}
/**
 * "budgeted": this service books the C3 reservation itself (execution, probe, direct transport).
 * "record-only": the consumer books its own C3 reservation (P1-S AuxiliaryModelInvocations) and
 * this ledger only keeps the durable per-request record, so one physical request books exactly
 * one C3 attempt in total.
 */
export type AdmissionMode = "budgeted" | "record-only";
export interface ModelLedgerState {
	version: 1;
	/** C3 budget snapshot persisted beside the receipts so both restore together. */
	budget: ReturnType<TaskTreeBudget["exportState"]> | null;
	/** requestId -> receipt hash; identical replays confirm, changed bytes fail. */
	receipts: Record<string, string>;
	/** requestId -> admission; settled admissions never admit again. */
	admissions: Record<
		string,
		{ reservationId: string; purpose: UsagePurpose; probeKey?: string; settled: boolean; booked: boolean }
	>;
	records: UsageRecord[];
	unknownUsage: number;
	byPurpose: Record<UsagePurpose, number>;
}
export interface ModelUsageOptions {
	/** Conservative booking applied via C3 settleUnknown; never zero (C3 rejects zero). */
	unknownEstimate: UsageMeasure;
	/** Default pre-dispatch estimate for C3 reserve. */
	estimate: UsageMeasure;
	/** Shared tree budget; when omitted a fresh one is created from rootLimits/budgetId. */
	budget?: TaskTreeBudget;
	rootLimits?: BudgetLimits;
	budgetId?: string;
	recordLimit?: number;
	identityLimit?: number;
}
export class ModelBudgetExhausted extends Error {
	constructor() {
		super("Model request budget exhausted");
		this.name = "ModelBudgetExhausted";
	}
}
export class ModelAccountingError extends Error {
	constructor(cause: unknown) {
		super("Model usage settlement unavailable; reconcile before continuing", { cause });
		this.name = "ModelAccountingError";
	}
}
export function estimateCostUsd(billing: TargetBilling, usage: UsageQuad): number {
	return (
		(usage.inputTokens * billing.inputPerMt +
			usage.outputTokens * billing.outputPerMt +
			usage.cacheReadTokens * billing.cacheReadPerMt +
			usage.cacheWriteTokens * billing.cacheWritePerMt) /
		1e6
	);
}
const PURPOSES: readonly UsagePurpose[] = [
	"execution",
	"reception",
	"planning",
	"skill-compile",
	"distill",
	"probe",
	"auxiliary",
];
export function emptyUsageLedger(): ModelLedgerState {
	return {
		version: 1,
		budget: null,
		receipts: {},
		admissions: {},
		records: [],
		unknownUsage: 0,
		byPurpose: Object.fromEntries(PURPOSES.map((purpose) => [purpose, 0])) as Record<UsagePurpose, number>,
	};
}
function guard(state: ModelLedgerState): void {
	if (
		state.version !== 1 ||
		typeof state.receipts !== "object" ||
		state.receipts === null ||
		typeof state.admissions !== "object" ||
		state.admissions === null ||
		!Array.isArray(state.records) ||
		!Number.isSafeInteger(state.unknownUsage) ||
		state.unknownUsage < 0 ||
		typeof state.byPurpose !== "object" ||
		state.byPurpose === null
	)
		throw new Error("Invalid model usage ledger state");
}
function validateIdentity(value: string): void {
	if (
		typeof value !== "string" ||
		!value ||
		value.length > 1000 ||
		["__proto__", "constructor", "prototype"].includes(value)
	)
		throw new Error("Invalid request identity");
}
function completeTokens(usage: Partial<UsageQuad> | undefined): usage is UsageQuad {
	return (
		usage !== undefined &&
		[usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].every(
			(value) => value !== undefined,
		)
	);
}
function validateMeasure(estimate: UsageMeasure): void {
	for (const value of [
		estimate.inputTokens,
		estimate.outputTokens,
		estimate.cacheReadTokens,
		estimate.cacheWriteTokens,
		estimate.costUsd,
	]) {
		if (!Number.isFinite(value) || value < 0) throw new Error("Invalid usage measure");
	}
}
function isZeroMeasure(estimate: UsageMeasure): boolean {
	return (
		estimate.inputTokens === 0 &&
		estimate.outputTokens === 0 &&
		estimate.cacheReadTokens === 0 &&
		estimate.cacheWriteTokens === 0 &&
		estimate.costUsd === 0
	);
}

/**
 * C3-backed admission and settlement: every physical model attempt - execution,
 * reception, planning, skill compilation, distillation, probes and auxiliary calls -
 * is reserved on one TaskTreeBudget before dispatch and settled after. Incomplete
 * usage or unknown cost settles unknown with a bounded conservative booking, never
 * as zero. Durable receipts keep replay idempotent; the budget snapshot restores
 * with them so capacity accounting survives a restart. Durable cross-process
 * atomicity is P2-D's delivery; this service serializes through its StateStore.
 */
export class ModelUsageService {
	private readonly store: StateStore<ModelLedgerState>;
	private readonly budgetValue: TaskTreeBudget;
	private readonly recordLimit: number;
	private readonly identityLimit: number;
	private readonly unknownEstimate: UsageMeasure;
	private readonly defaultEstimate: UsageMeasure;
	private recordSequence = 0;
	private synced = false;
	constructor(store: StateStore<ModelLedgerState>, options: ModelUsageOptions) {
		validateMeasure(options.unknownEstimate);
		validateMeasure(options.estimate);
		if (isZeroMeasure(options.unknownEstimate)) throw new Error("Unknown usage estimate cannot be zero");
		this.store = store;
		this.recordLimit = options.recordLimit ?? 1000;
		this.identityLimit = options.identityLimit ?? 10000;
		if (
			!Number.isSafeInteger(this.recordLimit) ||
			this.recordLimit < 1 ||
			!Number.isSafeInteger(this.identityLimit) ||
			this.identityLimit < 2
		)
			throw new Error("Invalid usage ledger options");
		this.unknownEstimate = { ...options.unknownEstimate };
		this.defaultEstimate = { ...options.estimate };
		this.budgetValue =
			options.budget ??
			new TaskTreeBudget(
				options.rootLimits ?? {
					maxTotalCostUsd: Number.MAX_SAFE_INTEGER,
					maxAttempts: Number.MAX_SAFE_INTEGER,
					maxInputTokens: Number.MAX_SAFE_INTEGER,
					maxOutputTokens: Number.MAX_SAFE_INTEGER,
				},
				options.budgetId !== undefined ? { budgetId: options.budgetId } : {},
			);
	}
	get budget(): TaskTreeBudget {
		return this.budgetValue;
	}
	get budgetId(): string {
		return this.budgetValue.budgetId;
	}
	/** Restores the in-memory budget from the persisted snapshot exactly once per process. */
	private syncBudget(state: ModelLedgerState): void {
		if (this.synced) return;
		if (state.budget !== null) {
			if (state.budget.budgetId !== this.budgetValue.budgetId)
				throw new Error("Usage ledger belongs to a different budget");
			this.budgetValue.restore(state.budget);
		}
		// Record-only reservation ids continue after the highest persisted one.
		for (const admission of Object.values(state.admissions)) {
			const match = /^a-([1-9][0-9]*)$/.exec(admission.reservationId);
			if (match) this.recordSequence = Math.max(this.recordSequence, Number(match[1]));
		}
		this.synced = true;
	}
	/**
	 * Throws ProbeInFlight when a probe with the same key is still open (C3 single-flight:
	 * one physical probe bills exactly once - join the in-flight reservation instead) and
	 * ModelBudgetExhausted when the tree budget would cross a limit.
	 */
	async reserve(
		requestId: string,
		purpose: UsagePurpose,
		admission: { estimate?: UsageMeasure; probeKey?: string; taskId?: string | null } = {},
		mode: AdmissionMode = "budgeted",
	): Promise<ModelAdmission> {
		validateIdentity(requestId);
		if (!PURPOSES.includes(purpose)) throw new Error("Invalid metered purpose");
		if (admission.estimate !== undefined) validateMeasure(admission.estimate);
		if (admission.taskId !== undefined && admission.taskId !== null && typeof admission.taskId !== "string")
			throw new Error("Invalid budget task attribution");
		const estimate = admission.estimate ?? this.defaultEstimate;
		try {
			return await this.store.update((state) => {
				guard(state);
				this.syncBudget(state);
				const existing = state.admissions[requestId];
				if (existing !== undefined) {
					if (existing.purpose !== purpose || existing.probeKey !== admission.probeKey)
						throw new Error("Budget intent changed");
					return { reservationId: existing.reservationId, admitted: false };
				}
				if (Object.keys(state.admissions).length >= this.identityLimit)
					throw new Error("Usage identity capacity exhausted; archive the ledger before new work");
				let reservationId: string;
				if (mode === "record-only") {
					reservationId = `a-${++this.recordSequence}`;
				} else {
					const reservation = this.budgetValue.reserve(
						admission.taskId ?? null,
						purpose,
						estimate,
						Date.now(),
						admission.probeKey !== undefined ? { probeKey: admission.probeKey } : {},
					);
					reservationId = reservation.reservationId;
					state.budget = this.budgetValue.exportState();
				}
				state.admissions[requestId] = {
					reservationId,
					purpose,
					...(admission.probeKey !== undefined ? { probeKey: admission.probeKey } : {}),
					settled: false,
					booked: mode === "budgeted",
				};
				return { reservationId, admitted: true };
			});
		} catch (error) {
			if (error instanceof BudgetExhausted) throw new ModelBudgetExhausted();
			throw error;
		}
	}
	/** settledUnknown is derived here: complete usage plus known cost settles known, everything else books the conservative unknown. */
	async settle(record: Omit<UsageRecord, "settledUnknown">): Promise<boolean> {
		validateIdentity(record.requestId);
		if (
			!record.target.id ||
			!record.target.provider ||
			!record.target.model ||
			!PURPOSES.includes(record.purpose) ||
			!["success", "failure"].includes(record.outcome) ||
			!Number.isFinite(record.startedAt) ||
			!Number.isFinite(record.finishedAt) ||
			record.finishedAt < record.startedAt
		)
			throw new Error("Invalid usage settlement");
		if (record.usage)
			for (const value of Object.values(record.usage)) {
				if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
					throw new Error("Invalid usage measurement");
			}
		if (record.costUsd !== undefined && (!Number.isFinite(record.costUsd) || record.costUsd < 0))
			throw new Error("Invalid usage cost");
		const hash = digest([
			record.requestId,
			record.purpose,
			[record.target.id, record.target.provider, record.target.model, record.target.revision ?? null],
			record.startedAt,
			record.finishedAt,
			record.outcome,
			record.usage
				? [
						record.usage.inputTokens ?? null,
						record.usage.outputTokens ?? null,
						record.usage.cacheReadTokens ?? null,
						record.usage.cacheWriteTokens ?? null,
					]
				: null,
			record.costUsd ?? null,
			record.reservationId,
		]);
		return this.store.update((state) => {
			guard(state);
			this.syncBudget(state);
			const admission = state.admissions[record.requestId];
			if (!admission || admission.reservationId !== record.reservationId)
				throw new Error("Usage settlement requires an admission");
			if (admission.settled) {
				if (state.receipts[record.requestId] !== hash) throw new Error("Usage receipt changed");
				return false;
			}
			const tokens = record.usage;
			// Cost is unknown until it is reported or computable from explicit billing;
			// an unknown cost settles unknown, it is never booked as zero.
			const cost =
				record.costUsd ??
				(record.target.billing && completeTokens(tokens) && tokens !== undefined
					? estimateCostUsd(record.target.billing, tokens)
					: undefined);
			const known = completeTokens(tokens) && cost !== undefined;
			if (admission.booked) {
				if (known && tokens !== undefined) {
					this.budgetValue.settle(record.reservationId, { ...tokens, costUsd: cost });
				} else {
					this.budgetValue.settleUnknown(record.reservationId, this.unknownEstimate);
				}
			}
			state.admissions[record.requestId] = { ...admission, settled: true };
			state.receipts[record.requestId] = hash;
			state.byPurpose[record.purpose]++;
			state.records.push({ ...structuredClone(record), settledUnknown: !known });
			if (state.records.length > this.recordLimit) state.records.splice(0, state.records.length - this.recordLimit);
			if (!known) state.unknownUsage++;
			state.budget = this.budgetValue.exportState();
			return true;
		});
	}
	async totals(): Promise<{
		budgetId: string;
		attempts: number;
		usage: UsageMeasure;
		unknownSettlements: number;
		unknownUsage: number;
		records: number;
		unsettled: number;
		byPurpose: Record<UsagePurpose, number>;
	}> {
		const state = await this.store.read();
		guard(state);
		this.syncBudget(state);
		const tree = this.budgetValue.usage;
		const unsettled = Object.values(state.admissions).filter((admission) => !admission.settled).length;
		return {
			budgetId: this.budgetValue.budgetId,
			attempts: tree.attempts,
			usage: tree.usage,
			unknownSettlements: tree.unknownSettlements,
			unknownUsage: state.unknownUsage,
			records: state.records.length,
			unsettled,
			byPurpose: { ...state.byPurpose },
		};
	}
}

export interface ModelAttemptRequest {
	requestId: string;
	purpose: UsagePurpose;
	target: ModelTarget;
	signal: AbortSignal;
	/** Single-flight key for physical probes (C3): one probe bills exactly once. */
	probeKey?: string;
	estimate?: UsageMeasure;
}
export interface ModelServiceRequest {
	/** One new identity per logical call; retries derive distinct physical attempt IDs. */
	requestId: string;
	purpose: UsagePurpose;
	policy: ModelPolicy;
	signal: AbortSignal;
	probeKey?: string;
	estimate?: UsageMeasure;
}
/** Common transport boundary for main, probes and auxiliary inference. Never wraps tools or a whole agent loop. */
export class ModelRequestService {
	private readonly usage: ModelUsageService;
	private blocked = false;
	constructor(usage: ModelUsageService) {
		this.usage = usage;
	}
	async attempt<T>(
		request: ModelAttemptRequest,
		call: (onUsage: (usage: UsageMeasurement) => void) => Promise<T>,
	): Promise<T> {
		if (this.blocked) throw new ModelAccountingError("Prior settlement is unresolved");
		request.signal.throwIfAborted();
		const admission = await this.usage.reserve(request.requestId, request.purpose, {
			estimate: request.estimate,
			probeKey: request.probeKey,
		});
		if (!admission.admitted)
			throw new Error("Model request already admitted; reconcile its receipt before retrying");
		return this.runSettled(
			request.requestId,
			request.purpose,
			request.target,
			request.signal,
			admission.reservationId,
			call,
		);
	}
	/**
	 * P2-A wiring for P1-S's published auxiliary port: this boundary keeps the durable admission
	 * ledger while the P1-S invocation service books its own C3 reservation, so one physical
	 * request settles exactly one C3 attempt in total. S's "classify" purpose is the C3
	 * "reception" kind in this ledger.
	 */
	auxiliaryBoundary(): AuxiliaryAttemptBoundary {
		return async (request, call) => {
			if (this.blocked) throw new ModelAccountingError("Prior settlement is unresolved");
			request.signal.throwIfAborted();
			const purpose: UsagePurpose = request.purpose === "classify" ? "reception" : "auxiliary";
			const admission = await this.usage.reserve(request.requestId, purpose, {}, "record-only");
			if (!admission.admitted)
				throw new Error("Model request already admitted; reconcile its receipt before retrying");
			return this.runSettled(
				request.requestId,
				purpose,
				request.target,
				request.signal,
				admission.reservationId,
				call,
			);
		};
	}
	private async runSettled<T>(
		requestId: string,
		purpose: UsagePurpose,
		target: ModelTarget,
		signal: AbortSignal,
		reservationId: string,
		call: (onUsage: (usage: UsageMeasurement) => void) => Promise<T>,
	): Promise<T> {
		const startedAt = Date.now();
		let usage: UsageMeasurement | undefined,
			acceptingUsage = true;
		const onUsage = (measurement: UsageMeasurement) => {
			if (acceptingUsage) usage = structuredClone(measurement);
		};
		let result: T,
			outcome: "success" | "failure" = "success",
			failure: unknown;
		try {
			signal.throwIfAborted();
			result = await abortable(call(onUsage), signal);
		} catch (error) {
			outcome = "failure";
			failure = error;
		}
		acceptingUsage = false;
		const { costUsd, ...tokens } = usage ?? {};
		try {
			await this.usage.settle({
				requestId,
				purpose,
				target: {
					id: target.id,
					revision: target.revision,
					provider: target.provider,
					model: target.model,
					billing: target.billing,
				},
				startedAt,
				finishedAt: Date.now(),
				outcome,
				usage: usage ? tokens : undefined,
				costUsd,
				reservationId,
			});
		} catch (error) {
			this.blocked = true;
			throw new ModelAccountingError(error);
		}
		if (outcome === "failure") throw failure;
		return result!;
	}
	async request<T>(
		request: ModelServiceRequest,
		call: (
			target: ModelTarget,
			signal: AbortSignal,
			onProgress: (phase?: string) => void,
			onUsage: (usage: UsageMeasurement) => void,
			attempt: Attempt,
		) => Promise<T>,
	): Promise<T> {
		validateIdentity(request.requestId);
		const policy = request.policy;
		const recovery = new ModelRecovery(policy.targets, policy.preferred, policy.requirements, policy.recovery);
		const signal = AbortSignal.any([
			request.signal,
			AbortSignal.timeout(policy.totalTimeoutMs ?? policy.requestTimeoutMs * (policy.maxAttempts + 1)),
		]);
		return inferWithRecovery(
			recovery,
			(target, attempt, attemptSignal, onProgress) =>
				this.attempt(
					{
						requestId: `${request.requestId}/${attempt.generation}`,
						purpose: request.purpose,
						target,
						signal: attemptSignal,
						probeKey: request.probeKey,
						estimate: request.estimate,
					},
					(onUsage) => call(target, attemptSignal, onProgress ?? (() => {}), onUsage, attempt),
				).catch((error: unknown) => {
					if (error instanceof ModelBudgetExhausted) throw new ModelFailure("quota");
					throw error;
				}),
			{
				signal,
				maxAttempts: policy.maxAttempts,
				timeoutMs: policy.requestTimeoutMs,
				connectTimeoutMs: policy.connectTimeoutMs,
				firstByteTimeoutMs: policy.firstByteTimeoutMs,
				progressIdleMs: policy.progressIdleMs,
				retryBackoffMs: policy.retryBackoffMs ?? policy.recovery.probeIntervalMs,
				maxRetryBackoffMs: policy.recovery.maxProbeIntervalMs,
			},
		);
	}
	/** Convenience identity for a newly authorized call, not for replaying an interrupted logical operation. */
	newRequestId(): string {
		return randomUUID();
	}
}
