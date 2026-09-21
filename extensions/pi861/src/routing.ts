import {
	clone,
	digest,
	type Mode,
	nonempty,
	PlatformError,
	positive,
	requireCondition,
	throwIfAborted,
} from "./core.ts";

export interface ModelProfile {
	id: string;
	provider: string;
	model: string;
	version: string;
	tier: number;
	costRank: number;
	contextWindow: number;
	capabilities: string[];
	dataClasses: string[];
	enabled: boolean;
}
export interface Requirements {
	minimumTier: number;
	contextTokens: number;
	capabilities: string[];
	dataClass: string;
}
export interface Assessment extends Requirements {
	mode: Mode;
	reason: string;
}
export type ReassessmentEvent =
	| "initial"
	| "phase-change"
	| "requirement-change"
	| "validation-failed"
	| "no-progress"
	| "help";
export interface RoutingDecision {
	mode: Mode;
	preferredId: string;
	reason: string;
}

export function eligible(model: ModelProfile, requirements: Requirements): boolean {
	return (
		model.enabled &&
		model.tier >= requirements.minimumTier &&
		model.contextWindow >= requirements.contextTokens &&
		requirements.capabilities.every((capability) => model.capabilities.includes(capability)) &&
		model.dataClasses.includes(requirements.dataClass)
	);
}

export function validateProfiles(profiles: ModelProfile[]): void {
	requireCondition(
		profiles.length > 0 && new Set(profiles.map((profile) => profile.id)).size === profiles.length,
		"INVALID_MODELS",
		"Model profile ids must be unique",
	);
	for (const profile of profiles) {
		nonempty(profile.id, "model profile id", 100);
		nonempty(profile.provider, "provider", 200);
		nonempty(profile.model, "model", 200);
		nonempty(profile.version, "model profile version", 100);
		requireCondition(
			Number.isSafeInteger(profile.tier) &&
				profile.tier >= 0 &&
				Number.isFinite(profile.costRank) &&
				profile.costRank >= 0,
			"INVALID_MODELS",
			"Invalid quality tier or cost rank",
		);
		positive(profile.contextWindow, "contextWindow");
		requireCondition(
			Array.isArray(profile.capabilities) &&
				Array.isArray(profile.dataClasses) &&
				typeof profile.enabled === "boolean",
			"INVALID_MODELS",
			"Invalid profile capability fields",
		);
	}
}

/** One assessment supplies mode AND quality requirements. No recursive router agent. */
export function chooseRoute(
	profiles: ModelProfile[],
	assessment: Assessment,
	receptionistId: string,
	previous?: RoutingDecision,
	event: ReassessmentEvent = "initial",
): RoutingDecision {
	validateProfiles(profiles);
	requireCondition(
		["direct", "fixed", "dynamic"].includes(assessment.mode) &&
			Number.isSafeInteger(assessment.minimumTier) &&
			assessment.minimumTier >= 0 &&
			Number.isSafeInteger(assessment.contextTokens) &&
			assessment.contextTokens >= 0,
		"INVALID_ASSESSMENT",
		"Invalid task assessment",
	);
	const candidates = profiles.filter((profile) => eligible(profile, assessment));
	requireCondition(
		candidates.length > 0,
		"NO_QUALIFIED_MODEL",
		"No model satisfies quality, data and capability requirements",
	);
	if (previous?.mode === "fixed" && event === "phase-change") {
		const current = candidates.find((profile) => profile.id === previous.preferredId);
		if (current) return clone(previous);
	}
	const receptionist = candidates.find((profile) => profile.id === receptionistId);
	const selected =
		assessment.mode === "direct" && receptionist
			? receptionist
			: [...candidates].sort((a, b) => a.costRank - b.costRank || a.id.localeCompare(b.id))[0];
	return {
		mode: assessment.mode,
		preferredId: selected.id,
		reason: nonempty(assessment.reason, "routing reason", 2000),
	};
}

export interface ReliabilitySettings {
	failoverEnabled: boolean;
	failbackEnabled: boolean;
	maxAttempts: number;
	retriesPerModel: number;
	requestTimeoutMs: number;
	retryDelayMs: number;
	probeIntervalMs: number;
	maxProbeIntervalMs: number;
	recoverySuccesses: number;
}
export const DEFAULT_RELIABILITY: ReliabilitySettings = {
	failoverEnabled: true,
	failbackEnabled: true,
	maxAttempts: 3,
	retriesPerModel: 1,
	requestTimeoutMs: 180_000,
	retryDelayMs: 1000,
	probeIntervalMs: 60_000,
	maxProbeIntervalMs: 300_000,
	recoverySuccesses: 2,
};
export function resolveReliability(...layers: Partial<ReliabilitySettings>[]): ReliabilitySettings {
	const result = { ...DEFAULT_RELIABILITY };
	for (const layer of layers)
		for (const key of Object.keys(layer) as (keyof ReliabilitySettings)[]) {
			requireCondition(key in DEFAULT_RELIABILITY, "INVALID_CONFIG", `Unknown reliability setting ${key}`);
			if (layer[key] !== undefined) Object.assign(result, { [key]: layer[key] });
		}
	requireCondition(
		typeof result.failoverEnabled === "boolean" && typeof result.failbackEnabled === "boolean",
		"INVALID_CONFIG",
		"Failover and failback must be independent booleans",
	);
	for (const key of [
		"maxAttempts",
		"requestTimeoutMs",
		"probeIntervalMs",
		"maxProbeIntervalMs",
		"recoverySuccesses",
	] as const) {
		positive(result[key], key);
	}
	for (const key of ["retriesPerModel", "retryDelayMs"] as const) {
		requireCondition(
			Number.isSafeInteger(result[key]) && result[key] >= 0,
			"INVALID_CONFIG",
			`${key} must be nonnegative`,
		);
	}
	requireCondition(result.maxProbeIntervalMs >= result.probeIntervalMs, "INVALID_CONFIG", "Invalid probe intervals");
	return result;
}

export type FailureKind =
	| "network"
	| "timeout"
	| "overload"
	| "rate-limit"
	| "credentials"
	| "invalid-request"
	| "cancelled";
export class ModelFailure extends PlatformError {
	readonly kind: FailureKind;
	readonly retryAfterMs: number;
	constructor(kind: FailureKind, message: string, retryAfterMs = 0) {
		super(`MODEL_${kind.toUpperCase().replaceAll("-", "_")}`, message);
		this.kind = kind;
		requireCondition(Number.isFinite(retryAfterMs) && retryAfterMs >= 0, "INVALID_CONFIG", "Invalid retry delay");
		this.retryAfterMs = retryAfterMs;
	}
}
export interface Health {
	signature: string;
	state: "healthy" | "open" | "recovering";
	failures: number;
	successes: number;
	nextProbeAt: number;
}
export interface ModelAttempt<T> {
	value: T;
	profileId: string;
	attempts: number;
}
export interface ReliabilityEvent {
	type: "attempt" | "failover" | "failback" | "failed" | "probe" | "recovered";
	profileId: string;
	attempt?: number;
	reason?: string;
}
type Call<T> = (model: ModelProfile, signal: AbortSignal) => Promise<T>;

async function delay(ms: number, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	if (ms <= 0) return;
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => signal?.removeEventListener("abort", abort);
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);
		const abort = (): void => {
			clearTimeout(timer);
			cleanup();
			reject(new PlatformError("CANCELLED", "Cancelled"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}
async function bounded<T>(
	fn: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	parent?: AbortSignal,
): Promise<T> {
	throwIfAborted(parent);
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort!: () => void;
	const stopped = new Promise<never>((_resolve, reject) => {
		abort = (): void => {
			controller.abort();
			reject(new PlatformError("CANCELLED", "Cancelled"));
		};
		parent?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => {
			controller.abort();
			reject(new ModelFailure("timeout", "Model request deadline exceeded"));
		}, timeoutMs);
	});
	try {
		// Racing fences a provider that ignores AbortSignal; no returned late value can win.
		return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), stopped]);
	} finally {
		if (timer) clearTimeout(timer);
		parent?.removeEventListener("abort", abort);
		controller.abort();
	}
}

/** Per-agent execution state; a shared instance can be used by a host health supervisor. */
export class ModelSupervisor {
	private profiles: ModelProfile[];
	private health = new Map<string, Health>();
	private settings: ReliabilitySettings;
	private now: () => number;
	private sleep: typeof delay;
	private emit: (event: ReliabilityEvent) => void;
	private preferredId: string;
	private currentId: string;
	private generation = 0;
	private busy = false;
	private probing = new Set<string>();

	constructor(
		profiles: ModelProfile[],
		preferredId: string,
		settings: Partial<ReliabilitySettings> = {},
		options: { now?: () => number; sleep?: typeof delay; onEvent?: (event: ReliabilityEvent) => void } = {},
	) {
		validateProfiles(profiles);
		requireCondition(
			profiles.some((profile) => profile.id === preferredId),
			"UNKNOWN_MODEL",
			"Unknown preferred model",
		);
		this.profiles = clone(profiles);
		this.preferredId = preferredId;
		this.currentId = preferredId;
		this.settings = resolveReliability(settings);
		this.now = options.now ?? Date.now;
		this.sleep = options.sleep ?? delay;
		this.emit = (event): void => {
			try {
				options.onEvent?.(event);
			} catch {
				/* Observability only. */
			}
		};
	}
	status(): { preferredId: string; currentId: string; settings: ReliabilitySettings; health: Record<string, Health> } {
		return {
			preferredId: this.preferredId,
			currentId: this.currentId,
			settings: clone(this.settings),
			health: Object.fromEntries([...this.health].map(([key, item]) => [key, clone(item)])),
		};
	}
	configure(settings: Partial<ReliabilitySettings>): void {
		this.settings = resolveReliability(this.settings, settings);
	}
	setPreferred(profileId: string): void {
		requireCondition(!this.busy, "UNSAFE_BOUNDARY", "Change model only between requests");
		requireCondition(
			this.profiles.some((profile) => profile.id === profileId && profile.enabled),
			"UNKNOWN_MODEL",
			"Unknown model",
		);
		this.preferredId = profileId;
		this.currentId = profileId;
		this.generation++;
	}
	updateProfiles(profiles: ModelProfile[]): void {
		requireCondition(!this.busy, "UNSAFE_BOUNDARY", "Change configuration only between requests");
		validateProfiles(profiles);
		requireCondition(
			profiles.some((profile) => profile.id === this.preferredId),
			"UNKNOWN_MODEL",
			"Preferred model removed",
		);
		this.profiles = clone(profiles);
		this.generation++;
		for (const [key, record] of this.health) {
			const profile = profiles.find((item) => item.id === key);
			if (!profile || digest(profile) !== record.signature) this.health.delete(key);
		}
	}
	private available(profile: ModelProfile): boolean {
		return !this.health.has(profile.id) || this.health.get(profile.id)?.state === "healthy";
	}
	private fail(profile: ModelProfile, failure: ModelFailure): void {
		const old = this.health.get(profile.id);
		const failures = (old?.failures ?? 0) + 1;
		this.health.set(profile.id, {
			signature: digest(profile),
			state: "open",
			failures,
			successes: 0,
			nextProbeAt:
				this.now() +
				Math.max(
					failure.retryAfterMs,
					Math.min(
						this.settings.maxProbeIntervalMs,
						this.settings.probeIntervalMs * 2 ** Math.min(failures - 1, 10),
					),
				),
		});
		this.emit({ type: "failed", profileId: profile.id, reason: failure.kind });
	}
	async execute<T>(requirements: Requirements, call: Call<T>, signal?: AbortSignal): Promise<ModelAttempt<T>> {
		requireCondition(!this.busy, "REQUEST_IN_FLIGHT", "One supervisor cannot execute overlapping logical requests");
		throwIfAborted(signal);
		this.busy = true;
		const generation = this.generation;
		try {
			const candidates = this.profiles.filter((profile) => eligible(profile, requirements));
			requireCondition(candidates.length > 0, "NO_QUALIFIED_MODEL", "No eligible model for this task");
			const preferred = candidates.find((profile) => profile.id === this.preferredId);
			let current = candidates.find((profile) => profile.id === this.currentId);
			if (
				this.settings.failbackEnabled &&
				preferred &&
				this.available(preferred) &&
				this.currentId !== this.preferredId
			) {
				current = preferred;
				this.emit({ type: "failback", profileId: preferred.id });
				this.currentId = preferred.id;
			}
			if (!current || !this.available(current)) {
				if (!this.settings.failoverEnabled) {
					throw new PlatformError(
						"MODEL_UNAVAILABLE",
						"Selected configuration unavailable; automatic failover disabled",
					);
				}
				current = candidates.find((profile) => this.available(profile));
			}
			requireCondition(current, "NO_HEALTHY_MODEL", "No healthy qualified configuration; checkpoint and pause");
			const perModel = new Map<string, number>();
			let last: ModelFailure | undefined;
			for (let attempt = 1; attempt <= this.settings.maxAttempts; attempt++) {
				throwIfAborted(signal);
				const profile: ModelProfile = current;
				if (profile.id !== this.currentId) this.emit({ type: "failover", profileId: profile.id });
				this.currentId = profile.id;
				perModel.set(profile.id, (perModel.get(profile.id) ?? 0) + 1);
				this.emit({ type: "attempt", profileId: profile.id, attempt });
				try {
					const value = await bounded(
						(attemptSignal) => call(profile, attemptSignal),
						this.settings.requestTimeoutMs,
						signal,
					);
					throwIfAborted(signal);
					requireCondition(
						generation === this.generation,
						"STALE_ATTEMPT",
						"Configuration changed during request",
					);
					this.health.delete(profile.id);
					return { value, profileId: profile.id, attempts: attempt };
				} catch (error) {
					throwIfAborted(signal);
					if (!(error instanceof ModelFailure) || error.kind === "invalid-request" || error.kind === "cancelled")
						throw error;
					last = error;
					this.fail(profile, error);
					if (attempt === this.settings.maxAttempts) break;
					const same =
						error.kind !== "credentials" && (perModel.get(profile.id) ?? 0) <= this.settings.retriesPerModel;
					if (same) {
						await this.sleep(
							Math.max(error.retryAfterMs, this.settings.retryDelayMs * 2 ** (attempt - 1)),
							signal,
						);
						current = profile;
					} else {
						if (!this.settings.failoverEnabled) break;
						const next = candidates.find((candidate) => !perModel.has(candidate.id) && this.available(candidate));
						if (!next) break;
						current = next;
					}
				}
			}
			throw last ?? new PlatformError("MODEL_UNAVAILABLE", "Model request failed");
		} finally {
			this.busy = false;
		}
	}

	/** Host timer calls this only while a live task is on fallback. Probe has no tools/user data. */
	async probePreferred(probe: Call<void>, signal?: AbortSignal): Promise<boolean> {
		if (!this.settings.failbackEnabled || this.currentId === this.preferredId) return false;
		const model = this.profiles.find((profile) => profile.id === this.preferredId && profile.enabled);
		const health = model ? this.health.get(model.id) : undefined;
		if (
			!model ||
			!health ||
			health.state === "healthy" ||
			health.nextProbeAt > this.now() ||
			this.probing.has(model.id)
		)
			return false;
		throwIfAborted(signal);
		this.probing.add(model.id);
		const signature = digest(model);
		const generation = this.generation;
		this.emit({ type: "probe", profileId: model.id });
		try {
			await bounded((probeSignal) => probe(model, probeSignal), this.settings.requestTimeoutMs, signal);
			throwIfAborted(signal);
			const current = this.health.get(model.id);
			if (
				generation !== this.generation ||
				!this.settings.failbackEnabled ||
				!current ||
				current.signature !== signature
			)
				return false;
			current.successes++;
			current.state = current.successes >= this.settings.recoverySuccesses ? "healthy" : "recovering";
			current.nextProbeAt = this.now() + this.settings.probeIntervalMs;
			if (current.state === "healthy") this.emit({ type: "recovered", profileId: model.id });
			return current.state === "healthy";
		} catch (error) {
			throwIfAborted(signal);
			if (generation !== this.generation) return false;
			this.fail(model, error instanceof ModelFailure ? error : new ModelFailure("network", "Recovery probe failed"));
			return false;
		} finally {
			this.probing.delete(model.id);
		}
	}
}
