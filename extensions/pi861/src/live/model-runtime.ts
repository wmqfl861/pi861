import { digest } from "../memory.ts";
import { abortable } from "./deadline.ts";
import { eligible, inferWithRecovery, ModelFailure, ModelRecovery, type ExecutionMode, type ModelTarget, type RecoveryOptions, type Requirements } from "../routing.ts";
import type { StateStore } from "./store.ts";

export interface RouteDecision { mode: ExecutionMode; targetId: string; minQuality: number; reason: string; }
export interface RouteClassifier {
	classify(task: string, candidates: ModelTarget[], signal: AbortSignal): Promise<RouteDecision>;
}
export interface ModelPolicy {
	targets: ModelTarget[]; preferred: string; requirements: Requirements;
	recovery: RecoveryOptions; maxAttempts: number; requestTimeoutMs: number;
	maxRequests: number; maxProbeRequests: number;
}
export interface ModelRuntimeState {
	mode: ExecutionMode; preferred: string; active: string; reason: string;
	requests: number; probes: number; cancelled: boolean;
}
export interface ModelCheckpoint {
	version: 1; policyHash: string; taskKey: string; classified: boolean;
	requirements: Requirements; recovery: ReturnType<ModelRecovery["exportState"]>;
	state: ModelRuntimeState;
}
export interface UsageReservation { limit: number; used: number; intents: Record<string, number>; }

/** Global request admission, shared by planners, workers and maintenance when backed by the same store. */
export class RequestBudget {
	private readonly store: StateStore<UsageReservation>;
	constructor(store: StateStore<UsageReservation>) { this.store = store; }
	async reserve(intent: string, count = 1): Promise<void> {
		if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid request reservation");
		await this.store.update((state) => {
			if (state.intents[intent] !== undefined) {
				if (state.intents[intent] !== count) throw new Error("Budget intent changed");
				return;
			}
			if (state.used + count > state.limit) throw new Error("Global model request budget exhausted");
			state.used += count; state.intents[intent] = count;
		});
	}
}

/** Controls inference requests only; a completed tool invocation is never put inside this retry loop. */
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
	private pending: "escalate" | "reassess" | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lifetime = new AbortController();
	private task = "";
	private taskKey = "";
	private readonly classify: RouteClassifier | undefined;
	private readonly infer: (target: ModelTarget, context: TContext, signal: AbortSignal) => Promise<TResponse>;
	private readonly probeCall: (target: ModelTarget, signal: AbortSignal) => Promise<boolean>;
	private readonly save: (state: ModelRuntimeState, checkpoint: ModelCheckpoint) => void;
	constructor(policy: ModelPolicy,
		infer: (target: ModelTarget, context: TContext, signal: AbortSignal) => Promise<TResponse>,
		probe: (target: ModelTarget, signal: AbortSignal) => Promise<boolean>,
		classifier?: RouteClassifier, save: (state: ModelRuntimeState, checkpoint: ModelCheckpoint) => void = () => {}) {
		if (policy.maxRequests < 1 || policy.maxProbeRequests < 0) throw new Error("Invalid model budget");
		this.policy = structuredClone(policy); this.requirements = structuredClone(policy.requirements);
		this.recovery = new ModelRecovery(policy.targets, policy.preferred, policy.requirements, policy.recovery);
		this.infer = infer; this.probeCall = probe; this.classify = classifier; this.save = save;
	}
	get state(): ModelRuntimeState { return { mode: this.mode, preferred: this.recovery.state.preferred, active: this.recovery.state.active,
		reason: this.reason, requests: this.requests, probes: this.probes, cancelled: this.cancelled }; }
	private persist(): void { this.save(this.state, this.checkpoint); }
	get checkpoint(): ModelCheckpoint {
		return { version: 1, policyHash: digest(this.policy), taskKey: this.taskKey, classified: this.classified,
			requirements: structuredClone(this.requirements), recovery: this.recovery.exportState(), state: this.state };
	}
	restore(checkpoint: ModelCheckpoint): void {
		if (checkpoint.version !== 1 || checkpoint.policyHash !== digest(this.policy)) return;
		if (!Number.isSafeInteger(checkpoint.state.requests) || checkpoint.state.requests < 0 || !Number.isSafeInteger(checkpoint.state.probes) || checkpoint.state.probes < 0 ||
			!["direct", "fixed", "dynamic"].includes(checkpoint.state.mode) || typeof checkpoint.taskKey !== "string") throw new Error("Invalid model checkpoint");
		this.requirements = structuredClone(checkpoint.requirements);
		this.recovery = new ModelRecovery(this.policy.targets, checkpoint.recovery.preferred, this.requirements, checkpoint.recovery.options);
		this.recovery.restore(checkpoint.recovery);
		this.requests = checkpoint.state.requests; this.probes = checkpoint.state.probes; this.mode = checkpoint.state.mode;
		this.reason = checkpoint.state.reason; this.classified = checkpoint.classified; this.taskKey = checkpoint.taskKey;
		this.ensureProbeTimer();
	}
	setTask(task: string): void {
		const key = digest(task); if (key !== this.taskKey) this.classified = false;
		this.taskKey = key; this.task = task;
	}
	private ensureProbeTimer(): void {
		if (!this.timer && !this.cancelled && this.recovery.state.options.failbackEnabled && this.state.active !== this.state.preferred) {
			this.timer = setInterval(() => { void this.checkRecovery().catch(() => {}); }, Math.max(10, this.recovery.state.options.probeIntervalMs));
			this.timer.unref();
		}
	}
	report(kind: "verification_failed" | "capability_gap" | "phase_complete" | "scope_changed"): void {
		if (kind === "verification_failed") { this.failures++; if (this.failures >= 2) this.pending = "escalate"; }
		else if (kind === "capability_gap") this.pending = "escalate";
		else if (kind === "scope_changed" || this.mode === "dynamic") this.pending = "reassess";
	}
	setRecoveryOptions(options: Partial<RecoveryOptions>): void {
		this.recovery.setOptions(options); this.persist();
		if (!this.recovery.state.options.failbackEnabled && this.timer) { clearInterval(this.timer); this.timer = undefined; }
		this.ensureProbeTimer();
	}
	private async choose(signal: AbortSignal): Promise<void> {
		if (this.pending === "escalate") {
			const current = this.recovery.current;
			const next = this.policy.targets.filter((target) => target.quality > current.quality && eligible(target, this.requirements))
				.sort((a, b) => b.quality - a.quality || a.costRank - b.costRank)[0];
			if (!next) throw new Error("No authorized stronger model is available; task paused");
			this.requirements.minQuality = Math.max(this.requirements.minQuality, next.quality);
			this.recovery.setPreferred(next.id, this.requirements); this.reason = "Capability/verification escalation";
			this.pending = undefined; this.failures = 0; this.classified = true; this.persist(); return;
		}
		if ((!this.classified || this.pending === "reassess") && this.classify && this.task) {
			const candidates = this.policy.targets.filter((target) => eligible(target, this.policy.requirements));
			const decision = await abortable(this.classify.classify(this.task, structuredClone(candidates), signal), signal);
			signal.throwIfAborted();
			if (!["direct", "fixed", "dynamic"].includes(decision.mode) || !Number.isFinite(decision.minQuality) || decision.minQuality < this.policy.requirements.minQuality) throw new Error("Invalid routing decision");
			const requirements = { ...this.policy.requirements, minQuality: decision.minQuality };
			const target = candidates.find((target) => target.id === decision.targetId && eligible(target, requirements));
			if (!target) throw new Error("Router selected an unauthorized or inadequate model");
			this.mode = decision.mode; this.reason = decision.reason.slice(0, 1000); this.requirements = requirements;
			this.recovery.setPreferred(target.id, requirements);
		}
		this.classified = true; this.pending = undefined; this.persist();
	}
	async call(context: TContext, signal: AbortSignal): Promise<TResponse> {
		if (this.cancelled) throw new Error("Model runtime is closed");
		const effective = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.policy.requestTimeoutMs * (this.policy.maxAttempts + 1))]);
		await this.choose(effective); this.recovery.atBoundary();
		try {
			return await inferWithRecovery(this.recovery, async (target, _attempt, requestSignal) => {
				if (this.requests >= this.policy.maxRequests) throw new ModelFailure("quota");
				this.requests++; this.persist();
				return this.infer(target, context, requestSignal);
			}, { signal: effective, maxAttempts: this.policy.maxAttempts, timeoutMs: this.policy.requestTimeoutMs });
		} finally {
			this.persist();
			this.ensureProbeTimer();
		}
	}
	async checkRecovery(now = Date.now()): Promise<void> {
		if (this.cancelled || this.probes >= this.policy.maxProbeRequests) return;
		const probe = this.recovery.beginProbe(now); if (!probe) return;
		const target = this.policy.targets.find((target) => target.id === probe.configId && target.revision === probe.configRevision);
		if (!target) return;
		this.probes++; this.persist();
		let ok = false;
		try { const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.policy.requestTimeoutMs)]); ok = await abortable(this.probeCall(target, signal), signal); }
		catch { ok = false; }
		this.recovery.finishProbe(probe, ok, now);
		this.persist();
	}
	close(): void { this.cancelled = true; this.lifetime.abort(); if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}
