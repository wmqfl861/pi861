import assert from "node:assert/strict";
import { test } from "node:test";
import { webSearch, availableSearchProviders, packSearchResult, SearchFailure } from "../src/search.ts";
import { ResultStore } from "../src/result-store.ts";
import { withHttpFixture } from "./fixtures/http-fixtures.mjs";
const opts = (impl) => ({ enabled: true, apiKey: "test-only-placeholder", fetch: impl });
const response = (results) => Response.json({ web: { results } });
test("disabled or missing-key search does not call a backend", async () => {
	let calls = 0;
	const fake = async () => { calls++; return response([]); };
	await assert.rejects(webSearch("test", { ...opts(fake), enabled: false }), /disabled/);
	await assert.rejects(webSearch("test", { ...opts(fake), apiKey: undefined }), /Missing/);
	assert.equal(calls, 0);
});
test("uses fixed endpoint and credential header, never a query-string key", async () => {
	const found = await webSearch("TypeScript docs", opts(async (url, config) => {
		assert.equal(url.origin, "https://api.search.brave.com");
		assert.equal(url.searchParams.get("q"), "TypeScript docs");
		assert.equal(url.searchParams.has("api_key"), false);
		assert.equal(config.headers["X-Subscription-Token"], "test-only-placeholder");
		assert.equal(config.redirect, "error");
		return response([{ title: "Docs", url: "https://example.org/docs", description: "A reference" }]);
	}));
	assert.equal(found.results[0].url, "https://example.org/docs");
	assert.equal(found.truncated, false);
	assert.ok(found.retrievedAt);
});
test("query and result limits are validated", async () => {
	for (const query of ["", "x".repeat(601), Array(76).fill("word").join(" ")]) {
		await assert.rejects(webSearch(query, opts(async () => response([]))), /query/);
	}
	await assert.rejects(webSearch("ok", { ...opts(async () => response([])), maxResults: 99 }), /limits/);
});
test("unsafe result links are omitted and omission is visible", async () => {
	const found = await webSearch("query", opts(async () => response([
		{ title: "unsafe", url: "javascript:alert(1)", description: "x" },
		{ title: "credentials", url: "https://user:password@example.org", description: "x" },
	])));
	assert.equal(found.results.length, 0);
	assert.equal(found.truncated, true);
});
test("oversized body is stopped before full parsing", async () => {
	await assert.rejects(webSearch("query", { ...opts(async () => new Response("x".repeat(2048))), maxResponseBytes: 1024 }), /byte limit/);
});
test("error body containing credentials is not reflected", async () => {
	await assert.rejects(webSearch("query", opts(async () => new Response("SECRET-KEY", { status: 429 }))),
		(error) => error.message === "Search backend returned HTTP 429");
});
test("malformed service payload is not reported as successful zero hits", async () => {
	await assert.rejects(webSearch("query", opts(async () => Response.json({}))), /lacks/);
	await assert.rejects(webSearch("query", opts(async () => Response.json({ web: { results: "wrong" } }))), /Malformed/);
});
test("truncated snippets are marked", async () => {
	const found = await webSearch("query", opts(async () => response([{ title: "x", url: "https://example.org", description: "a".repeat(2100) }])));
	assert.equal(found.truncated, true);
	assert.equal(found.results[0].snippet.length, 2000);
});
test("a cancelled request never reaches the network", async () => {
	const controller = new AbortController();
	controller.abort(new Error("cancel"));
	let calls = 0;
	await assert.rejects(webSearch("query", opts(async () => { calls++; return response([]); }), controller.signal), /cancel/);
	assert.equal(calls, 0);
});

test("only implemented backends are listed and unimplemented ones are refused honestly", async () => {
	assert.deepEqual(availableSearchProviders(), ["brave"]);
	await assert.rejects(webSearch("query", { ...opts(async () => response([])), provider: "google" }),
		(error) => error instanceof SearchFailure && error.code === "not_implemented" &&
			error.message === 'Search backend "google" is not implemented; available: brave');
});

test("unavailability is structured: disabled, not configured and backend faults are distinguishable", async () => {
	await assert.rejects(webSearch("query", { ...opts(async () => response([])), enabled: false }),
		(error) => error instanceof SearchFailure && error.code === "disabled");
	await assert.rejects(webSearch("query", { ...opts(async () => response([])), apiKey: undefined }),
		(error) => error instanceof SearchFailure && error.code === "not_configured");
	await assert.rejects(webSearch("query", opts(async () => new Response("nope", { status: 503 }))),
		(error) => error instanceof SearchFailure && error.code === "backend_error" && /HTTP 503/.test(error.message));
	await assert.rejects(webSearch("query", opts(async () => new Response("<html>"))),
		(error) => error instanceof SearchFailure && error.code === "malformed_response");
	await assert.rejects(webSearch("query", { ...opts(async () => new Response("x".repeat(2048))), maxResponseBytes: 1024 }),
		(error) => error instanceof SearchFailure && error.code === "response_too_large");
});

test("a backend timeout is reported as a backend failure, not a silent hang", async () => {
	const hanging = (_url, init) => new Promise((_resolve, reject) => {
		init.signal.addEventListener("abort", () => reject(init.signal.reason));
	});
	await assert.rejects(webSearch("query", { ...opts(hanging), timeoutMs: 60 }),
		(error) => error instanceof SearchFailure && error.code === "backend_error" && /timed out/.test(error.message));
});

test("results carry trusted scope and an honest cache state", async () => {
	const found = await webSearch("scoped", { ...opts(async () => response([{ title: "a", url: "https://example.org", description: "d" }])), scope: "project:alpha" });
	assert.equal(found.scope, "project:alpha");
	assert.deepEqual(found.cache, { hit: false, source: "direct" });
	assert.equal(found.provider, "brave");
	const unscoped = await webSearch("plain", opts(async () => response([])));
	assert.equal(unscoped.scope, "");
	assert.deepEqual(unscoped.cache, { hit: false, source: "direct" });
});

test("oversized serialized results move to a controlled reference", async () => {
	const store = new ResultStore({ pageSize: 100 });
	const hit = { title: "t", url: "https://example.org", description: "d".repeat(2000) };
	const found = await webSearch("big", { ...opts(async () => response(Array(10).fill(hit))) });
	const forced = packSearchResult(found, store, "role:worker-a", 100);
	assert.equal(forced.inline, false);
	assert.ok(store.read(forced.resultRef, "role:worker-a").totalCharacters > 100);
	assert.throws(() => store.read(forced.resultRef, "role:worker-b"), /Result not found/);
	const compact = await webSearch("small", opts(async () => response([{ title: "t", url: "https://example.org", description: "d" }])));
	assert.equal(packSearchResult(compact, store, "role:worker-a", 32_000).inline, true);
});

test("the backend is exercised over a real local HTTP layer", async () => {
	const backendRoute = { path: "/res/v1/web/search", headers: { "content-type": "application/json" } };
	await withHttpFixture([
		{ ...backendRoute, body: JSON.stringify({ web: { results: [{ title: "Docs", url: "https://example.org/docs", description: "A reference" }] } }) },
	], async (fixture) => {
		const found = await webSearch("real socket", opts((url, init) => fetch(`${fixture.url}${url.pathname}${url.search}`, init)));
		assert.equal(found.results[0].url, "https://example.org/docs");
		const seen = fixture.requests[0];
		assert.equal(seen.headers["x-subscription-token"], "test-only-placeholder");
		assert.equal(seen.url.includes("api_key"), false);
	});
	await withHttpFixture([{ ...backendRoute, body: "not-json{{" }], async (fixture) => {
		await assert.rejects(webSearch("query", opts((url, init) => fetch(`${fixture.url}${url.pathname}${url.search}`, init))),
			(error) => error instanceof SearchFailure && error.code === "malformed_response");
	});
	await withHttpFixture([{ ...backendRoute, status: 429, body: "SECRET-KEY-1234" }], async (fixture) => {
		await assert.rejects(webSearch("query", opts((url, init) => fetch(`${fixture.url}${url.pathname}${url.search}`, init))),
			(error) => error instanceof SearchFailure && error.code === "backend_error" &&
				error.message === "Search backend returned HTTP 429" &&
				!error.message.includes("SECRET"));
	});
	await withHttpFixture([{ ...backendRoute, delayMs: 400, body: "{}" }], async (fixture) => {
		await assert.rejects(webSearch("query", { ...opts((url, init) => fetch(`${fixture.url}${url.pathname}${url.search}`, init)), timeoutMs: 100 }),
			(error) => error instanceof SearchFailure && error.code === "backend_error" && /timed out/.test(error.message));
	});
	await withHttpFixture([{ ...backendRoute, body: "x".repeat(8192) }], async (fixture) => {
		await assert.rejects(webSearch("query", { ...opts((url, init) => fetch(`${fixture.url}${url.pathname}${url.search}`, init)), maxResponseBytes: 1024 }),
			(error) => error instanceof SearchFailure && error.code === "response_too_large");
	});
});
