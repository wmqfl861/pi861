/** Model policy is separate from inference transport and tool side effects. */
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

function validateRequirements(requirements: Requirements): void {
	if (!Number.isFinite(requirements.minQuality) || requirements.minQuality < 0 ||
		!Number.isSafeInteger(requirements.contextTokens) || requirements.contextTokens < 0 ||
		requirements.allowedIds.length === 0) throw new Error("Invalid model requirements");
}
function validateOptions(options: RecoveryOptions): void {
	if (typeof options.failoverEnabled !== "boolean" || typeof options.failbackEnabled !== "boolean" ||
		!Number.isSafeInteger(options.probeIntervalMs) || options.probeIntervalMs <= 0 ||
		!Number.isSafeInteger(options.maxProbeIntervalMs) || options.maxProbeIntervalMs < options.probeIntervalMs ||
		!Number.isSafeInteger(options.requiredProbeSuccesses) || options.requiredProbeSuccesses < 1) {
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
				!Number.isSafeInteger(target.contextWindow) || target.contextWindow <= 0) {
				throw new Error("Invalid or duplicate model configuration");
			}
			this.targets.set(target.id, structuredClone(target));
		}
		this.requirements = structuredClone(requirements);
		this.options = { ...options };
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
			if (health.has(entry.id) || this.targets.get(entry.id)?.revision !== entry.revision || !Number.isSafeInteger(entry.failures) || entry.failures < 1 ||
				!Number.isSafeInteger(entry.successes) || entry.successes < 0 || !Number.isFinite(entry.nextProbeAt) || typeof entry.ready !== "boolean") throw new Error("Invalid recovery health checkpoint");
			health.set(entry.id, { failures: entry.failures, successes: entry.successes, nextProbeAt: entry.nextProbeAt, ready: entry.ready });
		}
		this.health.clear(); for (const [id, value] of health) this.health.set(id, value);
		this.preferred = snapshot.preferred; this.active = snapshot.active; this.options = { ...snapshot.options };
		this.generation = snapshot.generation + 1; this.probe = undefined; // Never restore an old request's execution authority.
	}

	setOptions(patch: Partial<RecoveryOptions>): void {
		const next = { ...this.options, ...patch };
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
		this.health.delete(attempt.configId);
		return true;
	}
	/** Cancellation never authorizes a new provider call. */
	cancel(attempt: Attempt): void {
		if (this.owns(attempt)) {
			this.attempt = undefined;
			this.generation++;
		}
	}
	fail(attempt: Attempt, kind: FailureKind, now: number, retryAfterMs = 0): boolean {
		if (!this.owns(attempt)) return false;
		this.cancel(attempt);
		if (kind === "cancelled" || kind === "invalid" || kind === "context") return false;
		const previous = this.health.get(attempt.configId);
		const failures = (previous?.failures ?? 0) + 1;
		const delay = Math.min(this.options.maxProbeIntervalMs,
			this.options.probeIntervalMs * 2 ** Math.min(failures - 1, 20));
		this.health.set(attempt.configId, {
			failures, successes: 0, ready: false,
			nextProbeAt: now + Math.max(delay, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0),
		});
		if (!this.options.failoverEnabled) return false;
		const next = [...this.targets.values()].find((target) =>
			target.id !== attempt.configId && eligible(target, this.requirements) &&
			(!this.health.has(target.id) || this.health.get(target.id)?.ready));
		if (!next) return false;
		this.active = next.id;
		return true;
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
 */
export async function inferWithRecovery<T>(
	recovery: ModelRecovery,
	call: (target: ModelTarget, attempt: Attempt, signal: AbortSignal) => Promise<T>,
	options: { signal: AbortSignal; maxAttempts: number; timeoutMs: number; now?: () => number },
): Promise<T> {
	if (!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1 ||
		!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("Invalid attempt limits");
	const now = options.now ?? Date.now;
	for (let index = 0; index < options.maxAttempts; index++) {
		options.signal.throwIfAborted();
		const attempt = recovery.beginAttempt();
		const timed = new AbortController();
		const signal = AbortSignal.any([options.signal, timed.signal]);
		const timer = setTimeout(() => timed.abort(new ModelFailure("transient")), options.timeoutMs);
		let onAbort: (() => void) | undefined;
		try {
			const interrupted = new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
				if (signal.aborted) onAbort();
			});
			const result = await Promise.race([call(recovery.current, attempt, signal), interrupted]);
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
			if (!switched || index + 1 >= options.maxAttempts) throw failure;
		} finally {
			clearTimeout(timer);
			if (onAbort) signal.removeEventListener("abort", onAbort);
		}
	}
	throw new Error("Attempt budget exhausted");
}
