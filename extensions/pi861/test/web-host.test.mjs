import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { installWebTools } from "../src/live/web-host.ts";
import { ResultStore } from "../src/result-store.ts";
import { withHttpFixture } from "./fixtures/http-fixtures.mjs";

function host() {
	const tools = new Map(), commands = new Map(), events = new Map();
	return { tools, commands, events, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); },
		on(name, callback) { events.set(name, callback); }, sendMessage() {}, call(name, args, signal = new AbortController().signal) { return tools.get(name).execute("fixture-call", args, signal); } };
}
const identity = () => ({ owner: "tenant:a/principal:worker/role:read/project:p", scope: "project:p" });
test("web tools default closed and worker needs a separate opt-in", () => {
	for (const options of [{}, { search: { enabled: true, apiKey: "fixture" }, worker: true }]) {
		const pi = host();
		installWebTools(pi, { ...options, identity, authorize: () => true });
		assert.equal(pi.tools.size, 0);
		assert.ok(pi.commands.has("web-search"));
	}
});
test("configured search uses env key name and rechecks permissions and request budget", async () => {
	const pi = host(); let allowed = true, calls = 0, reserved = 0;
	process.env.PI861_M5_FIXTURE_KEY = "fixture-only";
	try {
		const config = { search: { enabled: true, apiKeyEnv: "PI861_M5_FIXTURE_KEY", fetch: async (_url, init) => {
			assert.equal(init.headers["X-Subscription-Token"], "fixture-only"); calls++;
			return Response.json({ web: { results: [] } });
		} }, identity, authorize: () => allowed, reserveRequest: () => { reserved++; } };
		installWebTools(pi, config);
		assert.equal((await pi.call("pi861_web_search", { query: "public" })).details.untrusted, true);
		allowed = false;
		assert.equal((await pi.call("pi861_web_search", { query: "public" })).isError, true);
		assert.equal(calls, 1); assert.equal(reserved, 1);
		allowed = true; config.reserveRequest = () => { allowed = false; };
		assert.equal((await pi.call("pi861_web_search", { query: "public" })).isError, true);
		assert.equal(calls, 1);
	} finally { delete process.env.PI861_M5_FIXTURE_KEY; }
});
test("references recheck source permission, scope and session on every read", async () => {
	await withHttpFixture([{ path: "/", headers: { "content-type": "text/plain" }, body: "public ".repeat(1000) }], async (fixture) => {
		const pi = host(); let allowed = true, current = identity();
		installWebTools(pi, { identity: () => current, authorize: () => allowed, webRead: { enabled: true, allowLoopbackHttp: true, limits: { inlineLimit: 50 } } });
		const found = (await pi.call("pi861_web_read", { url: fixture.url })).details;
		assert.equal(found.body.kind, "reference");
		const args = { resultRef: found.body.resultRef };
		assert.equal((await pi.call("pi861_web_result", args)).details.sourceComplete, true);
		allowed = false;
		assert.equal((await pi.call("pi861_web_result", args)).isError, true);
		allowed = true; current = { ...current, owner: "other-tenant" };
		assert.equal((await pi.call("pi861_web_result", args)).isError, true);
		current = identity(); pi.events.get("session_tree")();
		assert.equal((await pi.call("pi861_web_result", args)).isError, true);
	});
});
test("custom search references reauthorize their original backend after config changes and revocation", async () => {
	const pi = host(), endpoint = "https://search.fixture.test/query", seen = [];
	let allowed = true;
	const config = {
		search: {
			enabled: true,
			backend: {
				id: "fixture", endpoint,
				capabilities: () => ({ maxResults: { min: 1, max: 10 }, requiresApiKey: false }),
				search: async (query) => ({ query, provider: "fixture", retrievedAt: "2026-09-22T00:00:00Z", results: [{ title: "Docs", url: "https://example.org", snippet: "public ".repeat(5000) }], truncated: false }),
			},
		},
		identity,
		authorize: (request) => { seen.push(request); return request.url === "https://api.search.brave.com/res/v1/web/search" || (allowed && request.url === endpoint); },
	};
	installWebTools(pi, config);
	const found = (await pi.call("pi861_web_search", { query: "public" })).details;
	assert.equal(found.inline, false);
	assert.equal(found.endpoint, endpoint);
	config.search.backend = { ...config.search.backend, endpoint: "https://other.fixture.test/query" };
	assert.equal((await pi.call("pi861_web_result", { resultRef: found.resultRef })).details.sourceComplete, true);
	allowed = false;
	assert.equal((await pi.call("pi861_web_result", { resultRef: found.resultRef })).isError, true);
	assert.ok(seen.every((request) => request.url === endpoint));
	assert.ok(seen.some((request) => request.kind === "result"));
});

test("search response authorization uses the selected provider when an unrelated adapter is configured", async () => {
	const pi = host(), endpoint = "https://api.search.brave.com/res/v1/web/search", seen = [];
	installWebTools(pi, {
		identity,
		authorize: (request) => { seen.push(request.url); return request.url === endpoint; },
		search: {
			enabled: true, provider: "brave", apiKey: "fixture",
			fetch: async () => Response.json({ web: { results: [] } }),
			backend: { id: "unused", endpoint: "https://unused.fixture.test/", capabilities: () => { throw new Error("Unused adapter"); }, search: async () => { throw new Error("Unused adapter"); } },
		},
	});
	const result = await pi.call("pi861_web_search", { query: "public" });
	assert.equal(result.isError, undefined);
	assert.equal(result.details.endpoint, endpoint);
	assert.ok(seen.length >= 3);
	assert.ok(seen.every((url) => url === endpoint));
});

test("untrusted tool parameters cannot provide identity or grant an internal endpoint", async () => {
	const pi = host(); let calls = 0;
	installWebTools(pi, { identity, authorize: () => { calls++; return true; }, webRead: { enabled: true } });
	assert.equal((await pi.call("pi861_web_read", { url: "http://127.0.0.1/", owner: "admin", allowLoopbackHttp: true })).isError, true);
	assert.equal(calls, 0);
});

// The next three tests are adapted from the independent M5 review counterexample
// C:\Albert\project\pi861-briefs\m5-review-457ccf2\review-permission-cancel.test.mjs (do not modify the original).
test("revoking a custom backend invalidates its existing search reference (review 457ccf2)", async () => {
	const pi = host(), store = new ResultStore();
	const endpoint = "https://review-search.example/search", braveEndpoint = "https://api.search.brave.com/res/v1/web/search";
	let revoked = false;
	const backend = {
		id: "review",
		endpoint,
		capabilities: () => ({ maxResults: { min: 1, max: 100 }, requiresApiKey: false }),
		async search(query) {
			return { query, provider: "review", retrievedAt: "2026-09-22T00:00:00.000Z", truncated: false,
				results: Array.from({ length: 20 }, () => ({ title: "Public fixture", url: "https://public.example/item", snippet: "fixture ".repeat(250) })) };
		},
	};
	const service = installWebTools(pi, {
		identity,
		store,
		search: { enabled: true, backend, maxResults: 20 },
		authorize(request) { return request.url === braveEndpoint || (request.url === endpoint && !revoked); },
	});
	try {
		const search = await pi.call("pi861_web_search", { query: "public fixture" });
		assert.equal(search.isError, undefined);
		assert.equal(search.details.inline, false);
		assert.equal(store.metadata(search.details.resultRef, identity().owner).url, endpoint);
		revoked = true;
		const page = await pi.call("pi861_web_result", { resultRef: search.details.resultRef });
		console.log(JSON.stringify({ case: "custom-backend-revocation", declaredEndpoint: endpoint, storedUrl: endpoint, returnedPage: !page.isError }));
		assert.equal(page.isError, true, "revoked custom-backend data was still returned under Brave authorization");
	} finally {
		service.close();
	}
});

test("cancellation settles search while post-network authorization is pending (review 457ccf2)", async () => {
	const pi = host();
	const entered = Promise.withResolvers(), gate = Promise.withResolvers();
	let checks = 0;
	const backend = {
		id: "review",
		endpoint: "https://review-search.example/search",
		capabilities: () => ({ maxResults: { min: 1, max: 100 }, requiresApiKey: false }),
		async search(query) {
			return { query, provider: "review", retrievedAt: "2026-09-22T00:00:00.000Z", truncated: false,
				results: Array.from({ length: 20 }, () => ({ title: "Public fixture", url: "https://public.example/item", snippet: "fixture ".repeat(250) })) };
		},
	};
	const service = installWebTools(pi, {
		identity,
		search: { enabled: true, backend, maxResults: 20, timeoutMs: 40 },
		authorize() {
			checks += 1;
			if (checks === 3) {
				entered.resolve();
				return gate.promise;
			}
			return true;
		},
	});
	const stop = new AbortController();
	const pending = pi.call("pi861_web_search", { query: "public fixture" }, stop.signal);
	try {
		await entered.promise;
		const started = performance.now();
		stop.abort(new Error("fixture cancel"));
		const outcome = await Promise.race([pending.then(() => "settled"), delay(120).then(() => "still-pending")]);
		console.log(JSON.stringify({ case: "post-network-authorization-cancel", timeoutMs: 40, elapsedAfterCancelMs: Math.round(performance.now() - started), outcome }));
		assert.equal(outcome, "settled", "tool ignored cancellation and configured deadline while waiting for authorization");
	} finally {
		gate.resolve(true);
		await pending;
		service.close();
	}
});

test("cancellation and close settle reference paging while authorization is pending (review 457ccf2)", async () => {
	const pi = host(), store = new ResultStore();
	const ref = store.store("public fixture", identity().owner, {
		kind: "search",
		scope: identity().scope,
		url: "https://api.search.brave.com/res/v1/web/search",
		sourceComplete: true,
	});
	const entered = Promise.withResolvers(), gate = Promise.withResolvers();
	const service = installWebTools(pi, {
		identity,
		store,
		search: { enabled: true, apiKey: "fixture-only" },
		authorize() {
			entered.resolve();
			return gate.promise;
		},
	});
	const stop = new AbortController();
	const pending = pi.call("pi861_web_result", { resultRef: ref.resultRef }, stop.signal);
	try {
		await entered.promise;
		const started = performance.now();
		stop.abort(new Error("fixture cancel"));
		service.close();
		const outcome = await Promise.race([pending.then(() => "settled"), delay(120).then(() => "still-pending")]);
		console.log(JSON.stringify({ case: "page-authorization-cancel-and-close", elapsedAfterCancelMs: Math.round(performance.now() - started), outcome }));
		assert.equal(outcome, "settled", "reference tool ignored cancellation and host close");
	} finally {
		gate.resolve(true);
		await pending;
		service.close();
	}
});
