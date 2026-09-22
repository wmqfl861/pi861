import { randomUUID } from "node:crypto";
import type { AssemblyMode } from "../contracts/memory.ts";
import {
	checkPrincipal,
	contextPack,
	digest,
	LocalMemory,
	type MemoryBackend,
	type MemoryItem,
	type MemoryPrincipal,
	type MemoryReceipt,
	type MemorySnapshot,
	type MemoryWrite,
} from "../memory.ts";
import { assembleRecords, toRecord } from "../memory-records.ts";
import { abortable } from "./deadline.ts";
import {
	classifyExtractionFailure,
	DEFAULT_BACKOFF_BASE_MS,
	DEFAULT_BACKOFF_CAP_MS,
	DEFAULT_MAX_EXTRACTION_ATTEMPTS,
	type EnrichmentJobView,
	type ExtractionFailureClass,
	failureBackoffMs,
	type MemoryExtractor,
	validateExtractionOutput,
	withheldFailureText,
} from "./extraction.ts";
import type { StateStore } from "./store.ts";

export { DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_CAP_MS, DEFAULT_MAX_EXTRACTION_ATTEMPTS, failureBackoffMs };
export type { EnrichmentJobView, ExtractionFailureClass, MemoryExtractor };

export interface MemoryChange {
	sequence: number;
	scope: string;
	id: string;
	revision: number;
	withdrawn: boolean;
}
export interface Projection {
	sourceRevision: number;
	abstract: string;
	overview: string;
	facts: { text: string; quote: string }[];
	model: string;
	createdAt: number;
}
interface EnrichmentJob {
	id: string;
	scope: string;
	memoryId: string;
	revision: number;
	state: "queued" | "running" | "done" | "obsolete" | "failed";
	attempts: number;
	failures?: number;
	failureClass?: ExtractionFailureClass;
	nextAttemptAt?: number;
	lastError?: string;
	requeues?: number;
	token?: string;
	expiresAt?: number;
	createdAt?: number;
	finishedAt?: number;
}
export interface LayeredMemoryState {
	format: 1;
	sequence: number;
	memory: MemorySnapshot;
	changes: MemoryChange[];
	changesFloor?: number;
	projections: Record<string, Projection>;
	jobs: EnrichmentJob[];
}
export function emptyLayeredMemory(tenantId: string): LayeredMemoryState {
	return {
		format: 1,
		sequence: 0,
		memory: { tenantId, items: [], receipts: [], tombstones: [] },
		changes: [],
		changesFloor: 0,
		projections: {},
		jobs: [],
	};
}
export const DEFAULT_MAX_RETAINED_TERMINAL_JOBS = 512;
export const DEFAULT_MAX_RETAINED_CHANGES = 4096;
function viewJob(job: EnrichmentJob): EnrichmentJobView {
	return {
		id: job.id,
		scope: job.scope,
		memoryId: job.memoryId,
		revision: job.revision,
		state: job.state,
		attempts: job.attempts,
		failures: job.failures ?? 0,
		failureClass: job.failureClass,
		nextAttemptAt: job.nextAttemptAt,
		lastError: job.lastError,
		requeues: job.requeues ?? 0,
		expiresAt: job.expiresAt,
	};
}

/** Authoritative items, derived views and durable extraction jobs share one transaction. */
export class LayeredMemory implements MemoryBackend {
	private readonly store: StateStore<LayeredMemoryState>;
	private readonly principal: MemoryPrincipal;
	private readonly retention: { maxTerminalJobs: number; maxChanges: number };
	constructor(
		store: StateStore<LayeredMemoryState>,
		principal: MemoryPrincipal,
		options: { retention?: { maxTerminalJobs?: number; maxChanges?: number } } = {},
	) {
		checkPrincipal(principal);
		this.store = store;
		this.principal = structuredClone(principal);
		const maxTerminalJobs = options.retention?.maxTerminalJobs ?? DEFAULT_MAX_RETAINED_TERMINAL_JOBS;
		const maxChanges = options.retention?.maxChanges ?? DEFAULT_MAX_RETAINED_CHANGES;
		if (
			!Number.isSafeInteger(maxTerminalJobs) ||
			maxTerminalJobs < 1 ||
			!Number.isSafeInteger(maxChanges) ||
			maxChanges < 1
		) {
			throw new Error("Invalid memory retention policy");
		}
		this.retention = { maxTerminalJobs, maxChanges };
	}
	private local(state: LayeredMemoryState): LocalMemory {
		if (state.format !== 1 || state.memory.tenantId !== this.principal.tenantId)
			throw new Error("Memory store identity mismatch");
		return new LocalMemory(this.principal, state.memory, (next) => {
			state.memory = next;
		});
	}
	/** Bounded growth: terminal jobs and the change log are pruned; a pruned delta range is reported, never skipped silently. */
	private govern(state: LayeredMemoryState): void {
		const terminal = state.jobs.filter(
			(job) => job.state === "done" || job.state === "obsolete" || job.state === "failed",
		);
		const excess = terminal.length - this.retention.maxTerminalJobs;
		if (excess > 0) {
			const remove = new Set(
				[...terminal]
					.sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0))
					.slice(0, excess)
					.map((job) => job.id),
			);
			state.jobs = state.jobs.filter((job) => !remove.has(job.id));
		}
		if (state.changes.length > this.retention.maxChanges) {
			const drop = state.changes.length - this.retention.maxChanges;
			const last = state.changes[drop - 1];
			if (last) state.changesFloor = Math.max(state.changesFloor ?? 0, last.sequence);
			state.changes.splice(0, drop);
		}
	}
	private view(state: LayeredMemoryState, item: MemoryItem): MemoryItem {
		const projection = state.projections[digest([item.scope, item.id])];
		return projection?.sourceRevision === item.revision
			? {
					...structuredClone(item),
					abstract: projection.abstract,
					overview: `${projection.overview}\n[Generated from revision ${item.revision}; original source: ${item.source.ref}]`,
				}
			: structuredClone(item);
	}
	async get(scope: string, id: string): Promise<MemoryItem | undefined> {
		const state = await this.store.read(),
			item = await this.local(state).get(scope, id);
		return item ? this.view(state, item) : undefined;
	}
	async search(query: string, limit = 8): Promise<MemoryItem[]> {
		const state = await this.store.read();
		// Validate the same API constraints as the baseline backend.
		await this.local(state).search(query, limit);
		const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(query.toLowerCase())]
			.filter((entry) => entry.isWordLike)
			.map((entry) => entry.segment);
		return state.memory.items
			.filter((item) => item.status !== "withdrawn" && this.principal.readScopes.includes(item.scope))
			.map((item) => this.view(state, item))
			.map((item) => ({
				item,
				score: words.reduce(
					(score, word) =>
						score + (`${item.abstract}\n${item.overview}\n${item.full}`.toLowerCase().includes(word) ? 1 : 0),
					0,
				),
			}))
			.filter((entry) => entry.score > 0)
			.sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt || a.item.id.localeCompare(b.item.id))
			.slice(0, limit)
			.map((entry) => entry.item);
	}
	async put(input: MemoryWrite): Promise<MemoryReceipt> {
		return this.store.update(async (state) => {
			const before = state.memory.receipts.length;
			const receipt = await this.local(state).put(input);
			if (before === state.memory.receipts.length) return receipt;
			state.changes.push({
				sequence: ++state.sequence,
				scope: input.item.scope,
				id: input.item.id,
				revision: receipt.revision,
				withdrawn: false,
			});
			delete state.projections[digest([input.item.scope, input.item.id])];
			for (const job of state.jobs)
				if (job.scope === input.item.scope && job.memoryId === input.item.id && job.state !== "done")
					job.state = "obsolete";
			if (input.item.source.kind === "user" || input.item.source.kind === "tool") {
				state.jobs.push({
					id: digest([input.item.scope, input.item.id, receipt.revision]),
					scope: input.item.scope,
					memoryId: input.item.id,
					revision: receipt.revision,
					state: "queued",
					attempts: 0,
					failures: 0,
					createdAt: Date.now(),
				});
			}
			this.govern(state);
			return receipt;
		});
	}
	async withdraw(requestId: string, scope: string, id: string, expectedRevision: number): Promise<MemoryReceipt> {
		return this.store.update(async (state) => {
			const before = state.memory.receipts.length;
			const receipt = await this.local(state).withdraw(requestId, scope, id, expectedRevision);
			if (before !== state.memory.receipts.length) {
				state.changes.push({ sequence: ++state.sequence, scope, id, revision: receipt.revision, withdrawn: true });
				delete state.projections[digest([scope, id])];
				for (const job of state.jobs) if (job.scope === scope && job.memoryId === id) job.state = "obsolete";
			}
			this.govern(state);
			return receipt;
		});
	}
	async list(scope: string, afterId = "", limit = 50): Promise<{ items: MemoryItem[]; nextId?: string }> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page limit");
		const state = await this.store.read();
		this.local(state);
		if (!this.principal.readScopes.includes(scope)) return { items: [] };
		const available = state.memory.items
			.filter((item) => item.scope === scope && item.status !== "withdrawn" && item.id > afterId)
			.sort((a, b) => (a.id < b.id ? -1 : 1));
		const items = available.slice(0, limit).map((item) => this.view(state, item));
		return { items, ...(available.length > limit ? { nextId: items.at(-1)?.id } : {}) };
	}
	async delta(afterSequence = 0, limit = 50): Promise<{ changes: MemoryChange[]; cursor: number; hasMore: boolean }> {
		if (
			!Number.isSafeInteger(afterSequence) ||
			afterSequence < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 100
		)
			throw new Error("Invalid memory cursor");
		const state = await this.store.read();
		this.local(state);
		if (afterSequence < (state.changesFloor ?? 0))
			throw new Error("Memory change retention floor exceeded; resynchronize from a full listing");
		const visible = state.changes.filter(
			(item) => item.sequence > afterSequence && this.principal.readScopes.includes(item.scope),
		);
		const changes = visible.slice(0, limit);
		return { changes, cursor: changes.at(-1)?.sequence ?? afterSequence, hasMore: visible.length > limit };
	}
	async pack(query: string, maxBytes = 6000): Promise<ReturnType<typeof contextPack>> {
		const found = await this.search(query, 12);
		return contextPack(found, { level: 1, maxBytes });
	}
	/**
	 * Necessary-state assembly delegated to the C6 packer: fixed constraints enter at
	 * full text, working state at overview depth, everything else contributes an
	 * abstract; boot modes exclude long-term experience by contract.
	 */
	async assemble(
		options: { maxBytes?: number; mode?: AssemblyMode } = {},
	): Promise<ReturnType<typeof assembleRecords>> {
		const maxBytes = options.maxBytes ?? 6000;
		if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid assembly budget");
		const state = await this.store.read();
		this.local(state);
		const records = state.memory.items
			.filter((item) => item.status !== "withdrawn" && this.principal.readScopes.includes(item.scope))
			.map((item) => toRecord(this.view(state, item)));
		return assembleRecords(records, {
			mode: options.mode ?? "startup",
			maxBytes,
			readableScopes: this.principal.readScopes,
		});
	}
	async listJobs(): Promise<EnrichmentJobView[]> {
		const state = await this.store.read();
		this.local(state);
		return state.jobs.filter((job) => this.principal.readScopes.includes(job.scope)).map(viewJob);
	}
	/** Manual recovery path for jobs parked in the terminal failed state. */
	async requeueJob(jobId: string): Promise<EnrichmentJobView> {
		return this.store.update((state) => {
			this.local(state);
			const job = state.jobs.find((job) => job.id === jobId);
			if (!job) throw new Error("Unknown enrichment job");
			if (!this.principal.writeScopes.includes(job.scope)) throw new Error("Memory scope not authorized");
			if (job.state !== "failed") throw new Error("Only failed enrichment jobs can be requeued");
			job.state = "queued";
			job.failures = 0;
			job.requeues = (job.requeues ?? 0) + 1;
			delete job.nextAttemptAt;
			delete job.finishedAt;
			this.govern(state);
			return viewJob(job);
		});
	}
	async enrich(
		extractor: MemoryExtractor,
		options: {
			signal: AbortSignal;
			maxJobs?: number;
			timeoutMs?: number;
			maxAttempts?: number;
			backoffBaseMs?: number;
			backoffCapMs?: number;
			classifyFailure?: (error: unknown) => ExtractionFailureClass;
		},
	): Promise<{ completed: number; failed: number; obsolete: number }> {
		const max = options.maxJobs ?? 4,
			timeoutMs = options.timeoutMs ?? 60_000;
		const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_EXTRACTION_ATTEMPTS;
		const baseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
			capMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
		if (
			!Number.isInteger(max) ||
			max < 1 ||
			max > 100 ||
			timeoutMs < 1 ||
			!Number.isInteger(maxAttempts) ||
			maxAttempts < 1 ||
			maxAttempts > 100 ||
			!Number.isInteger(baseMs) ||
			baseMs < 0 ||
			!Number.isInteger(capMs) ||
			capMs < 1 ||
			baseMs > capMs
		) {
			throw new Error("Invalid enrichment budget");
		}
		const stats = { completed: 0, failed: 0, obsolete: 0 };
		for (let index = 0; index < max; index++) {
			options.signal.throwIfAborted();
			const work = await this.store.update((state) => {
				this.local(state);
				const now = Date.now();
				// queued jobs wait out their backoff; expired running leases from dead workers are reclaimed.
				const job = state.jobs.find(
					(job) =>
						this.principal.writeScopes.includes(job.scope) &&
						((job.state === "queued" && (job.nextAttemptAt ?? 0) <= now) ||
							(job.state === "running" && (job.expiresAt ?? Infinity) <= now)),
				);
				if (!job) return undefined;
				const item = state.memory.items.find((item) => item.scope === job.scope && item.id === job.memoryId);
				if (!item || item.revision !== job.revision || item.status === "withdrawn") {
					job.state = "obsolete";
					job.finishedAt = now;
					this.govern(state);
					return { obsolete: true as const };
				}
				job.state = "running";
				job.attempts++;
				job.token = randomUUID();
				job.expiresAt = now + timeoutMs + 5000;
				job.createdAt ??= now;
				const claimed = structuredClone(job);
				this.govern(state);
				return { obsolete: false as const, job: claimed, item: structuredClone(item) };
			});
			if (!work) break;
			if (work.obsolete) {
				stats.obsolete++;
				continue;
			}
			const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
			try {
				const result = validateExtractionOutput(
					await abortable(
						extractor.extract(
							{ id: work.item.id, revision: work.item.revision, text: work.item.full, source: work.item.source },
							signal,
						),
						signal,
					),
					work.item.full,
				);
				signal.throwIfAborted();
				const projection: Projection = {
					sourceRevision: work.item.revision,
					abstract: result.abstract,
					overview: result.overview,
					facts: result.facts,
					model: extractor.modelId,
					createdAt: Date.now(),
				};
				const committed = await this.store.update((state) => {
					const job = state.jobs.find((job) => job.id === work.job.id);
					const item = state.memory.items.find(
						(item) => item.scope === work.item.scope && item.id === work.item.id,
					);
					if (
						job?.state !== "running" ||
						job.token !== work.job.token ||
						(job.expiresAt ?? 0) <= Date.now() ||
						!item ||
						item.revision !== work.item.revision ||
						item.status === "withdrawn"
					)
						return false;
					state.projections[digest([item.scope, item.id])] = projection;
					job.state = "done";
					delete job.token;
					delete job.expiresAt;
					job.finishedAt = Date.now();
					// Derived-view publication is also a change: peers refresh the view without pretending it is new evidence.
					state.changes.push({
						sequence: ++state.sequence,
						scope: item.scope,
						id: item.id,
						revision: item.revision,
						withdrawn: false,
					});
					this.govern(state);
					return true;
				});
				if (committed) stats.completed++;
				else stats.obsolete++;
			} catch (error) {
				const aborted = options.signal.aborted;
				const failureClass: ExtractionFailureClass = aborted
					? "transient"
					: (options.classifyFailure ?? classifyExtractionFailure)(error);
				const message = error instanceof Error ? error.message : "Extraction failed";
				await this.store.update((state) => {
					this.local(state);
					const job = state.jobs.find((job) => job.id === work.job.id);
					if (job?.state === "running" && job.token === work.job.token) {
						delete job.token;
						delete job.expiresAt;
						if (aborted)
							job.state = "queued"; // operator abort releases the lease without consuming the retry budget
						else {
							job.failures = (job.failures ?? 0) + 1;
							job.failureClass = failureClass;
							job.lastError = withheldFailureText(message);
							if (failureClass !== "transient" || (job.failures ?? 0) >= maxAttempts) {
								job.state = "failed";
								job.finishedAt = Date.now();
							} else {
								job.state = "queued";
								job.nextAttemptAt = Date.now() + failureBackoffMs(job.failures, baseMs, capMs);
							}
						}
						this.govern(state);
					}
				});
				if (aborted) throw error;
				stats.failed++;
			}
		}
		return stats;
	}
}
