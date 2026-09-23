import { digest } from "./memory.ts";

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
