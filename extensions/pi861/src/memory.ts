import {
	type Authority,
	clone,
	digest,
	type MemoryKind,
	type MemoryRecord,
	type MemoryStatus,
	nonempty,
	requireCondition,
	type SourceEvent,
} from "./core.ts";
import type { StateStore } from "./store.ts";

export interface RememberInput {
	requestId: string;
	key: string;
	scope: string;
	kind: MemoryKind;
	text: string;
	sourceIds: string[];
	expectedRevision?: number;
	expiresAt?: number;
	/** Optional author-provided view, never treated as evidence. */
	abstract?: string;
	overview?: string;
}

function assertScope(authority: Authority, store: StateStore, scope: string, write: boolean): void {
	requireCondition(authority.projectId === store.projectId, "FORBIDDEN", "Project authority mismatch");
	nonempty(scope, "scope", 200);
	requireCondition(
		(write ? authority.writableScopes : authority.readableScopes).includes(scope),
		"FORBIDDEN",
		"Scope is not granted",
	);
}
function safeText(text: string): string {
	const cleaned = nonempty(text, "memory text", 100_000);
	// Defense in depth only, not a complete secret detector. Never collect credentials intentionally.
	requireCondition(
		!/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|authorization|password)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{12,}|sk-[A-Za-z0-9_-]{20,}/i.test(
			cleaned,
		),
		"SENSITIVE_CONTENT",
		"Potential secret detected; redact it before persistence",
	);
	return cleaned;
}
function visible(record: MemoryRecord, authority: Authority, now: number): boolean {
	return (
		authority.readableScopes.includes(record.scope) &&
		record.status !== "withdrawn" &&
		(record.expiresAt === undefined || record.expiresAt > now)
	);
}
function signature(scope: string, _key: string, text: string): string {
	return digest({ scope, text: text.trim().normalize("NFKC") });
}
export interface RecallResult {
	records: MemoryRecord[];
	usedBytes: number;
	omitted: number;
	revision: number;
	/** Exact UTF-8 bound, not a misleading char/4 token estimate for CJK text. */
	budgetBytes: number;
}

export class MemoryService {
	readonly store: StateStore;
	private now: () => number;
	constructor(store: StateStore, now: () => number = Date.now) {
		this.store = store;
		this.now = now;
	}
	async capture(authority: Authority, event: SourceEvent): Promise<{ stored: boolean; id: string }> {
		assertScope(authority, this.store, event.scope, true);
		nonempty(event.id, "source id", 300);
		requireCondition(
			["user", "tool", "assistant", "memory"].includes(event.origin),
			"INVALID_SOURCE",
			"Unknown source origin",
		);
		requireCondition(Number.isFinite(event.createdAt), "INVALID_SOURCE", "Invalid source timestamp");
		if (event.origin === "memory") return { stored: false, id: event.id }; // Never learn our own recall again.
		const text = safeText(event.text);
		return this.store.transact((state) => {
			const old = state.sources.find((source) => source.id === event.id);
			if (old) {
				requireCondition(
					digest(old) === digest({ ...event, text }),
					"SOURCE_CONFLICT",
					"Source id reused for different evidence",
				);
				return { stored: false, id: event.id };
			}
			state.sources.push({ ...clone(event), text });
			return { stored: true, id: event.id };
		});
	}
	async remember(authority: Authority, input: RememberInput): Promise<MemoryRecord> {
		assertScope(authority, this.store, input.scope, true);
		const text = safeText(input.text);
		const key = nonempty(input.key, "memory key", 200);
		nonempty(input.requestId, "requestId", 200);
		requireCondition(
			["preference", "working", "decision", "lesson", "evidence"].includes(input.kind),
			"INVALID_INPUT",
			"Unknown memory kind",
		);
		requireCondition(
			Array.isArray(input.sourceIds) &&
				input.sourceIds.length > 0 &&
				input.sourceIds.every((source) => typeof source === "string" && source.length > 0),
			"SOURCE_REQUIRED",
			"Memory requires concrete source event ids",
		);
		if (input.expiresAt !== undefined)
			requireCondition(
				Number.isFinite(input.expiresAt) && input.expiresAt > this.now(),
				"INVALID_INPUT",
				"Expiry must be in the future",
			);
		const receiptKey = digest({ principal: authority.principalId, request: input.requestId });
		const fingerprint = digest(input);
		return this.store.transact((state) => {
			const receipt = state.receipts[receiptKey];
			if (receipt) {
				requireCondition(
					receipt.fingerprint === fingerprint,
					"IDEMPOTENCY_CONFLICT",
					"Request id has different arguments",
				);
				const record = state.memory.find((item) => item.id === receipt.recordId);
				requireCondition(record, "CORRUPT_STATE", "Committed memory receipt is missing its record");
				// Return its CURRENT status so a replay cannot resurrect/advertise a withdrawn revision.
				return record;
			}
			const sources = input.sourceIds.map((sourceId) => {
				const source = state.sources.find((item) => item.id === sourceId);
				requireCondition(
					source && authority.readableScopes.includes(source.scope),
					"SOURCE_UNAVAILABLE",
					"A source is unavailable to this caller",
				);
				// Conservative default: no implicit promotion of private evidence into a broader scope.
				requireCondition(
					source.scope === input.scope,
					"PROMOTION_REQUIRED",
					"Cross-scope memory publication requires explicit review",
				);
				return source;
			});
			requireCondition(
				!state.withdrawals.includes(signature(input.scope, key, text)),
				"WITHDRAWN_CONTENT",
				"This content was withdrawn; explicit restoration is required",
			);
			const current = state.memory.find((item) => item.scope === input.scope && item.key === key);
			requireCondition(
				input.expectedRevision === (current?.revision ?? 0) || (!current && input.expectedRevision === undefined),
				"REVISION_CONFLICT",
				"Read the current revision before replacing a memory",
			);
			const status: MemoryStatus =
				sources.every((source) => source.origin === "user") && authority.grants.includes("memory.confirm.user")
					? "confirmed"
					: "candidate";
			const timestamp = this.now();
			const record: MemoryRecord = {
				id: current?.id ?? `mem_${digest({ project: state.projectId, scope: input.scope, key }).slice(0, 32)}`,
				key,
				scope: input.scope,
				kind: input.kind,
				text,
				abstract: input.abstract ? nonempty(input.abstract, "abstract", 500) : text.split("\n")[0].slice(0, 160),
				overview: input.overview ? nonempty(input.overview, "overview", 4000) : text.slice(0, 1000),
				sourceIds: [...new Set(input.sourceIds)],
				status,
				revision: (current?.revision ?? 0) + 1,
				createdAt: current?.createdAt ?? timestamp,
				updatedAt: timestamp,
				...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
			};
			if (current) {
				state.memoryHistory.push(clone(current));
				state.withdrawals.push(signature(current.scope, current.key, current.text));
				state.memory[state.memory.indexOf(current)] = record;
			} else state.memory.push(record);
			state.receipts[receiptKey] = {
				fingerprint,
				recordId: record.id,
				revision: record.revision,
				status: "committed",
			};
			return record;
		});
	}
	async confirm(authority: Authority, recordId: string, expectedRevision: number): Promise<MemoryRecord> {
		requireCondition(
			authority.grants.includes("memory.review"),
			"FORBIDDEN",
			"Confirmation requires a trusted reviewer",
		);
		return this.store.transact((state) => {
			const record = state.memory.find((item) => item.id === recordId);
			requireCondition(record, "NOT_FOUND", "Memory not found");
			assertScope(authority, this.store, record.scope, true);
			requireCondition(
				record.revision === expectedRevision && record.status === "candidate",
				"REVISION_CONFLICT",
				"Memory changed or is no longer a candidate",
			);
			state.memoryHistory.push(clone(record));
			record.status = "confirmed";
			record.revision++;
			record.updatedAt = this.now();
			return record;
		});
	}
	async forget(authority: Authority, recordId: string, expectedRevision: number): Promise<MemoryRecord> {
		return this.store.transact((state) => {
			const record = state.memory.find((item) => item.id === recordId);
			requireCondition(record, "NOT_FOUND", "Memory not found");
			assertScope(authority, this.store, record.scope, true);
			requireCondition(record.revision === expectedRevision, "REVISION_CONFLICT", "Memory changed");
			if (record.status === "withdrawn") return record;
			state.memoryHistory.push(clone(record));
			state.withdrawals.push(signature(record.scope, record.key, record.text));
			record.status = "withdrawn";
			record.revision++;
			record.updatedAt = this.now();
			return record;
		});
	}
	async search(
		authority: Authority,
		query: string,
		options: {
			budgetBytes?: number;
			includeCandidates?: boolean;
			level?: 0 | 1 | 2;
			limit?: number;
		} = {},
	): Promise<RecallResult> {
		requireCondition(authority.projectId === this.store.projectId, "FORBIDDEN", "Project authority mismatch");
		const budget = options.budgetBytes ?? 6000;
		const level = options.level ?? 1;
		const limit = options.limit ?? 8;
		requireCondition(
			Number.isSafeInteger(budget) &&
				budget >= 0 &&
				budget <= 100_000 &&
				Number.isSafeInteger(limit) &&
				limit > 0 &&
				limit <= 100 &&
				[0, 1, 2].includes(level),
			"INVALID_INPUT",
			"Invalid recall budget, level or limit",
		);
		const state = await this.store.read();
		const normalized = query.trim().toLocaleLowerCase();
		const words = normalized.split(/\s+/).filter(Boolean);
		// Literal/keyword first version. No claim of semantic ranking or complete recall.
		const scored = state.memory
			.filter(
				(record) =>
					visible(record, authority, this.now()) && (record.status === "confirmed" || options.includeCandidates),
			)
			.map((record) => {
				const haystack = `${record.key} ${record.text}`.toLocaleLowerCase();
				const score =
					normalized === ""
						? 1
						: Number(haystack.includes(normalized)) * 4 + words.filter((word) => haystack.includes(word)).length;
				return { record, score };
			})
			.filter((item) => item.score > 0)
			.sort(
				(a, b) =>
					b.score - a.score || b.record.updatedAt - a.record.updatedAt || a.record.id.localeCompare(b.record.id),
			);
		const records: MemoryRecord[] = [];
		let usedBytes = 0;
		for (const { record } of scored) {
			if (records.length >= limit) break;
			const projected = {
				...clone(record),
				text: level === 0 ? record.abstract : level === 1 ? record.overview : record.text,
			};
			// Do not smuggle full L1/L2 text through unused metadata.
			projected.abstract = "";
			projected.overview = "";
			const bytes = Buffer.byteLength(JSON.stringify(projected), "utf8");
			if (usedBytes + bytes > budget) continue;
			records.push(projected);
			usedBytes += bytes;
		}
		return {
			records,
			usedBytes,
			omitted: scored.length - records.length,
			budgetBytes: budget,
			revision: state.revision,
		};
	}
	async read(
		authority: Authority,
		recordId: string,
		level: 0 | 1 | 2 = 2,
	): Promise<{
		record: MemoryRecord;
		sources: SourceEvent[];
	}> {
		requireCondition(authority.projectId === this.store.projectId, "FORBIDDEN", "Project authority mismatch");
		requireCondition([0, 1, 2].includes(level), "INVALID_INPUT", "Unknown memory level");
		const state = await this.store.read();
		const record = state.memory.find((item) => item.id === recordId && visible(item, authority, this.now()));
		requireCondition(record, "NOT_FOUND", "Memory not found");
		const view = clone(record);
		view.text = level === 0 ? record.abstract : level === 1 ? record.overview : record.text;
		view.abstract = "";
		view.overview = "";
		const sources =
			level === 2
				? state.sources.filter(
						(source) => record.sourceIds.includes(source.id) && authority.readableScopes.includes(source.scope),
					)
				: [];
		return { record: view, sources };
	}
}
