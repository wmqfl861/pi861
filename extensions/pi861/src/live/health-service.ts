import type { StateStore } from "./store.ts";

/**
 * Fault-domain shared health: circuit state keyed by account/endpoint/provider,
 * cross-instance probe single-flight via storage-claimed leases, a shared probe
 * budget and per-domain backpressure. The lease is claimed inside a store
 * transaction and the probe itself always executes outside the lock.
 */
export interface SharedHealthEntry {
	failures: number;
	successes: number;
	nextProbeAt: number;
	ready: boolean;
}
export interface SharedHealthState {
	domains: Record<string, SharedHealthEntry & { lease?: { probeId: string; expiresAt: number } }>;
	probesUsed: number;
}
export interface SharedHealthOptions {
	probeLimit: number;
	requiredSuccesses: number;
	backoffMs: number;
	maxBackoffMs: number;
	/** Minimum spacing between probe attempts against a recovering domain. */
	minProbeIntervalMs: number;
	leaseTimeoutMs: number;
}
export type ProbePurpose = "failback" | "health";

function guardState(state: SharedHealthState): void {
	if (typeof state.domains !== "object" || state.domains === null || !Number.isSafeInteger(state.probesUsed) || state.probesUsed < 0) {
		throw new Error("Invalid shared health state");
	}
}
function entry(state: SharedHealthState, domain: string): SharedHealthEntry & { lease?: { probeId: string; expiresAt: number } } {
	let current = state.domains[domain];
	if (!current) {
		current = { failures: 0, successes: 0, nextProbeAt: 0, ready: false };
		state.domains[domain] = current;
	}
	return current;
}

export class SharedHealthService {
	private readonly store: StateStore<SharedHealthState>;
	private readonly options: SharedHealthOptions;
	private failbackProbesEnabled = true;
	constructor(store: StateStore<SharedHealthState>, options: SharedHealthOptions) {
		this.store = store;
		this.options = options;
		if (!Number.isSafeInteger(options.probeLimit) || options.probeLimit < 0 ||
			!Number.isSafeInteger(options.requiredSuccesses) || options.requiredSuccesses < 1 ||
			!Number.isSafeInteger(options.backoffMs) || options.backoffMs <= 0 ||
			!Number.isSafeInteger(options.maxBackoffMs) || options.maxBackoffMs < options.backoffMs ||
			!Number.isSafeInteger(options.minProbeIntervalMs) || options.minProbeIntervalMs < 0 ||
			!Number.isSafeInteger(options.leaseTimeoutMs) || options.leaseTimeoutMs <= 0) throw new Error("Invalid shared health options");
	}
	/** Disabling failback stops probes whose only purpose is switching back to a preferred target. */
	setFailbackProbes(enabled: boolean): void { this.failbackProbesEnabled = enabled; }
	async recordFailure(domain: string, now: number, retryAfterMs = 0): Promise<void> {
		if (!domain || !Number.isFinite(now)) throw new Error("Invalid shared health failure");
		await this.store.update((state) => {
			guardState(state);
			const current = entry(state, domain);
			current.failures++;
			current.successes = 0;
			current.ready = false;
			const backoff = Math.min(this.options.maxBackoffMs, this.options.backoffMs * 2 ** Math.min(current.failures - 1, 20));
			current.nextProbeAt = now + Math.max(backoff, Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0);
		});
	}
	/** Decay, matching the kernel: one observation must not erase a failure history. */
	async recordSuccess(domain: string): Promise<void> {
		if (!domain) throw new Error("Invalid shared health domain");
		await this.store.update((state) => {
			guardState(state);
			const current = state.domains[domain];
			if (current && current.failures > 0) current.failures--;
		});
	}
	/** A domain is usable when it has no circuit or the circuit is probe-confirmed. */
	async isAvailable(domain: string): Promise<boolean> {
		const state = await this.store.read();
		guardState(state);
		const current = state.domains[domain];
		return current === undefined || current.ready;
	}
	/** Claims the single probe slot for a domain: budget, backpressure and lease single-flight. */
	async acquireProbe(domain: string, now: number, purpose: ProbePurpose = "failback"): Promise<{ probeId: string } | undefined> {
		if (!domain || !Number.isFinite(now)) throw new Error("Invalid shared health probe");
		if (purpose === "failback" && !this.failbackProbesEnabled) return undefined;
		return this.store.update((state) => {
			guardState(state);
			const current = entry(state, domain);
			if (state.probesUsed >= this.options.probeLimit) return undefined;
			if (current.lease && current.lease.expiresAt > now) return undefined; // Single-flight across instances.
			if (now < current.nextProbeAt) return undefined; // Backpressure on a recovering domain.
			const probeId = `probe:${domain}:${now}:${current.failures}:${current.successes}`;
			current.lease = { probeId, expiresAt: now + this.options.leaseTimeoutMs };
			state.probesUsed++;
			return { probeId };
		});
	}
	/** Releases the lease and folds the observation in. Returns false for a stale or foreign lease. */
	async finishProbe(domain: string, probeId: string, successful: boolean, now: number): Promise<boolean> {
		if (!domain || !probeId || !Number.isFinite(now)) throw new Error("Invalid shared health probe completion");
		return this.store.update((state) => {
			guardState(state);
			const current = state.domains[domain];
			if (!current || current.lease?.probeId !== probeId) return false;
			current.lease = undefined;
			current.successes = successful ? current.successes + 1 : 0;
			if (!successful) current.failures++;
			current.ready = current.successes >= this.options.requiredSuccesses;
			current.nextProbeAt = now + (successful ? this.options.minProbeIntervalMs :
				Math.min(this.options.maxBackoffMs, this.options.backoffMs * 2 ** Math.min(current.failures - 1, 20)));
			return true;
		});
	}
	async totals(): Promise<{ probesUsed: number; probeLimit: number; domains: SharedHealthEntry[] }> {
		const state = await this.store.read();
		guardState(state);
		return { probesUsed: state.probesUsed, probeLimit: this.options.probeLimit,
			domains: Object.entries(state.domains).map(([domain, current]) => ({ domain, ...current })) };
	}
}
