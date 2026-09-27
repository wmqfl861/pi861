import { isValidScope } from "./contracts/identity.ts";
import { digest, type MemoryItem, type MemoryReceipt, type MemoryWrite } from "./memory.ts";

export interface ResultMetadata {
	kind: "search" | "web-read";
	scope: string;
	url: string;
	sourceComplete: boolean;
}
export interface StoredResultPage {
	resultRef: string;
	text: string;
	offset: number;
	nextOffset: number;
	totalCharacters: number;
	/** Last stored page; sourceComplete separately describes the original response. */
	complete: boolean;
	sourceComplete: boolean;
	untrusted: true;
}
export interface StoredResultReference {
	resultRef: string;
	bytes: number;
	totalCharacters: number;
}
export interface ResultStoreOptions {
	pageSize?: number;
	maxEntries?: number;
	maxCharacters?: number;
	maxTotalCharacters?: number;
}
/** Session-local bounded storage. The host rechecks current grants before every read. */
export class ResultStore {
	private readonly entries = new Map<string, { text: string; owner: string; metadata?: ResultMetadata }>();
	private readonly pageSize: number;
	private readonly maxEntries: number;
	private readonly maxCharacters: number;
	private readonly maxTotalCharacters: number;
	private characters = 0;
	constructor(options: ResultStoreOptions = {}) {
		this.pageSize = options.pageSize ?? 16_000;
		this.maxEntries = options.maxEntries ?? 256;
		this.maxCharacters = options.maxCharacters ?? 4_194_304;
		this.maxTotalCharacters = options.maxTotalCharacters ?? 16_777_216;
		if (
			[this.pageSize, this.maxEntries, this.maxCharacters, this.maxTotalCharacters].some(
				(value) => !Number.isSafeInteger(value) || value < 1,
			)
		)
			throw new Error("Invalid result store limits");
	}
	store(text: string, owner: string, metadata?: ResultMetadata): StoredResultReference {
		if (!owner) throw new Error("Result owner identity required");
		if (text.length > this.maxCharacters || text.length > this.maxTotalCharacters)
			throw new Error("Result exceeds controlled-reference storage limit");
		const resultRef = digest({ value: text, owner, metadata: metadata ?? null });
		if (!this.entries.has(resultRef)) {
			while (this.entries.size >= this.maxEntries || this.characters + text.length > this.maxTotalCharacters) {
				const oldest = this.entries.keys().next().value;
				if (oldest === undefined) break;
				this.revoke(oldest);
			}
			this.entries.set(resultRef, { text, owner, metadata: metadata ? { ...metadata } : undefined });
			this.characters += text.length;
		}
		return { resultRef, bytes: Buffer.byteLength(text, "utf8"), totalCharacters: text.length };
	}
	metadata(resultRef: string, owner: string): ResultMetadata | undefined {
		const entry = this.entries.get(resultRef);
		if (!entry || entry.owner !== owner) throw new Error("Result not found");
		return entry.metadata ? { ...entry.metadata } : undefined;
	}
	read(resultRef: string, owner: string, offset = 0): StoredResultPage {
		const entry = this.entries.get(resultRef);
		if (!entry || entry.owner !== owner) throw new Error("Result not found");
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > entry.text.length)
			throw new Error("Invalid result offset");
		return {
			resultRef,
			text: entry.text.slice(offset, offset + this.pageSize),
			offset,
			nextOffset: Math.min(entry.text.length, offset + this.pageSize),
			totalCharacters: entry.text.length,
			complete: offset + this.pageSize >= entry.text.length,
			sourceComplete: entry.metadata?.sourceComplete ?? true,
			untrusted: true,
		};
	}
	revoke(resultRef: string): void {
		const entry = this.entries.get(resultRef);
		if (entry) this.characters -= entry.text.length;
		this.entries.delete(resultRef);
	}
	clear(): void {
		this.entries.clear();
		this.characters = 0;
	}
}
export type PackedResult =
	| { inline: true; text: string; bytes: number }
	| { inline: false; resultRef: string; bytes: number; totalCharacters: number; complete: false };
export function packResult(
	text: string,
	owner: string,
	options: { store?: ResultStore; inlineLimit?: number; metadata?: ResultMetadata } = {},
): PackedResult {
	const inlineLimit = options.inlineLimit ?? 32_000;
	if (!Number.isSafeInteger(inlineLimit) || inlineLimit < 1) throw new Error("Invalid inline limit");
	if (Buffer.byteLength(text, "utf8") <= inlineLimit)
		return { inline: true, text, bytes: Buffer.byteLength(text, "utf8") };
	if (!options.store)
		throw new Error("Result exceeds the inline limit and no controlled-reference store is configured");
	return { inline: false, ...options.store.store(text, owner, options.metadata), complete: false };
}

// ---------------------------------------------------------------------------
// P2-M durable controlled-reference backend (C7). The session-local ResultStore
// above is the P2-E inline seam; entries die with the host process. This backend
// stores the payload through the memory authority (P2-D record model) so an
// existing reference stays readable across sessions and nodes, and a withdrawal
// (grant loss, revocation) makes later reads fail uniformly on every node -
// missing, revoked and out-of-scope references are indistinguishable.
// ---------------------------------------------------------------------------

/** Wider descriptor shape; a web `ResultMetadata` satisfies it structurally. */
export interface ResultDescriptor {
	kind: string;
	scope: string;
	url?: string;
	tool?: string;
	sourceComplete: boolean;
}

/** Minimal authority surface satisfied by LayeredMemory, PostgresMemory and StorageSession. */
export interface PersistentResultAuthority {
	get(scope: string, id: string): Promise<MemoryItem | undefined>;
	put(input: MemoryWrite): Promise<MemoryReceipt>;
	withdraw(requestId: string, scope: string, id: string, expectedRevision: number): Promise<MemoryReceipt>;
}

export interface PersistentResultOptions {
	/** Canonical scopes probed on read; only records in a readable scope resolve. */
	scopes: string[];
	pageSize?: number;
	maxCharacters?: number;
}

/** Records cap at MAX_MEMORY_BYTES; chunk with margin so descriptor overhead never overflows. */
const PERSISTENT_CHUNK_BYTES = 240_000;
export const PERSISTENT_RESULT_MAX_CHARACTERS = 4_194_304;

interface StoredDescriptor {
	format: 1;
	reference: { resultRef: string; owner: string; bytes: number; totalCharacters: number };
	descriptor: ResultDescriptor;
	lengths: number[];
}

function splitByBytes(text: string, maxBytes: number): string[] {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return [text];
	const chunks: string[] = [];
	let start = 0;
	while (start < text.length) {
		let end = Math.min(text.length, start + maxBytes);
		while (end > start && Buffer.byteLength(text.slice(start, end), "utf8") > maxBytes) end--;
		// Never split a surrogate pair: a combined code point at end-1 means the boundary sits inside one.
		if (end > start && end < text.length && (text.codePointAt(end - 1) ?? 0) > 0xffff) end--;
		if (end <= start) throw new Error("Result chunk budget too small for a single character");
		chunks.push(text.slice(start, end));
		start = end;
	}
	return chunks;
}

function chunkIdentity(owner: string, resultRef: string, index: number): string {
	return digest(["pi861.result.chunk", owner, resultRef, index]);
}

function storedDescriptor(item: MemoryItem): StoredDescriptor | undefined {
	try {
		const parsed: unknown = JSON.parse(item.overview);
		if (!parsed || typeof parsed !== "object") return undefined;
		const body = parsed as Partial<StoredDescriptor>;
		const reference = body.reference as Partial<StoredDescriptor["reference"]> | undefined;
		const descriptor = body.descriptor as Partial<ResultDescriptor> | undefined;
		if (
			body.format !== 1 ||
			typeof reference?.resultRef !== "string" ||
			typeof reference.owner !== "string" ||
			typeof reference.bytes !== "number" ||
			!Number.isSafeInteger(reference.bytes) ||
			typeof reference.totalCharacters !== "number" ||
			!Number.isSafeInteger(reference.totalCharacters) ||
			!descriptor ||
			typeof descriptor.kind !== "string" ||
			typeof descriptor.scope !== "string" ||
			descriptor.scope !== item.scope ||
			typeof descriptor.sourceComplete !== "boolean" ||
			!Array.isArray(body.lengths) ||
			!body.lengths.every((length) => typeof length === "number" && Number.isSafeInteger(length) && length >= 0)
		)
			return undefined;
		return {
			format: 1,
			reference: {
				resultRef: reference.resultRef,
				owner: reference.owner,
				bytes: reference.bytes,
				totalCharacters: reference.totalCharacters,
			},
			descriptor: {
				kind: descriptor.kind,
				scope: descriptor.scope,
				...(descriptor.url !== undefined ? { url: String(descriptor.url) } : {}),
				...(descriptor.tool !== undefined ? { tool: String(descriptor.tool) } : {}),
				sourceComplete: descriptor.sourceComplete,
			},
			lengths: body.lengths as number[],
		};
	} catch {
		return undefined;
	}
}

/**
 * Durable controlled references over the memory authority. Content is chunked
 * into bounded evidence records; the resultRef formula matches the session-local
 * store (digest of value+owner+metadata) so a reference minted inline resolves
 * to the same durable record once persisted.
 */
export class PersistentResultStore {
	private readonly backend: PersistentResultAuthority;
	private readonly scopes: string[];
	private readonly pageSize: number;
	private readonly maxCharacters: number;
	constructor(backend: PersistentResultAuthority, options: PersistentResultOptions) {
		if (
			!options.scopes.length ||
			!options.scopes.every(isValidScope) ||
			new Set(options.scopes).size !== options.scopes.length
		)
			throw new Error("Persistent result scopes must be distinct canonical scopes");
		const pageSize = options.pageSize ?? 16_000;
		const maxCharacters = options.maxCharacters ?? PERSISTENT_RESULT_MAX_CHARACTERS;
		if (
			!Number.isSafeInteger(pageSize) ||
			pageSize < 1 ||
			!Number.isSafeInteger(maxCharacters) ||
			maxCharacters < 1 ||
			maxCharacters > PERSISTENT_RESULT_MAX_CHARACTERS
		)
			throw new Error("Invalid persistent result limits");
		this.backend = backend;
		this.scopes = [...options.scopes];
		this.pageSize = pageSize;
		this.maxCharacters = maxCharacters;
	}

	/**
	 * Persists the payload as bounded evidence records. Identical re-stores are
	 * idempotent: the reference is content-addressed, missing chunks are written
	 * and existing ones are left untouched (crash-safe fill-in, never an overwrite).
	 */
	async store(text: string, owner: string, descriptor: ResultDescriptor): Promise<StoredResultReference> {
		if (!owner) throw new Error("Result owner identity required");
		if (!text.length || text.length > this.maxCharacters)
			throw new Error("Result exceeds controlled-reference storage limit");
		if (!descriptor.kind || !isValidScope(descriptor.scope) || typeof descriptor.sourceComplete !== "boolean")
			throw new Error("Invalid result descriptor");
		// Same digest input as the session-local store when descriptor is a web ResultMetadata.
		const resultRef = digest({ value: text, owner, metadata: descriptor });
		const chunks = splitByBytes(text, PERSISTENT_CHUNK_BYTES);
		const stored: StoredDescriptor = {
			format: 1,
			reference: { resultRef, owner, bytes: Buffer.byteLength(text, "utf8"), totalCharacters: text.length },
			descriptor,
			lengths: chunks.map((chunk) => chunk.length),
		};
		let complete = true;
		for (const [index, chunk] of chunks.entries()) {
			const id = chunkIdentity(owner, resultRef, index);
			const existing = await this.backend.get(descriptor.scope, id);
			if (existing) continue;
			complete = false;
			const item = {
				id,
				scope: descriptor.scope,
				kind: "evidence" as const,
				status: "candidate" as const,
				abstract: `Controlled result reference ${resultRef.slice(0, 12)} part ${index + 1}/${chunks.length}`,
				overview: JSON.stringify(stored),
				full: chunk,
				source: { kind: "tool" as const, ref: `result:${resultRef}` },
			};
			await this.backend.put({
				requestId: digest(["pi861.result.put", owner, resultRef, index]),
				expectedRevision: null,
				item,
			});
		}
		if (complete)
			return { resultRef, bytes: stored.reference.bytes, totalCharacters: stored.reference.totalCharacters };
		const first = await this.backend.get(descriptor.scope, chunkIdentity(owner, resultRef, 0));
		if (!first) throw new Error("Controlled reference chunk missing after write");
		return { resultRef, bytes: stored.reference.bytes, totalCharacters: stored.reference.totalCharacters };
	}

	/** Uniformly fails for unknown, foreign-owner, withdrawn and out-of-scope references. */
	async read(resultRef: string, owner: string, offset = 0): Promise<StoredResultPage> {
		const located = await this.locate(resultRef, owner);
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > located.lengths.reduce((a, b) => a + b, 0))
			throw new Error("Invalid result offset");
		let page = "";
		let chunkStart = 0;
		for (const [index, length] of located.lengths.entries()) {
			const chunkEnd = chunkStart + length;
			if (chunkEnd <= offset) {
				chunkStart = chunkEnd;
				continue;
			}
			const item = await this.mustRead(located.scope, chunkIdentity(owner, resultRef, index), resultRef);
			const from = Math.max(0, offset - chunkStart);
			page += item.full.slice(from, from + (this.pageSize - page.length));
			chunkStart = chunkEnd;
			if (page.length >= this.pageSize) break;
		}
		const totalCharacters = located.lengths.reduce((a, b) => a + b, 0);
		return {
			resultRef,
			text: page,
			offset,
			nextOffset: Math.min(totalCharacters, offset + page.length),
			totalCharacters,
			complete: offset + page.length >= totalCharacters,
			sourceComplete: located.descriptor.sourceComplete,
			untrusted: true,
		};
	}

	async metadata(resultRef: string, owner: string): Promise<ResultDescriptor> {
		const located = await this.locate(resultRef, owner);
		return { ...located.descriptor };
	}

	/**
	 * Revocation through the record model: every chunk is withdrawn, so the
	 * tombstone propagates on every node and later reads fail uniformly.
	 * Returns the number of live chunks withdrawn; revoking an already-revoked
	 * (or unknown) reference is an idempotent no-op returning zero.
	 */
	async revoke(requestId: string, resultRef: string, owner: string): Promise<number> {
		let located: Awaited<ReturnType<PersistentResultStore["locate"]>>;
		try {
			located = await this.locate(resultRef, owner);
		} catch (error) {
			if (error instanceof Error && error.message === "Result not found") return 0;
			throw error;
		}
		let withdrawn = 0;
		for (const index of located.lengths.keys()) {
			const id = chunkIdentity(owner, resultRef, index);
			const item = await this.backend.get(located.scope, id);
			if (!item) continue;
			await this.backend.withdraw(`${requestId}:${index}`, located.scope, id, item.revision);
			withdrawn++;
		}
		return withdrawn;
	}

	private async locate(
		resultRef: string,
		owner: string,
	): Promise<{ scope: string; descriptor: ResultDescriptor; lengths: number[] }> {
		if (!resultRef || !owner) throw new Error("Result not found");
		for (const scope of this.scopes) {
			const item = await this.backend.get(scope, chunkIdentity(owner, resultRef, 0));
			if (!item) continue;
			const stored = storedDescriptor(item);
			if (
				!stored ||
				stored.reference.resultRef !== resultRef ||
				stored.reference.owner !== owner ||
				stored.lengths.some((length) => length > PERSISTENT_CHUNK_BYTES + 4)
			)
				throw new Error("Result not found");
			return { scope, descriptor: stored.descriptor, lengths: stored.lengths };
		}
		throw new Error("Result not found");
	}

	private async mustRead(scope: string, id: string, resultRef: string): Promise<MemoryItem> {
		const item = await this.backend.get(scope, id);
		if (!item || item.source.ref !== `result:${resultRef}`) throw new Error("Result not found");
		return item;
	}
}
