import { randomUUID } from "node:crypto";
import { type MeteredKind, ProbeInFlight, type UsageMeasure } from "../contracts/budget.ts";
import { digest } from "../memory.ts";
import {
	type Attempt,
	type ExecutionMode,
	eligible,
	faultDomainKey,
	inferWithRecovery,
	ModelFailure,
	ModelRecovery,
	type ModelTarget,
	type RecoveryOptions,
	type Requirements,
} from "../routing.ts";
import { abortable } from "./deadline.ts";
import type { SharedHealthService } from "./health-service.ts";
import {
	ModelAccountingError,
	ModelBudgetExhausted,
	type ModelRequestService,
	type UsageMeasurement,
} from "./model-service.ts";
import type { StateStore } from "./store.ts";

export interface RouteDecision {
	mode: ExecutionMode;
	targetId: string;
	minQuality: number;
	reason: string;
	/** The reception model's completed answer, consumed once without another inference. */
	directAnswer?: string;
}
export type RouteSignal = "verification_failed" | "capability_gap" | "phase_complete" | "scope_changed" | "no_progress";
export interface RouteEvidenceInput {
	phase?: string;
	verification?: string;
	noProgress?: boolean;
	scopeDelta?: string;
	/** These two attestations must come from trusted host checks, never model tool arguments. */
	verificationPassed?: boolean;
	phaseAccepted?: boolean;
}
export interface RouteEvidenceRecord extends RouteEvidenceInput {
	at: number;
	kind: RouteSignal;
	reason: string;
}
export interface RouteEvidenceSummary {
	phase?: string;
	scopeDelta?: string;
	recentReasons: string[];
	verificationResults: string[];
	noProgressCount: number;
	events: RouteEvidenceRecord[];
}
export interface RouteClassifier {
	/** Its transport must use ModelRequestService too; the runtime does not double-meter reception. */
	classify(
		task: string,
		candidates: ModelTarget[],
		signal: AbortSignal,
		evidence?: RouteEvidenceSummary,
	): Promise<RouteDecision>;
}
export interface ModelPolicy {
	targets: ModelTarget[];
	preferred: string;
	requirements: Requirements;
	recovery: RecoveryOptions;
	maxAttempts: number;
	requestTimeoutMs: number;
	maxRequests: number;
	maxProbeRequests: number;
	connectTimeoutMs?: number;
	firstByteTimeoutMs?: number;
	progressIdleMs?: number;
	retryBackoffMs?: number;
	totalTimeoutMs?: number;
}
export interface ModelRuntimeState {
	mode: ExecutionMode;
	preferred: string;
	active: string;
	reason: string;
	requests: number;
	probes: number;
	cancelled: boolean;
	paused?: string;
}
export interface ModelCheckpoint {
	version: 2;
	policyHash: string;
	taskKey: string;
	classified: boolean;
	requirements: Requirements;
	recovery: ReturnType<ModelRecovery["exportState"]>;
	state: ModelRuntimeState;
	routing: {
		failures: number;
		noProgressCount: number;
		pending?: "escalate" | "reassess" | "degrade";
		phase?: string;
		scopeDelta?: string;
		events: RouteEvidenceRecord[];
	};
}
export interface UsageReservation {
	limit: number;
	used: number;
	intents: Record<string, number>;
}
export type { UsageMeasurement } from "./model-service.ts";
/** Runtime-relevant subset of the C3 metered kinds. */
export type MeterPurpose = Extract<MeteredKind, "execution" | "reception" | "probe">;
export interface ModelRequestMeter {
	begin(intent: string, purpose: MeterPurpose): void | Promise<void>;
	end(record: {
		intent: string;
		purpose: MeterPurpose;
		target?: { id: string; provider: string; model: string };
		outcome: "success" | "failure";
		usage?: UsageMeasurement;
		unknownUsage: boolean;
	}): void | Promise<void>;
}
export interface ModelRuntimeHooks<TContext = unknown, TResponse = unknown> {
	isHealthy?: (target: ModelTarget, now: number) => boolean;
	health?: SharedHealthService;
	requests?: ModelRequestService;
	/**
	 * Legacy fallback ONLY for the basic host composition: when `requests` is absent the runtime
	 * dispatches inference through this meter hook, and when both are absent dispatch is NOT
	 * metered at all (the host's own RequestBudget remains the only admission gate). This is the
	 * explicit unmetered-dispatch boundary (review N1): every production composition must inject
	 * `requests` (meteringMode "service"); P3-I acceptance includes the negative that a runtime
	 * wired without it reports meteringMode "unmetered" and therefore fails that gate.
	 */
	meter?: ModelRequestMeter;
	strictClassifier?: boolean;
	canDegrade?: (evidence: RouteEvidenceSummary) => boolean;
	directResponse?: (answer: string, context: TContext, target: ModelTarget) => TResponse;
}

/** Existing request-only admission port, retained for the basic host composition. */
export class RequestBudget {
	private readonly store: StateStore<UsageReservation>;
	constructor(store: StateStore<UsageReservation>) {
		this.store = store;
	}
	async reserve(intent: string, count = 1): Promise<void> {
		if (
			!intent ||
			["__proto__", "constructor", "prototype"].includes(intent) ||
			!Number.isSafeInteger(count) ||
			count < 1
		)
			throw new Error("Invalid request reservation");
		await this.store.update((state) => {
			if (Object.hasOwn(state.intents, intent)) {
				if (state.intents[intent] !== count) throw new Error("Budget intent changed");
				return;
			}
			if (
				!Number.isSafeInteger(state.limit) ||
				!Number.isSafeInteger(state.used) ||
				state.used + count > state.limit
			)
				throw new ModelBudgetExhausted();
			state.used += count;
			state.intents[intent] = count;
		});
	}
}

type Infer<TContext, TResponse> = (
	target: ModelTarget,
	context: TContext,
	signal: AbortSignal,
	onProgress?: (phase?: string) => void,
	onUsage?: (usage: UsageMeasurement) => void,
	attempt?: Attempt,
) => Promise<TResponse>;

/** Serial inference owner; completed tools are outside its retry loop. */
export class ModelRuntime<TContext, TResponse> {
	private readonly policy: ModelPolicy;
	private requirements: Requirements;
	private recovery: ModelRecovery;
	private mode: ExecutionMode = "fixed";
	private reason = "Configured initial model";
	private requests = 0;
	private probes = 0;
	private cancelled = false;
	private classified = false;
	private failures = 0;
	private paused: string | undefined;
	private pending: "escalate" | "reassess" | "degrade" | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly lifetime = new AbortController();
	private probeAbort: AbortController | undefined;
	private running = false;
	private probing = false;
	private task = "";
	private taskKey = "";
	private phase: string | undefined;
	private scopeDelta: string | undefined;
	private noProgressCount = 0;
	private evidence: RouteEvidenceRecord[] = [];
	private evidenceVersion = 0;
	private sharedAvailable = new Map<string, boolean>();
	private readonly classify: RouteClassifier | undefined;
	private readonly infer: Infer<TContext, TResponse>;
	private readonly probeCall: (
		target: ModelTarget,
		signal: AbortSignal,
		onUsage?: (usage: UsageMeasurement) => void,
	) => Promise<boolean>;
	private readonly save: (state: ModelRuntimeState, checkpoint: ModelCheckpoint) => void;
	private readonly hooks: ModelRuntimeHooks<TContext, TResponse>;

	constructor(
		policy: ModelPolicy,
		infer: Infer<TContext, TResponse>,
		probe: (
			target: ModelTarget,
			signal: AbortSignal,
			onUsage?: (usage: UsageMeasurement) => void,
		) => Promise<boolean>,
		classifier?: RouteClassifier,
		save: (state: ModelRuntimeState, checkpoint: ModelCheckpoint) => void = () => {},
		hooks: ModelRuntimeHooks<TContext, TResponse> = {},
	) {
		if (
			!Number.isSafeInteger(policy.maxRequests) ||
			policy.maxRequests < 1 ||
			!Number.isSafeInteger(policy.maxProbeRequests) ||
			policy.maxProbeRequests < 0 ||
			!Number.isSafeInteger(policy.maxAttempts) ||
			policy.maxAttempts < 1 ||
			!Number.isSafeInteger(policy.requestTimeoutMs) ||
			policy.requestTimeoutMs < 1
		)
			throw new Error("Invalid model limits");
		for (const limit of [
			policy.connectTimeoutMs,
			policy.firstByteTimeoutMs,
			policy.progressIdleMs,
			policy.retryBackoffMs,
			policy.totalTimeoutMs,
		]) {
			if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
				throw new Error("Invalid model deadline");
		}
		this.policy = structuredClone(policy);
		this.requirements = structuredClone(policy.requirements);
		this.hooks = hooks;
		this.recovery = this.newRecovery(policy.preferred, policy.requirements, policy.recovery);
		this.infer = infer;
		this.probeCall = probe;
		this.classify = classifier;
		this.save = save;
	}
	private newRecovery(preferred: string, requirements: Requirements, options: RecoveryOptions): ModelRecovery {
		return new ModelRecovery(this.policy.targets, preferred, requirements, options, {
			isAvailable: (target, now) => this.healthy(target, now),
		});
	}
	private healthy(target: ModelTarget, now = Date.now()): boolean {
		return (
			(this.sharedAvailable.get(faultDomainKey(target)) ?? true) && (this.hooks.isHealthy?.(target, now) ?? true)
		);
	}
	private async refreshHealth(): Promise<void> {
		if (!this.hooks.health) return;
		const domains = [...new Set(this.policy.targets.map(faultDomainKey))];
		const health = this.hooks.health;
		this.sharedAvailable = new Map(
			await Promise.all(domains.map(async (domain) => [domain, await health.isAvailable(domain)] as const)),
		);
	}
	get state(): ModelRuntimeState {
		return {
			mode: this.mode,
			preferred: this.recovery.state.preferred,
			active: this.recovery.state.active,
			reason: this.reason,
			requests: this.requests,
			probes: this.probes,
			cancelled: this.cancelled,
			paused: this.paused,
		};
	}
	/**
	 * Dispatch metering discipline of THIS runtime instance (review N1 boundary):
	 * "service" - every physical attempt is admitted and settled on the C3-backed
	 * ModelRequestService; "legacy" - only the meter hook runs; "unmetered" - dispatch
	 * bypasses model metering entirely (basic host composition only, never production).
	 */
	get meteringMode(): "service" | "legacy" | "unmetered" {
		if (this.hooks.requests) return "service";
		return this.hooks.meter ? "legacy" : "unmetered";
	}
	private persist(): void {
		try {
			this.save(this.state, this.checkpoint);
		} catch (error) {
			this.paused = "checkpoint_unavailable";
			throw error;
		}
	}
	get checkpoint(): ModelCheckpoint {
		return {
			version: 2,
			policyHash: digest(this.policy),
			taskKey: this.taskKey,
			classified: this.classified,
			requirements: structuredClone(this.requirements),
			recovery: this.recovery.exportState(),
			state: this.state,
			routing: {
				failures: this.failures,
				noProgressCount: this.noProgressCount,
				pending: this.pending,
				phase: this.phase,
				scopeDelta: this.scopeDelta,
				events: structuredClone(this.evidence),
			},
		};
	}
	restore(checkpoint: ModelCheckpoint): boolean {
		if (this.running || this.probing || this.cancelled)
			throw new Error("Checkpoint restore requires an idle runtime");
		if (checkpoint.version !== 2 || checkpoint.policyHash !== digest(this.policy)) {
			this.reason = "Checkpoint policy/version conflict; current runtime state retained";
			this.persist();
			return false;
		}
		const route = checkpoint.routing;
		if (
			!Number.isSafeInteger(checkpoint.state.requests) ||
			checkpoint.state.requests < 0 ||
			!Number.isSafeInteger(checkpoint.state.probes) ||
			checkpoint.state.probes < 0 ||
			!["direct", "fixed", "dynamic"].includes(checkpoint.state.mode) ||
			typeof checkpoint.taskKey !== "string" ||
			typeof checkpoint.classified !== "boolean" ||
			typeof checkpoint.state.reason !== "string" ||
			(checkpoint.state.paused !== undefined && typeof checkpoint.state.paused !== "string") ||
			!route ||
			!Number.isSafeInteger(route.failures) ||
			route.failures < 0 ||
			!Number.isSafeInteger(route.noProgressCount) ||
			route.noProgressCount < 0 ||
			(route.pending !== undefined && !["escalate", "reassess", "degrade"].includes(route.pending)) ||
			!Array.isArray(route.events) ||
			route.events.length > 64 ||
			route.events.some(
				(event) =>
					!Number.isFinite(event.at) ||
					typeof event.reason !== "string" ||
					!["verification_failed", "capability_gap", "phase_complete", "scope_changed", "no_progress"].includes(
						event.kind,
					),
			)
		)
			throw new Error("Invalid model checkpoint");
		const recovery = this.newRecovery(
			checkpoint.recovery.preferred,
			checkpoint.requirements,
			checkpoint.recovery.options,
		);
		recovery.restore(checkpoint.recovery);
		this.recovery = recovery;
		this.requirements = structuredClone(checkpoint.requirements);
		this.requests = checkpoint.state.requests;
		this.probes = checkpoint.state.probes;
		this.mode = checkpoint.state.mode;
		this.reason = checkpoint.state.reason;
		this.classified = checkpoint.classified;
		this.taskKey = checkpoint.taskKey;
		this.paused = checkpoint.state.paused;
		this.failures = route.failures;
		this.noProgressCount = route.noProgressCount;
		this.pending = route.pending;
		this.phase = route.phase;
		this.scopeDelta = route.scopeDelta;
		this.evidence = structuredClone(route.events);
		this.ensureProbeTimer();
		return true;
	}
	setTask(task: string): void {
		if (this.running) throw new Error("Task changes require an idle model runtime");
		const key = digest(task);
		if (key !== this.taskKey) {
			this.classified = false;
			this.failures = 0;
			this.evidence = [];
			this.noProgressCount = 0;
			this.phase = undefined;
			this.scopeDelta = undefined;
			this.pending = undefined;
			this.evidenceVersion++;
		}
		this.taskKey = key;
		this.task = task;
	}
	private ensureProbeTimer(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const state = this.recovery.state;
		const health = state.health.find((entry) => entry.id === state.preferred);
		if (
			this.cancelled ||
			this.probing ||
			!state.options.failbackEnabled ||
			this.probes >= this.policy.maxProbeRequests ||
			!health ||
			health.ready ||
			(state.active === state.preferred && this.paused !== "no_healthy_target")
		)
			return;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				void this.checkRecovery().catch(() => {
					this.paused = "health_unavailable";
				});
			},
			Math.max(10, health.nextProbeAt - Date.now()),
		);
		this.timer.unref();
	}
	report(kind: RouteSignal, reason = "", evidence?: RouteEvidenceInput): void {
		if (!["verification_failed", "capability_gap", "phase_complete", "scope_changed", "no_progress"].includes(kind))
			throw new Error("Invalid routing signal");
		const event: RouteEvidenceRecord = { at: Date.now(), kind, reason: reason.slice(0, 1000) };
		if (evidence?.phase) {
			event.phase = evidence.phase.slice(0, 200);
			this.phase = event.phase;
		}
		if (evidence?.verification) event.verification = evidence.verification.slice(0, 1000);
		if (kind === "no_progress" || evidence?.noProgress) {
			event.noProgress = true;
			this.noProgressCount++;
		}
		if (evidence?.scopeDelta) {
			event.scopeDelta = evidence.scopeDelta.slice(0, 1000);
			this.scopeDelta = event.scopeDelta;
		}
		event.verificationPassed = evidence?.verificationPassed === true;
		event.phaseAccepted = evidence?.phaseAccepted === true;
		this.evidence.push(event);
		if (this.evidence.length > 64) this.evidence.shift();
		this.evidenceVersion++;
		if (kind === "verification_failed") this.failures++;
		if (kind === "phase_complete" && event.verificationPassed && event.phaseAccepted) this.failures = 0;
		if (kind === "capability_gap" || (kind === "verification_failed" && this.failures >= 2))
			this.pending = "escalate";
		else if (this.pending !== "escalate") {
			if (kind === "phase_complete") this.pending = this.mode === "dynamic" ? "reassess" : "degrade";
			else if (kind === "scope_changed" || kind === "no_progress" || this.mode === "dynamic")
				this.pending = "reassess";
		}
		this.persist();
	}
	private evidenceSummary(): RouteEvidenceSummary {
		const recent = this.evidence.slice(-16);
		return {
			phase: this.phase,
			scopeDelta: this.scopeDelta,
			recentReasons: recent
				.filter((event) => event.reason)
				.slice(-8)
				.map((event) => event.reason),
			verificationResults: recent.filter((event) => event.verification).map((event) => event.verification ?? ""),
			noProgressCount: this.noProgressCount,
			events: structuredClone(recent),
		};
	}
	setRecoveryOptions(options: Partial<RecoveryOptions>): void {
		this.recovery.setOptions(options);
		if (!this.recovery.state.options.failbackEnabled) this.probeAbort?.abort(new Error("Failback disabled"));
		this.persist();
		this.ensureProbeTimer();
	}
	private canDegrade(): boolean {
		const summary = this.evidenceSummary(),
			last = summary.events.at(-1);
		return (
			this.failures === 0 &&
			last?.kind === "phase_complete" &&
			(this.hooks.canDegrade
				? this.hooks.canDegrade(summary)
				: last.verificationPassed === true && last.phaseAccepted === true)
		);
	}
	resume(): boolean {
		if (this.cancelled || this.running || this.probing) return false;
		if (!this.paused) return true;
		if (this.requests >= this.policy.maxRequests) return false;
		if (!this.recovery.selectAvailable(Date.now())) return false;
		this.paused = undefined;
		this.persist();
		return true;
	}
	private async choose(signal: AbortSignal): Promise<RouteDecision | undefined> {
		const version = this.evidenceVersion;
		if (this.pending === "escalate") {
			const current = this.recovery.current;
			const next = this.policy.targets
				.filter(
					(target) =>
						target.quality > current.quality &&
						eligible(target, this.requirements) &&
						this.recovery.isAvailable(target.id, Date.now()),
				)
				.sort((a, b) => b.quality - a.quality || a.costRank - b.costRank)[0];
			if (!next) {
				this.paused = "no_qualified_upgrade";
				throw new Error("No authorized stronger model is available; task paused");
			}
			this.requirements.minQuality = next.quality;
			this.recovery.setPreferred(next.id, this.requirements);
			this.probeAbort?.abort();
			this.reason = "Capability/verification escalation";
			this.pending = undefined;
			this.failures = 0;
			this.classified = true;
			return undefined;
		}
		if (this.pending === "degrade") {
			if (this.canDegrade()) {
				const current = this.recovery.current,
					baseline = this.policy.requirements;
				const next = this.policy.targets
					.filter(
						(target) =>
							eligible(target, baseline) &&
							this.recovery.isAvailable(target.id, Date.now()) &&
							target.costRank < current.costRank,
					)
					.sort((a, b) => a.costRank - b.costRank || a.id.localeCompare(b.id))[0];
				if (next) {
					this.requirements = structuredClone(baseline);
					this.recovery.setPreferred(next.id, baseline);
					this.probeAbort?.abort();
					this.reason = "Accepted phase and verified quality permit a cheaper model";
				}
			}
			this.pending = undefined;
			this.classified = true;
			return undefined;
		}
		if ((!this.classified || this.pending === "reassess") && this.classify && this.task) {
			const candidates = this.policy.targets.filter(
				(target) => eligible(target, this.policy.requirements) && this.recovery.isAvailable(target.id, Date.now()),
			);
			let decision: RouteDecision;
			try {
				signal.throwIfAborted();
				decision = await abortable(
					this.classify.classify(this.task, structuredClone(candidates), signal, this.evidenceSummary()),
					signal,
				);
				signal.throwIfAborted();
				if (
					!["direct", "fixed", "dynamic"].includes(decision.mode) ||
					!Number.isFinite(decision.minQuality) ||
					decision.minQuality < this.policy.requirements.minQuality ||
					typeof decision.reason !== "string"
				)
					throw new Error("Invalid routing decision");
				const requirements = { ...this.policy.requirements, minQuality: decision.minQuality };
				const target = candidates.find(
					(target) => target.id === decision.targetId && eligible(target, requirements),
				);
				if (!target) throw new Error("Router selected an unauthorized or inadequate model");
				if (
					decision.mode === "direct" &&
					(typeof decision.directAnswer !== "string" ||
						!decision.directAnswer.trim() ||
						!this.hooks.directResponse)
				)
					throw new Error("Direct routing requires a completed answer and host adapter");
				// New evidence arriving while reception runs invalidates that decision; preserve it for the next boundary.
				if (version !== this.evidenceVersion) return undefined;
				if (
					this.classified &&
					(target.quality < this.recovery.current.quality ||
						requirements.minQuality < this.requirements.minQuality ||
						target.costRank < this.recovery.current.costRank) &&
					!this.canDegrade()
				) {
					this.reason = "Retained route: downgrade lacks accepted phase and verified quality";
				} else {
					this.mode = decision.mode;
					this.reason = decision.reason.slice(0, 1000);
					this.requirements = requirements;
					this.recovery.setPreferred(target.id, requirements);
					this.probeAbort?.abort();
					this.classified = true;
					this.pending = undefined;
					return decision;
				}
			} catch (error) {
				signal.throwIfAborted();
				if (error instanceof ModelAccountingError) {
					this.paused = "usage_unsettled";
					throw error;
				}
				if (error instanceof ModelBudgetExhausted || (error instanceof ModelFailure && error.kind === "quota")) {
					this.paused = "budget_exhausted";
					throw error;
				}
				if (this.hooks.strictClassifier) {
					this.paused = "classifier_failed";
					throw error;
				}
				this.mode = "fixed";
				this.reason = "Classifier unavailable or invalid; retained authorized fixed route";
			}
		}
		this.classified = true;
		if (version === this.evidenceVersion) this.pending = undefined;
		return undefined;
	}
	private async metered<R>(
		target: ModelTarget,
		purpose: "execution" | "probe",
		signal: AbortSignal,
		work: (onUsage: (usage: UsageMeasurement) => void) => Promise<R>,
		admission: { probeKey?: string; estimate?: UsageMeasure } = {},
	): Promise<R> {
		const intent = randomUUID();
		if (this.hooks.requests)
			return this.hooks.requests.attempt({ requestId: intent, purpose, target, signal, ...admission }, work);
		let usage: UsageMeasurement | undefined;
		await this.hooks.meter?.begin(intent, purpose);
		let result: R;
		try {
			signal.throwIfAborted();
			result = await abortable(
				work((value) => {
					usage = structuredClone(value);
				}),
				signal,
			);
		} catch (error) {
			await this.meterEnd(intent, purpose, target, "failure", usage);
			throw error;
		}
		await this.meterEnd(intent, purpose, target, "success", usage);
		return result;
	}
	private async meterEnd(
		intent: string,
		purpose: MeterPurpose,
		target: ModelTarget,
		outcome: "success" | "failure",
		usage?: UsageMeasurement,
	): Promise<void> {
		try {
			await this.hooks.meter?.end({
				intent,
				purpose,
				target,
				outcome,
				usage,
				unknownUsage:
					!usage ||
					[usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].some(
						(value) => value === undefined,
					),
			});
		} catch (error) {
			this.paused = "usage_unsettled";
			throw error;
		}
	}
	async call(context: TContext, signal: AbortSignal, pendingOperations = 0): Promise<TResponse> {
		if (this.cancelled) throw new Error("Model runtime is closed");
		if (this.running) throw new Error("A model call is already active");
		if (!Number.isSafeInteger(pendingOperations) || pendingOperations < 0)
			throw new Error("Invalid pending operation count");
		if (pendingOperations > 0) {
			this.paused = "pending_operations";
			this.persist();
			throw new Error("Model runtime paused: reconcile pending operations first");
		}
		if (this.paused === "pending_operations") this.paused = undefined;
		if (this.paused) throw new Error(`Model runtime paused: ${this.paused}`);
		signal.throwIfAborted();
		this.running = true;
		const effective = AbortSignal.any([
			signal,
			this.lifetime.signal,
			AbortSignal.timeout(
				this.policy.totalTimeoutMs ?? this.policy.requestTimeoutMs * (this.policy.maxAttempts + 1),
			),
		]);
		try {
			await this.refreshHealth();
			effective.throwIfAborted();
			const decision = await this.choose(effective);
			this.recovery.atBoundary();
			if (!this.recovery.selectAvailable(Date.now())) {
				this.paused = "no_healthy_target";
				throw new Error("No authorized healthy model; task paused");
			}
			this.persist();
			if (decision?.mode === "direct" && decision.directAnswer !== undefined && this.hooks.directResponse)
				return this.hooks.directResponse(decision.directAnswer, context, this.recovery.current);
			return await inferWithRecovery(
				this.recovery,
				async (target, attempt, requestSignal, onProgress) => {
					if (this.requests >= this.policy.maxRequests) {
						this.paused = "budget_exhausted";
						throw new ModelFailure("quota");
					}
					this.requests++;
					this.persist();
					try {
						const result = await this.metered(target, "execution", requestSignal, (onUsage) =>
							this.infer(target, context, requestSignal, onProgress, onUsage, attempt),
						);
						await this.hooks.health?.recordSuccess(faultDomainKey(target));
						return result;
					} catch (error) {
						if (error instanceof ModelAccountingError) this.paused = "usage_unsettled";
						if (error instanceof ModelBudgetExhausted) {
							this.paused = "budget_exhausted";
							throw new ModelFailure("quota");
						}
						throw error;
					}
				},
				{
					signal: effective,
					maxAttempts: this.policy.maxAttempts,
					timeoutMs: this.policy.requestTimeoutMs,
					connectTimeoutMs: this.policy.connectTimeoutMs,
					firstByteTimeoutMs: this.policy.firstByteTimeoutMs,
					progressIdleMs: this.policy.progressIdleMs,
					retryBackoffMs: this.policy.retryBackoffMs ?? this.policy.recovery.probeIntervalMs,
					maxRetryBackoffMs: this.policy.recovery.maxProbeIntervalMs,
					onFailure: async (target, failure) => {
						if (this.recovery.willOpenCircuit(failure.kind)) {
							await this.hooks.health?.recordFailure(faultDomainKey(target), Date.now(), failure.retryAfterMs);
							await this.refreshHealth();
						}
					},
				},
			);
		} catch (error) {
			if (error instanceof ModelBudgetExhausted || (error instanceof ModelFailure && error.kind === "quota"))
				this.paused ??= "budget_exhausted";
			else if (
				error instanceof ModelFailure &&
				["transient", "rate-limit", "auth"].includes(error.kind) &&
				!this.recovery.selectAvailable(Date.now())
			)
				this.paused ??= "no_healthy_target";
			throw error;
		} finally {
			this.running = false;
			this.persist();
			this.ensureProbeTimer();
		}
	}
	async checkRecovery(now = Date.now()): Promise<void> {
		if (
			this.cancelled ||
			this.probing ||
			!this.recovery.state.options.failbackEnabled ||
			this.probes >= this.policy.maxProbeRequests
		)
			return;
		this.probing = true;
		let probe: ReturnType<ModelRecovery["beginProbe"]>;
		let lease: { probeId: string } | undefined;
		let domain: string | undefined;
		try {
			await this.refreshHealth();
			const preferred = this.policy.targets.find((target) => target.id === this.state.preferred);
			if (!preferred) return;
			domain = faultDomainKey(preferred);
			if (this.hooks.health && this.sharedAvailable.get(domain)) this.recovery.confirmPreferredHealthy();
			probe = this.recovery.beginProbe(now, this.paused === "no_healthy_target");
			if (!probe) return;
			if (this.hooks.health) {
				lease = await this.hooks.health.acquireProbe(domain, now);
				if (!lease) {
					this.recovery.cancelProbe(probe);
					return;
				}
			}
			this.probeAbort = new AbortController();
			const signal = AbortSignal.any([
				this.lifetime.signal,
				this.probeAbort.signal,
				AbortSignal.timeout(this.policy.requestTimeoutMs),
			]);
			let ok = false;
			let joined = false;
			try {
				signal.throwIfAborted();
				this.probes++;
				this.persist();
				// The C3 probe key makes the physical probe bill exactly once even when the
				// health lease is not shared: a second reservation for this domain joins the
				// in-flight one instead of dispatching and billing another probe.
				ok = await this.metered(
					preferred,
					"probe",
					signal,
					(onUsage) => this.probeCall(preferred, signal, onUsage),
					{ probeKey: domain },
				);
			} catch (error) {
				if (error instanceof ProbeInFlight) {
					// Another consumer owns the in-flight probe reservation: join it. No physical
					// probe happened here, so no probe budget is consumed and no health verdict
					// is folded in; the lease we may hold expires and the shared state settles.
					joined = true;
					this.probes--;
					this.recovery.cancelProbe(probe);
				} else if (error instanceof ModelBudgetExhausted) {
					this.paused = "budget_exhausted";
				}
			}
			if (!joined) {
				if (lease && this.hooks.health)
					await this.hooks.health.finishProbe(domain, lease.probeId, ok && !signal.aborted, now);
				this.recovery.finishProbe(probe, ok && !signal.aborted, now);
			}
			await this.refreshHealth();
			if (this.paused === "no_healthy_target" && this.recovery.isAvailable(this.state.preferred, now))
				this.paused = undefined;
			this.persist();
		} finally {
			this.probeAbort = undefined;
			this.probing = false;
			this.ensureProbeTimer();
		}
	}
	close(): void {
		this.cancelled = true;
		this.lifetime.abort();
		this.probeAbort?.abort();
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}
}
