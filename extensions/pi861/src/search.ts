/** Explicitly configured web search; independent of the current reasoning model. */
import { TextDecoder } from "node:util";
import type { PackedResult, ResultMetadata, StoredResultReference } from "./result-store.ts";
import { abortable } from "./web-control.ts";

export interface SearchHit {
	title: string;
	url: string;
	snippet: string;
}
export interface SearchCache {
	hit: false;
	source: "direct";
}
export interface SearchResult {
	query: string;
	provider: string;
	endpoint: string;
	retrievedAt: string;
	results: SearchHit[];
	truncated: boolean;
	complete: boolean;
	untrusted: true;
	/** Trusted host-assigned project/principal scope, never model input. */
	scope: string;
	cache: SearchCache;
}
export interface SearchOptions {
	enabled: boolean;
	apiKey?: string;
	maxResults?: number;
	maxResponseBytes?: number;
	timeoutMs?: number;
	fetch?: typeof fetch;
	provider?: string;
	scope?: string;
	/** Trusted dependency injection; model input cannot register implementations. */
	backend?: SearchBackend;
	/** Recheck authorization and reserve budget immediately before each dispatch. */
	beforeRequest?: (endpoint: string, signal: AbortSignal) => void | Promise<void>;
}
export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
export type SearchFailureCode =
	| "disabled"
	| "not_configured"
	| "not_implemented"
	| "invalid_query"
	| "invalid_limits"
	| "backend_error"
	| "malformed_response"
	| "response_too_large";
export class SearchFailure extends Error {
	readonly code: SearchFailureCode;
	constructor(message: string, code: SearchFailureCode) {
		super(message);
		this.code = code;
	}
}
export interface SearchLimits {
	maxResults: number;
	maxResponseBytes: number;
	timeoutMs: number;
}
export interface SearchBackendContext {
	apiKey?: string;
	fetch?: typeof fetch;
}
export interface BackendSearchResult {
	query: string;
	provider: string;
	retrievedAt: string;
	results: SearchHit[];
	truncated: boolean;
}
/** An adapter makes one request to its declared endpoint; implementations are trusted code. */
export interface SearchBackend {
	readonly id: string;
	readonly endpoint: string;
	capabilities(): { maxResults: { min: number; max: number }; requiresApiKey: boolean };
	search(
		query: string,
		limits: SearchLimits,
		context: SearchBackendContext,
		signal: AbortSignal,
	): Promise<BackendSearchResult>;
}
function clean(value: unknown, max: number): string {
	return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").slice(0, max) : "";
}
async function limitedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
	if (!response.body) throw new SearchFailure("Search returned an empty body", "malformed_response");
	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let text = "",
		bytes = 0;
	try {
		while (true) {
			const { value, done } = await abortable(reader.read(), signal);
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes)
				throw new SearchFailure("Search response exceeds configured byte limit", "response_too_large");
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		try {
			return JSON.parse(text) as unknown;
		} catch {
			throw new SearchFailure("Malformed search response", "malformed_response");
		}
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
const braveBackend: SearchBackend = {
	id: "brave",
	endpoint: "https://api.search.brave.com/res/v1/web/search",
	capabilities: () => ({ maxResults: { min: 1, max: 10 }, requiresApiKey: true }),
	async search(query, limits, context, signal) {
		const endpoint = new URL(this.endpoint);
		endpoint.searchParams.set("q", query.trim());
		endpoint.searchParams.set("count", String(limits.maxResults));
		const response = await (context.fetch ?? fetch)(endpoint, {
			headers: { Accept: "application/json", "X-Subscription-Token": context.apiKey ?? "" },
			signal,
			redirect: "error", // Credentials never follow a redirect.
		});
		if (signal.aborted || !response.ok) {
			void response.body?.cancel().catch(() => {});
			signal.throwIfAborted();
			throw new SearchFailure(`Search backend returned HTTP ${response.status}`, "backend_error");
		}
		const json = record(await limitedJson(response, limits.maxResponseBytes, signal));
		const web = record(json?.web),
			hits = web?.results;
		if (hits !== undefined && !Array.isArray(hits))
			throw new SearchFailure("Malformed search response", "malformed_response");
		if (!json || !web) throw new SearchFailure("Search response lacks web results", "malformed_response");
		const results: SearchHit[] = [];
		let truncated = Array.isArray(hits) && hits.length > limits.maxResults;
		for (const hit of Array.isArray(hits) ? hits.slice(0, limits.maxResults) : []) {
			const item = record(hit);
			if (!item || typeof item.url !== "string")
				throw new SearchFailure("Malformed search hit", "malformed_response");
			let url: URL;
			try {
				url = new URL(item.url);
			} catch {
				truncated = true;
				continue;
			}
			if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
				truncated = true;
				continue;
			}
			const title = clean(item.title, 300),
				snippet = clean(item.description, 2000);
			if (
				(typeof item.title === "string" && title !== item.title) ||
				(typeof item.description === "string" && snippet !== item.description)
			)
				truncated = true;
			results.push({ title, url: url.toString(), snippet });
		}
		signal.throwIfAborted();
		return { query: query.trim(), provider: "brave", retrievedAt: new Date().toISOString(), results, truncated };
	},
};
const searchBackends: ReadonlyMap<string, SearchBackend> = new Map([["brave", braveBackend]]);
export function availableSearchProviders(): string[] {
	return [...searchBackends.keys()];
}

export async function webSearch(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
	if (!options.enabled)
		throw new SearchFailure("Web search is disabled; configure PI861_WEB_SEARCH_ENABLED=1", "disabled");
	const provider = options.provider ?? options.backend?.id ?? "brave";
	const backend = options.backend?.id === provider ? options.backend : searchBackends.get(provider);
	if (!backend)
		throw new SearchFailure(
			`Search backend "${provider}" is not implemented; available: ${availableSearchProviders().join(", ")}`,
			"not_implemented",
		);
	const capabilities = backend.capabilities();
	if (capabilities.requiresApiKey && !options.apiKey?.trim())
		throw new SearchFailure("Missing BRAVE_SEARCH_API_KEY", "not_configured");
	// Capture the endpoint of the backend that will actually execute before dispatch. The
	// captured value is immutable for this call and for every reference it produces; neither a
	// payload field nor later backend configuration can rewrite it.
	const endpoint = backend.endpoint;
	if (typeof query !== "string" || !query.trim() || query.length > 600 || query.trim().split(/\s+/).length > 75)
		throw new SearchFailure("Search query must contain 1-600 characters and at most 75 words", "invalid_query");
	const count = options.maxResults ?? 5,
		maxBytes = options.maxResponseBytes ?? 262_144,
		timeoutMs = options.timeoutMs ?? 15_000;
	if (
		!Number.isSafeInteger(count) ||
		count < capabilities.maxResults.min ||
		count > capabilities.maxResults.max ||
		count > 100 ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1024 ||
		maxBytes > 16_777_216 ||
		!Number.isSafeInteger(timeoutMs) ||
		timeoutMs < 1 ||
		timeoutMs > 300_000
	)
		throw new SearchFailure("Invalid search limits", "invalid_limits");
	signal?.throwIfAborted();
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error("Search deadline")), timeoutMs);
	const effective = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
	try {
		if (options.beforeRequest)
			await abortable(Promise.resolve(options.beforeRequest(backend.endpoint, effective)), effective);
		effective.throwIfAborted();
		try {
			const found = await abortable(
				backend.search(
					query,
					{ maxResults: count, maxResponseBytes: maxBytes, timeoutMs },
					{ apiKey: options.apiKey, fetch: options.fetch },
					effective,
				),
				effective,
			);
			effective.throwIfAborted();
			return {
				...found,
				// The result binds the identity of the backend that actually executed; adapter
				// payload fields cannot claim a different provider or endpoint.
				provider: backend.id,
				endpoint,
				complete: !found.truncated,
				untrusted: true,
				scope: options.scope ?? "",
				cache: { hit: false, source: "direct" },
			};
		} catch (error) {
			if (signal?.aborted) throw signal.reason;
			if (error instanceof SearchFailure) throw error;
			throw new SearchFailure(
				deadline.signal.aborted ? "Search backend request timed out" : "Search backend request failed",
				"backend_error",
			);
		}
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Structural packing seam: satisfied by the default in-memory ResultStore (session lifetime
 * only, never persistence) and by future persistent reference backends injected by the
 * integrator (P2-M reference service). The public class shape stays in result-store.ts.
 */
interface ReferenceStore {
	store(text: string, owner: string, metadata?: ResultMetadata): StoredResultReference;
}
/** A reference retains metadata and source completeness for subsequent authorized pages. */
export function packSearchResult(
	result: SearchResult,
	store: ReferenceStore | undefined,
	owner: string,
	inlineLimit = 32_000,
): PackedResult {
	if (!Number.isSafeInteger(inlineLimit) || inlineLimit < 1) throw new Error("Invalid inline limit");
	const serialized = JSON.stringify(result);
	const bytes = Buffer.byteLength(serialized, "utf8");
	if (bytes <= inlineLimit) return { inline: true, text: serialized, bytes };
	if (!store) throw new Error("Result exceeds the inline limit and no controlled-reference store is configured");
	// The reference binds the endpoint of the backend that actually executed (never a fixed
	// Brave URL), so every later page re-authorizes against the real source of the data.
	return {
		inline: false,
		...store.store(serialized, owner, {
			kind: "search",
			scope: result.scope,
			url: result.endpoint,
			sourceComplete: result.complete,
		}),
		complete: false,
	};
}
