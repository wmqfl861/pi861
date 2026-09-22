/** Model policy is separate from inference transport and tool side effects. */
export interface FaultDomain { accountId: string; endpoint: string; }
export interface TargetBilling {
	inputPerMt: number; outputPerMt: number; cacheReadPerMt: number; cacheWritePerMt: number;
}
export type DataEgress = "none" | "metadata" | "content";
export interface ModelTarget {
	id: string;
	revision: string;
	provider: string;
	model: string;
	quality: number;
	costRank: number;
	contextWindow: number;
	capabilities: string[];
	enabled: boolean;
	/** Account/endpoint identity: failures are shared inside a domain and auth failover only crosses accounts. */
	faultDomain?: FaultDomain;
	/** Optional pricing used to meter cost; absent means cost is unknown, never zero. */
	billing?: TargetBilling;
	maxOutputTokens?: number;
	/** Outbound data boundary consumed by the egress policy before a request is sent. */
	dataEgress?: DataEgress;
}

export interface Requirements {
	minQuality: number;
	contextTokens: number;
	capabilities: string[];
	allowedIds: string[];
}

export type ExecutionMode = "direct" | "fixed" | "dynamic";
export interface Assessment {
	canFinishDirectly: boolean;
	variableNeeds: boolean;
}
export interface RecoveryOptions {
	failoverEnabled: boolean;
	failbackEnabled: boolean;
	probeIntervalMs: number;
	maxProbeIntervalMs: number;
	requiredProbeSuccesses: number;
	/** Extra transient/rate-limit retries on the same target before the failure is recorded and failover is considered. */
	sameTargetRetries?: number;
	/** Auth (service refusal) failover policy: only a different account domain proves the next target can serve us. */
	authFailover?: "cross-domain" | "never" | "any";
}
export interface Attempt {
	generation: number;
	configId: string;
	configRevision: string;
}
export interface Probe extends Attempt {
	probeId: number;
}
interface Health {
	failures: number;
	successes: number;
	nextProbeAt: number;
	ready: boolean;
}
export type FailureKind = "transient" | "rate-limit" | "auth" | "quota" | "invalid" | "context" | "cancelled";

/** Stable health-sharing key: same account and endpoint under one provider share one circuit. */
export function faultDomainKey(target: ModelTarget): string {
	return target.faultDomain
		? `${target.faultDomain.accountId}\n${target.faultDomain.endpoint}\n${target.provider}`
		: `${target.provider}\n${target.model}`;
}
function validFaultDomain(domain: FaultDomain | undefined): boolean {
	return domain === undefined || (typeof domain.accountId === "string" && domain.accountId.length > 0 &&
		typeof domain.endpoint === "string" && domain.endpoint.length > 0);
}
function validBilling(billing: TargetBilling | undefined): boolean {
	return billing === undefined || ([billing.inputPerMt, billing.outputPerMt, billing.cacheReadPerMt, billing.cacheWritePerMt]
		.every((value) => Number.isFinite(value) && value >= 0));
}
function normalizeOptions(options: RecoveryOptions): RecoveryOptions {
	return { ...options, sameTargetRetries: options.sameTargetRetries ?? 0, authFailover: options.authFailover ?? "cross-domain" };
}

function validateRequirements(requirements: Requirements): void {
	if (!Number.isFinite(requirements.minQuality) || requirements.minQuality < 0 ||
		!Number.isSafeInteger(requirements.contextTokens) || requirements.contextTokens < 0 ||
		requirements.allowedIds.length === 0) throw new Error("Invalid model requirements");
}
function validateOptions(options: RecoveryOptions): void {
	if (typeof options.failoverEnabled !== "boolean" || typeof options.failbackEnabled !== "boolean" ||
		!Number.isSafeInteger(options.probeIntervalMs) || options.probeIntervalMs <= 0 ||
		!Number.isSafeInteger(options.maxProbeIntervalMs) || options.maxProbeIntervalMs < options.probeIntervalMs ||
		!Number.isSafeInteger(options.requiredProbeSuccesses) || options.requiredProbeSuccesses < 1 ||
		(options.sameTargetRetries !== undefined && (!Number.isSafeInteger(options.sameTargetRetries) || options.sameTargetRetries < 0)) ||
		(options.authFailover !== undefined && !["cross-domain", "never", "any"].includes(options.authFailover))) {
		throw new Error("Invalid recovery options");
	}
}
export function eligible(target: ModelTarget, requirements: Requirements): boolean {
	return target.enabled && requirements.allowedIds.includes(target.id) &&
		target.quality >= requirements.minQuality && target.contextWindow >= requirements.contextTokens &&
		requirements.capabilities.every((capability) => target.capabilities.includes(capability));
}
export function selectInitial(
	targets: readonly ModelTarget[], requirements: Requirements, assessment: Assessment,
): { mode: ExecutionMode; configId: string } {
	validateRequirements(requirements);
	const candidates = targets.filter((target) => eligible(target, requirements))
		.sort((a, b) => a.costRank - b.costRank || a.id.localeCompare(b.id));
	const target = candidates[0];
	if (!target) throw new Error("No authorized model satisfies the task");
	return {
		mode: assessment.canFinishDirectly ? "direct" : assessment.variableNeeds ? "dynamic" : "fixed",
		configId: target.id,
	};
}

/** Single-owner control state. A service must serialize commands and persist its snapshot. */
export class ModelRecovery {
	private readonly targets: Map<string, ModelTarget>;
	private requirements: Requirements;
	private options: RecoveryOptions;
	private readonly health = new Map<string, Health>();
	/** Transient failures absorbed by same-target retry; not part of health until the budget is exhausted. */
	private readonly transientRetries = new Map<string, number>();
	private generation = 0;
	private probeSequence = 0;
	private attempt: Attempt | undefined;
	private probe: Probe | undefined;
	private preferred: string;
	private active: string;

	constructor(targets: ModelTarget[], preferred: string, requirements: Requirements, options: RecoveryOptions) {
		validateRequirements(requirements);
		validateOptions(options);
		this.targets = new Map();
		for (const target of targets) {
			if (!target.id || !target.revision || !target.provider || !target.model ||
				this.targets.has(target.id) || !Number.isFinite(target.quality) || target.quality < 0 ||
				!Number.isFinite(target.costRank) || target.costRank < 0 ||
				!Number.isSafeInteger(target.contextWindow) || target.contextWindow <= 0 ||
				!validFaultDomain(target.faultDomain) || !validBilling(target.billing) ||
				(target.maxOutputTokens !== undefined && (!Number.isSafeInteger(target.maxOutputTokens) || target.maxOutputTokens < 1)) ||
				(target.dataEgress !== undefined && !["none", "metadata", "content"].includes(target.dataEgress))) {
				throw new Error("Invalid or duplicate model configuration");
			}
			this.targets.set(target.id, structuredClone(target));
		}
		this.requirements = structuredClone(requirements);
		this.options = normalizeOptions(options);
		this.requireEligible(preferred);
		this.preferred = preferred;
		this.active = preferred;
	}

	private requireEligible(id: string): ModelTarget {
		const target = this.targets.get(id);
		if (!target || !eligible(target, this.requirements)) throw new Error("Ineligible model configuration");
		return target;
	}
	get current(): ModelTarget { return structuredClone(this.requireEligible(this.active)); }
	get state() {
		return {
			preferred: this.preferred, active: this.active, generation: this.generation,
			inFlight: this.attempt !== undefined, options: { ...this.options },
			health: [...this.health.entries()].map(([id, health]) => ({ id, ...health })),
		};
	}
	exportState(): { version: 1; preferred: string; active: string; generation: number; options: RecoveryOptions; health: { id: string; revision: string; failures: number; successes: number; nextProbeAt: number; ready: boolean }[] } {
		return { version: 1, preferred: this.preferred, active: this.active, generation: this.generation, options: { ...this.options },
			health: [...this.health].map(([id, health]) => ({ id, revision: this.targets.get(id)?.revision ?? "", ...health })) };
	}
	restore(snapshot: ReturnType<ModelRecovery["exportState"]>): void {
		if (this.attempt || snapshot.version !== 1 || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0) throw new Error("Invalid recovery checkpoint");
		validateOptions(snapshot.options); this.requireEligible(snapshot.preferred); this.requireEligible(snapshot.active);
		const health = new Map<string, Health>();
		for (const entry of snapshot.health) {
			if (health.has(entry.id) || this.targets.get(entry.id)?.revision !== entry.revision || !Number.isSafeInteger(entry.failures) || entry.failures < 0 ||
				!Number.isSafeInteger(entry.successes) || entry.successes < 0 || !Number.isFinite(entry.nextProbeAt) || typeof entry.ready !== "boolean") throw new Error("Invalid recovery health checkpoint");
			health.set(entry.id, { failures: entry.failures, successes: entry.successes, nextProbeAt: entry.nextProbeAt, ready: entry.ready });
		}
		this.health.clear(); for (const [id, value] of health) this.health.set(id, value);
		this.transientRetries.clear();
		this.preferred = snapshot.preferred; this.active = snapshot.active; this.options = normalizeOptions(snapshot.options);
		this.generation = snapshot.generation + 1; this.probe = undefined; // Never restore an old request's execution authority.
	}

	setOptions(patch: Partial<RecoveryOptions>): void {
		const next = normalizeOptions({ ...this.options, ...patch });
		validateOptions(next);
		this.options = next;
		if (!next.failbackEnabled) this.probe = undefined;
	}
	/** Capability routing calls this only at a safe boundary, not during inference. */
	setPreferred(id: string, requirements: Requirements): void {
		if (this.attempt) throw new Error("Model routing requires a safe boundary");
		validateRequirements(requirements);
		const target = this.targets.get(id);
		if (!target || !eligible(target, requirements)) throw new Error("Ineligible preferred model");
		this.requirements = structuredClone(requirements);
		this.preferred = id;
		this.active = id;
		this.probe = undefined;
		this.transientRetries.delete(id);
		this.generation++;
	}
	beginAttempt(): Attempt {
		if (this.attempt) throw new Error("An inference attempt is already active");
		const target = this.current;
		const attempt = { generation: ++this.generation, configId: target.id, configRevision: target.revision };
		this.attempt = attempt;
		return { ...attempt };
	}
	private owns(attempt: Attempt): boolean {
		return this.attempt?.generation === attempt.generation &&
			this.attempt.configId === attempt.configId && this.attempt.configRevision === attempt.configRevision;
	}
	succeed(attempt: Attempt): boolean {
		if (!this.owns(attempt)) return false;
		this.attempt = undefined;
		this.transientRetries.delete(attempt.configId);
		// Decay instead of reset: one success must not erase a failure history or bypass probe confirmation.
		const health = this.health.get(attempt.configId);
		if (health && health.failures > 0) health.failures--;
		return true;
	}
	/** Cancellation never authorizes a new provider call. */
	cancel(attempt: Attempt): void {
		if (this.owns(attempt)) {
			this.attempt = undefined;
			this.transientRetries.delete(attempt.configId);
			this.generation++;
		}
	}
	/** Whether a just-failed transient attempt may still be retried in place on the same target. */
	retryableSameTarget(configId: string): boolean {
		return !this.health.has(configId) && (this.transientRetries.get(configId) ?? 0) <= (this.options.sameTargetRetries ?? 0);
	}
	fail(attempt: Attempt, kind: FailureKind, now: number, retryAfterMs = 0): boolean {
		if (!this.owns(attempt)) return false;
		const priorRetries = this.transientRetries.get(attempt.configId) ?? 0; // cancel() clears the counter.
		this.cancel(attempt);
		// Local quota, user cancellation, invalid usage and oversized context are not target sickness.
		if (kind === "cancelled" || kind === "invalid" || kind === "context" || kind === "quota") return false;
		if ((kind === "transient" || kind === "rate-limit") && !this.health.has(attempt.configId)) {
			if (priorRetries + 1 <= (this.options.sameTargetRetries ?? 0)) {
				this.transientRetries.set(attempt.configId, priorRetries + 1);
				return false;
			}
		}
		this.transientRetries.delete(attempt.configId);
		const previous = this.health.get(attempt.configId);
		const failures = (previous?.failures ?? 0) + 1;
		const delay = Math.min(this.options.maxProbeIntervalMs,
			this.options.probeIntervalMs * 2 ** Math.min(failures - 1, 20));
		this.health.set(attempt.configId, {
			failures, successes: 0, ready: false,
			nextProbeAt: now + Math.max(delay, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0),
		});
		if (!this.options.failoverEnabled) return false;
		const failed = this.targets.get(attempt.configId);
		const next = [...this.targets.values()].find((target) =>
			target.id !== attempt.configId && eligible(target, this.requirements) &&
			(!this.health.has(target.id) || this.health.get(target.id)?.ready) &&
			this.authSwitchAllowed(kind, failed, target));
		if (!next) return false;
		this.active = next.id;
		return true;
	}
	/** Service refusal (auth) only justifies a target on a provably different account domain. */
	private authSwitchAllowed(kind: FailureKind, failed: ModelTarget | undefined, candidate: ModelTarget): boolean {
		if (kind !== "auth") return true;
		if (this.options.authFailover === "never") return false;
		if (this.options.authFailover === "any") return true;
		return failed?.faultDomain !== undefined && candidate.faultDomain !== undefined &&
			failed.faultDomain.accountId !== candidate.faultDomain.accountId;
	}
	beginProbe(now: number): Probe | undefined {
		if (!this.options.failbackEnabled || this.active === this.preferred || this.probe) return undefined;
		const health = this.health.get(this.preferred);
		if (!health || health.ready || now < health.nextProbeAt) return undefined;
		const target = this.requireEligible(this.preferred);
		this.probe = {
			probeId: ++this.probeSequence, generation: this.generation,
			configId: target.id, configRevision: target.revision,
		};
		return { ...this.probe };
	}
	finishProbe(probe: Probe, successful: boolean, now: number): boolean {
		if (!this.options.failbackEnabled || this.probe?.probeId !== probe.probeId ||
			probe.configId !== this.preferred || this.probe.configRevision !== probe.configRevision) return false;
		this.probe = undefined;
		const health = this.health.get(probe.configId);
		if (!health) return false;
		health.successes = successful ? health.successes + 1 : 0;
		if (!successful) health.failures++;
		health.ready = health.successes >= this.options.requiredProbeSuccesses;
		health.nextProbeAt = now + (successful ? this.options.probeIntervalMs :
			Math.min(this.options.maxProbeIntervalMs,
				this.options.probeIntervalMs * 2 ** Math.min(health.failures - 1, 20)));
		return true;
	}
	/** Called before a NEW model request, after outstanding tool results are settled. */
	atBoundary(pendingOperations = 0): boolean {
		if (!this.options.failbackEnabled || this.attempt || pendingOperations > 0 ||
			this.active === this.preferred || !this.health.get(this.preferred)?.ready) return false;
		this.requireEligible(this.preferred);
		this.active = this.preferred;
		this.probe = undefined;
		this.generation++;
		return true;
	}
}

export class ModelFailure extends Error {
	readonly kind: FailureKind;
	readonly retryAfterMs: number;
	constructor(kind: FailureKind, retryAfterMs = 0) {
		super(`Model request failed: ${kind}`);
		this.kind = kind;
		this.retryAfterMs = retryAfterMs;
	}
}

/**
 * Runs buffered, side-effect-free inference ONLY. Never wrap tools in this retry loop.
 * Partial provider output must remain tentative inside the transport adapter.
 * The call adapter reports progress heartbeats so connection, first-response and
 * progress-idle deadlines can fire without provider cooperation.
 */
export async function inferWithRecovery<T>(
	recovery: ModelRecovery,
	call: (target: ModelTarget, attempt: Attempt, signal: AbortSignal, onProgress?: (phase?: string) => void) => Promise<T>,
	options: {
		signal: AbortSignal; maxAttempts: number; timeoutMs: number;
		connectTimeoutMs?: number; firstByteTimeoutMs?: number; progressIdleMs?: number;
		retryBackoffMs?: number; maxRetryBackoffMs?: number; now?: () => number;
	},
): Promise<T> {
	const positive = (value: number | undefined) => value === undefined || (Number.isSafeInteger(value) && value > 0);
	if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 ||
		!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 ||
		!positive(options.connectTimeoutMs) || !positive(options.firstByteTimeoutMs) || !positive(options.progressIdleMs) ||
		!positive(options.retryBackoffMs) ||
		(options.maxRetryBackoffMs !== undefined && (!positive(options.maxRetryBackoffMs) ||
			(options.retryBackoffMs ?? 0) > options.maxRetryBackoffMs))) throw new Error("Invalid attempt limits");
	const now = options.now ?? Date.now;
	for (let index = 0; index < options.maxAttempts; index++) {
		options.signal.throwIfAborted();
		const attempt = recovery.beginAttempt();
		const timed = new AbortController();
		const signal = AbortSignal.any([options.signal, timed.signal]);
		const timers: ReturnType<typeof setTimeout>[] = [];
		const fence = () => timed.abort(new ModelFailure("transient"));
		timers.push(setTimeout(fence, options.timeoutMs)); // Per-attempt total deadline.
		// Any heartbeat proves both that the connection is up and that the first response arrived.
		let progressed = false;
		if (options.connectTimeoutMs) timers.push(setTimeout(() => { if (!progressed) fence(); }, options.connectTimeoutMs));
		if (options.firstByteTimeoutMs) timers.push(setTimeout(() => { if (!progressed) fence(); }, options.firstByteTimeoutMs));
		let idle: ReturnType<typeof setTimeout> | undefined;
		const onProgress = (_phase?: string) => {
			progressed = true;
			if (options.progressIdleMs) { if (idle) clearTimeout(idle); idle = setTimeout(fence, options.progressIdleMs); }
		};
		let onAbort: (() => void) | undefined;
		try {
			const interrupted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			});
			const result = await Promise.race([call(recovery.current, attempt, signal, onProgress), interrupted]);
			options.signal.throwIfAborted();
			if (!recovery.succeed(attempt)) throw new Error("Stale inference result");
			return result;
		} catch (error) {
			if (options.signal.aborted) {
				recovery.cancel(attempt);
				throw options.signal.reason;
			}
			const failure = error instanceof ModelFailure ? error : new ModelFailure("invalid");
			const switched = recovery.fail(attempt, failure.kind, now(), failure.retryAfterMs);
			if (!switched && (failure.kind === "transient" || failure.kind === "rate-limit") &&
				recovery.retryableSameTarget(attempt.configId) && index + 1 < options.maxAttempts) {
				const retries = index; // Retry number within this target's budget; backoff grows with it.
				const backoff = Math.min(options.maxRetryBackoffMs ?? options.retryBackoffMs ?? 0,
					(options.retryBackoffMs ?? 0) * 2 ** Math.min(Math.max(retries, 0), 20));
				const delay = Math.max(backoff, Number.isFinite(failure.retryAfterMs) ? Math.max(0, failure.retryAfterMs) : 0);
				if (delay > 0) await abortableDelay(delay, options.signal);
				continue;
			}
			if (!switched || index + 1 >= options.maxAttempts) throw failure;
		} finally {
			for (const timer of timers) clearTimeout(timer);
			if (idle) clearTimeout(idle);
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}
	throw new Error("Attempt budget exhausted");
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", onAbort); resolve(); };
		const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
		const timer = setTimeout(finish, ms);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
	});
}
