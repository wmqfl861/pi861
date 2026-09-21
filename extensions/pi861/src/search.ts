/** Explicitly configured web search; no dependency on the current reasoning model. */
export interface SearchHit { title: string; url: string; snippet: string; }
export interface SearchResult {
	query: string;
	provider: "brave";
	retrievedAt: string;
	results: SearchHit[];
	truncated: boolean;
}
export interface SearchOptions {
	enabled: boolean;
	apiKey?: string;
	maxResults?: number;
	maxResponseBytes?: number;
	timeoutMs?: number;
	fetch?: typeof fetch;
}
export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function clean(value: unknown, max: number): string {
	return typeof value === "string" ? value.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "").slice(0, max) : "";
}
async function limitedJson(response: Response, maxBytes: number): Promise<unknown> {
	if (!response.body) throw new Error("Search returned an empty body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error("Search response exceeds configured byte limit");
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
		return JSON.parse(text) as unknown;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
export async function webSearch(query: string, options: SearchOptions, signal?: AbortSignal): Promise<SearchResult> {
	if (!options.enabled) throw new Error("Web search is disabled; configure PI861_WEB_SEARCH_ENABLED=1");
	if (!options.apiKey?.trim()) throw new Error("Missing BRAVE_SEARCH_API_KEY");
	if (!query.trim() || query.length > 600 || query.trim().split(/\s+/).length > 75) throw new Error("Search query must contain 1-600 characters and at most 75 words");
	const count = options.maxResults ?? 5;
	const maxBytes = options.maxResponseBytes ?? 262_144;
	const timeoutMs = options.timeoutMs ?? 15_000;
	if (!Number.isSafeInteger(count) || count < 1 || count > 10 ||
		!Number.isSafeInteger(maxBytes) || maxBytes < 1024 ||
		!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid search limits");
	signal?.throwIfAborted();
	const timeout = AbortSignal.timeout(timeoutMs);
	const effectiveSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
	endpoint.searchParams.set("q", query.trim());
	endpoint.searchParams.set("count", String(count));
	const response = await (options.fetch ?? fetch)(endpoint, {
		headers: { Accept: "application/json", "X-Subscription-Token": options.apiKey },
		signal: effectiveSignal,
		redirect: "error", // Never forward the credential to a redirected host.
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`Search backend returned HTTP ${response.status}`); // No key/error-body leakage.
	}
	const json = record(await limitedJson(response, maxBytes));
	const web = record(json?.web);
	const hits = web?.results;
	if (hits !== undefined && !Array.isArray(hits)) throw new Error("Malformed search response");
	if (!json || !web) throw new Error("Search response lacks web results");
	const results: SearchHit[] = [];
	let truncated = Array.isArray(hits) && hits.length > count;
	for (const hit of Array.isArray(hits) ? hits.slice(0, count) : []) {
		const item = record(hit);
		if (!item || typeof item.url !== "string") throw new Error("Malformed search hit");
		let url: URL;
		try { url = new URL(item.url); } catch { truncated = true; continue; }
		if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
			truncated = true;
			continue;
		}
		const title = clean(item.title, 300);
		const snippet = clean(item.description, 2000);
		if (typeof item.title === "string" && item.title.length > 300 ||
			typeof item.description === "string" && item.description.length > 2000) truncated = true;
		results.push({ title, url: url.toString(), snippet });
	}
	effectiveSignal.throwIfAborted();
	return { query: query.trim(), provider: "brave", retrievedAt: new Date().toISOString(), results, truncated };
}
