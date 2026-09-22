import { abortable } from "./deadline.ts";
import { randomUUID } from "node:crypto";
import { checkPrincipal, contextPack, digest, LocalMemory, type MemoryBackend, type MemoryInput, type MemoryItem, type MemoryPrincipal, type MemoryReceipt, type MemorySnapshot, type MemoryWrite } from "../memory.ts";
import { record } from "../search.ts";
import type { StateStore } from "./store.ts";

export interface MemoryChange { sequence: number; scope: string; id: string; revision: number; withdrawn: boolean; }
export interface Projection {
	sourceRevision: number; abstract: string; overview: string;
	facts: { text: string; quote: string }[]; model: string; createdAt: number;
}
interface EnrichmentJob {
	id: string; scope: string; memoryId: string; revision: number;
	state: "queued" | "running" | "done" | "obsolete" | "failed";
	attempts: number; token?: string; expiresAt?: number;
}
export interface LayeredMemoryState {
	format: 1; sequence: number; memory: MemorySnapshot;
	changes: MemoryChange[]; projections: Record<string, Projection>; jobs: EnrichmentJob[];
}
export function emptyLayeredMemory(tenantId: string): LayeredMemoryState {
	return { format: 1, sequence: 0, memory: { tenantId, items: [], receipts: [], tombstones: [] }, changes: [], projections: {}, jobs: [] };
}
export interface MemoryExtractor {
	modelId: string;
	extract(input: { id: string; revision: number; text: string; source: MemoryInput["source"] }, signal: AbortSignal): Promise<unknown>;
}

/** Authoritative items, derived views and durable extraction jobs share one transaction. */
export class LayeredMemory implements MemoryBackend {
	private readonly store: StateStore<LayeredMemoryState>;
	private readonly principal: MemoryPrincipal;
	constructor(store: StateStore<LayeredMemoryState>, principal: MemoryPrincipal) {
		checkPrincipal(principal); this.store = store; this.principal = structuredClone(principal);
	}
	private local(state: LayeredMemoryState): LocalMemory {
		if (state.format !== 1 || state.memory.tenantId !== this.principal.tenantId) throw new Error("Memory store identity mismatch");
		return new LocalMemory(this.principal, state.memory, (next) => { state.memory = next; });
	}
	private view(state: LayeredMemoryState, item: MemoryItem): MemoryItem {
		const projection = state.projections[digest([item.scope, item.id])];
		return projection?.sourceRevision === item.revision ? {
			...structuredClone(item), abstract: projection.abstract,
			overview: `${projection.overview}\n[Generated from revision ${item.revision}; original source: ${item.source.ref}]`,
		} : structuredClone(item);
	}
	async get(scope: string, id: string): Promise<MemoryItem | undefined> {
		const state = await this.store.read(), item = await this.local(state).get(scope, id);
		return item ? this.view(state, item) : undefined;
	}
	async search(query: string, limit = 8): Promise<MemoryItem[]> {
		const state = await this.store.read();
		// Validate the same API constraints as the baseline backend.
		await this.local(state).search(query, limit);
		const words = [...new Intl.Segmenter(undefined, { granularity: "word" }).segment(query.toLowerCase())]
			.filter((entry) => entry.isWordLike).map((entry) => entry.segment);
		return state.memory.items.filter((item) => item.status !== "withdrawn" && this.principal.readScopes.includes(item.scope))
			.map((item) => this.view(state, item)).map((item) => ({ item, score: words.reduce((score, word) => score +
				(`${item.abstract}\n${item.overview}\n${item.full}`.toLowerCase().includes(word) ? 1 : 0), 0) }))
			.filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt || a.item.id.localeCompare(b.item.id))
			.slice(0, limit).map((entry) => entry.item);
	}
	async put(input: MemoryWrite): Promise<MemoryReceipt> {
		return this.store.update(async (state) => {
			const before = state.memory.receipts.length;
			const receipt = await this.local(state).put(input);
			if (before === state.memory.receipts.length) return receipt;
			state.changes.push({ sequence: ++state.sequence, scope: input.item.scope, id: input.item.id, revision: receipt.revision, withdrawn: false });
			delete state.projections[digest([input.item.scope, input.item.id])];
			for (const job of state.jobs) if (job.scope === input.item.scope && job.memoryId === input.item.id && job.state !== "done") job.state = "obsolete";
			if (input.item.source.kind === "user" || input.item.source.kind === "tool") {
				state.jobs.push({ id: digest([input.item.scope, input.item.id, receipt.revision]), scope: input.item.scope,
					memoryId: input.item.id, revision: receipt.revision, state: "queued", attempts: 0 });
			}
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
			return receipt;
		});
	}
	async list(scope: string, afterId = "", limit = 50): Promise<{ items: MemoryItem[]; nextId?: string }> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page limit");
		const state = await this.store.read(); this.local(state);
		if (!this.principal.readScopes.includes(scope)) return { items: [] };
		const available = state.memory.items.filter((item) => item.scope === scope && item.status !== "withdrawn" && item.id > afterId)
			.sort((a, b) => a.id < b.id ? -1 : 1);
		const items = available.slice(0, limit).map((item) => this.view(state, item));
		return { items, ...(available.length > limit ? { nextId: items.at(-1)?.id } : {}) };
	}
	async delta(afterSequence = 0, limit = 50): Promise<{ changes: MemoryChange[]; cursor: number; hasMore: boolean }> {
		if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid memory cursor");
		const state = await this.store.read(); this.local(state);
		const visible = state.changes.filter((item) => item.sequence > afterSequence && this.principal.readScopes.includes(item.scope));
		const changes = visible.slice(0, limit);
		return { changes, cursor: changes.at(-1)?.sequence ?? afterSequence, hasMore: visible.length > limit };
	}
	async pack(query: string, maxBytes = 6000): Promise<ReturnType<typeof contextPack>> {
		const found = await this.search(query, 12);
		return contextPack(found, { level: 1, maxBytes });
	}
	async enrich(extractor: MemoryExtractor, options: { signal: AbortSignal; maxJobs?: number; timeoutMs?: number }): Promise<{ completed: number; failed: number; obsolete: number }> {
		const max = options.maxJobs ?? 4, timeoutMs = options.timeoutMs ?? 60_000;
		if (!Number.isInteger(max) || max < 1 || max > 100 || timeoutMs < 1) throw new Error("Invalid enrichment budget");
		const stats = { completed: 0, failed: 0, obsolete: 0 };
		for (let index = 0; index < max; index++) {
			options.signal.throwIfAborted();
			const work = await this.store.update((state) => {
				this.local(state);
				const job = state.jobs.find((job) => this.principal.writeScopes.includes(job.scope) && job.attempts < 3 &&
					(job.state === "queued" || job.state === "running" && (job.expiresAt ?? Infinity) <= Date.now()));
				if (!job) return undefined;
				const item = state.memory.items.find((item) => item.scope === job.scope && item.id === job.memoryId);
				if (!item || item.revision !== job.revision || item.status === "withdrawn") { job.state = "obsolete"; return { obsolete: true as const }; }
				job.state = "running"; job.attempts++; job.token = randomUUID(); job.expiresAt = Date.now() + timeoutMs + 5000;
				return { obsolete: false as const, job: structuredClone(job), item: structuredClone(item) };
			});
			if (!work) break;
			if (work.obsolete) { stats.obsolete++; continue; }
			const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
			try {
				const result = record(await abortable(extractor.extract({ id: work.item.id, revision: work.item.revision, text: work.item.full, source: work.item.source }, signal), signal));
				signal.throwIfAborted();
				if (!result || typeof result.abstract !== "string" || !result.abstract.trim() || result.abstract.length > 600 ||
					typeof result.overview !== "string" || !result.overview.trim() || result.overview.length > 6000 || !Array.isArray(result.facts) || result.facts.length > 20) throw new Error("Invalid extraction output");
				const facts = result.facts.map((raw) => {
					const fact = record(raw);
					if (!fact || typeof fact.text !== "string" || !fact.text.trim() || fact.text.length > 2000 || typeof fact.quote !== "string" ||
						!fact.quote.trim() || !work.item.full.includes(fact.quote)) throw new Error("Extraction lacks a literal source quotation");
					return { text: fact.text, quote: fact.quote };
				});
				const projection: Projection = { sourceRevision: work.item.revision, abstract: result.abstract, overview: result.overview, facts, model: extractor.modelId, createdAt: Date.now() };
				const committed = await this.store.update((state) => {
					const job = state.jobs.find((job) => job.id === work.job.id);
					const item = state.memory.items.find((item) => item.scope === work.item.scope && item.id === work.item.id);
					if (job?.state !== "running" || job.token !== work.job.token || (job.expiresAt ?? 0) <= Date.now() ||
						!item || item.revision !== work.item.revision || item.status === "withdrawn") return false;
					state.projections[digest([item.scope, item.id])] = projection;
					job.state = "done"; delete job.token; delete job.expiresAt;
					// Derived-view publication is also a change: peers refresh the view without pretending it is new evidence.
					state.changes.push({ sequence: ++state.sequence, scope: item.scope, id: item.id, revision: item.revision, withdrawn: false });
					return true;
				});
				if (committed) stats.completed++; else stats.obsolete++;
			} catch (error) {
				await this.store.update((state) => {
					const job = state.jobs.find((job) => job.id === work.job.id);
					if (job?.state === "running" && job.token === work.job.token) { job.state = "failed"; delete job.token; delete job.expiresAt; }
				});
				stats.failed++;
				if (options.signal.aborted) throw error;
			}
		}
		return stats;
	}
}
