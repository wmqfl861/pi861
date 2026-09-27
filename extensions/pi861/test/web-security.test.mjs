import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultStore } from "../src/result-store.ts";
import { installWebTools } from "../src/live/web-host.ts";
import { webSearch } from "../src/search.ts";
import { validateWebTarget, webRead } from "../src/web-read.ts";
import { withHttpFixture } from "./fixtures/http-fixtures.mjs";

const loopback = { allowLoopbackHttp: true };
test("DNS timeout and cancellation stop before creating a socket, including late DNS completion", async () => {
	let finish;
	const lookup = () => new Promise((resolve) => { finish = resolve; });
	await assert.rejects(webRead("https://delayed.example/", { lookup, limits: { timeoutMs: 40 } }), (error) => error.code === "timeout");
	finish(["127.0.0.1"]);
	const controller = new AbortController();
	const pending = webRead("https://delayed.example/", { lookup }, controller.signal);
	controller.abort();
	await assert.rejects(pending, (error) => error.code === "cancelled");
	finish(["127.0.0.1"]);
});

test("IPv6 literals normalize once and non-public special ranges fail closed", async () => {
	const target = await validateWebTarget("http://[::1]:8123/", loopback, async () => { throw new Error("must not resolve literals"); });
	assert.equal(target.address, "::1");
	assert.equal(target.hostname, "::1");
	assert.equal(target.hostHeader, "[::1]:8123");
	for (const address of ["224.0.0.1", "240.0.0.1", "198.18.0.1", "192.0.0.1", "::ffff:8.8.8.8", "64:ff9b::a00:1", "2002:7f00:1::", "2001:db8::1", "ff02::1", "::127.0.0.1"]) {
		await assert.rejects(validateWebTarget("https://public.example/", {}, async () => [address]), (error) => error.code === "blocked_address");
	}
});

test("each redirect rechecks authority and charges its own request; denial prevents the next hop", async () => {
	await withHttpFixture([{ path: "/", status: 302, headers: { location: "/next" } }, { path: "/next", headers: { "content-type": "text/plain" }, body: "data" }], async (fixture) => {
		let calls = 0;
		await assert.rejects(webRead(fixture.url, { ...loopback, beforeRequest: () => { if (++calls > 1) throw new Error("revoked"); } }), /revoked/);
		assert.equal(calls, 2);
		assert.equal(fixture.requests.length, 1);
		await assert.rejects(webRead(fixture.url, { ...loopback, limits: { maxRedirects: 0 } }), (error) => error.code === "redirect_limit");
	});
});

test("byte truncation at a multibyte boundary remains an honest partial result", async () => {
	await withHttpFixture([{ path: "/", headers: { "content-type": "text/plain" }, body: "中".repeat(1000) }], async (fixture) => {
		const store = new ResultStore({ pageSize: 100 });
		const found = await webRead(fixture.url, { ...loopback, owner: "trusted", scope: "project:p", store, limits: { maxBytes: 1001, inlineLimit: 100 } });
		assert.equal(found.body.truncated, true);
		const page = store.read(found.body.resultRef, "trusted", 300);
		assert.equal(page.complete, true);
		assert.equal(page.sourceComplete, false);
		assert.equal(page.text, "中".repeat(33));
	});
});

test("search body stalls and a transport ignoring cancellation remain bounded", async () => {
	await withHttpFixture([{ path: "/", headers: { "content-type": "application/json" }, chunks: [{ data: '{"web":' }, { data: '{"results":[]}}', delayMs: 1000 }] }], async (fixture) => {
		await assert.rejects(webSearch("public", { enabled: true, apiKey: "fixture", timeoutMs: 100, fetch: (_url, init) => fetch(fixture.url, init) }), (error) => error.code === "backend_error");
	});
	await assert.rejects(webSearch("public", { enabled: true, apiKey: "fixture", timeoutMs: 40, fetch: () => new Promise(() => {}) }), /timed out/);
});

test("result storage enforces a total capacity, invalidates revoked refs and keeps owner scopes separate", () => {
	const store = new ResultStore({ maxTotalCharacters: 10 });
	const first = store.store("123456", "a");
	const next = store.store("123456", "b");
	assert.throws(() => store.read(first.resultRef, "a"), /not found/);
	assert.throws(() => store.read(next.resultRef, "a"), /not found/);
	store.revoke(next.resultRef);
	assert.throws(() => store.read(next.resultRef, "b"), /not found/);
});

// Adapted from the independent M5 review counterexample
// C:\Albert\project\pi861-briefs\m5-review-457ccf2\review-dns-authorization.test.mjs (do not modify the original):
// a denied destination must never reach DNS resolution.
test("a denied web destination must not reach DNS resolution (review 457ccf2)", async () => {
	const trace = [];
	const tools = new Map();
	const pi = {
		tools,
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand() {},
		on() {},
		sendMessage() {},
		call(name, args, signal) { return tools.get(name).execute("review", args, signal ?? new AbortController().signal); },
	};
	const service = installWebTools(pi, {
		identity: () => ({ owner: "review-owner", scope: "project:review" }),
		authorize(request) { trace.push({ stage: "authorize", url: request.url }); return false; },
		webRead: { enabled: true, lookup: async (hostname) => { trace.push({ stage: "dns", hostname }); return ["93.184.216.34"]; } },
	});
	try {
		const result = await pi.call("pi861_web_read", { url: "https://synthetic-private-label.denied.example/page" });
		console.log(JSON.stringify({ case: "denied-host-dns", stages: trace.map((entry) => entry.stage), isError: result.isError }));
		assert.equal(result.isError, true);
		assert.equal(trace.some((entry) => entry.stage === "dns"), false, "unapproved hostname reached the DNS transport before authorization");
		assert.equal(trace.some((entry) => entry.stage === "authorize"), true);
	} finally {
		service.close();
	}
});

test("authorization and reservation run before any DNS resolution and before the connection", async () => {
	await withHttpFixture([{ path: "/", headers: { "content-type": "text/plain" }, body: "ok" }], async (fixture) => {
		const events = [];
		const found = await webRead(`http://service.example:${fixture.port}/`, {
			allowLoopbackHttp: true,
			lookup: async (hostname) => {
				events.push(`dns:${hostname}`);
				return ["127.0.0.1"];
			},
			beforeRequest: async (url) => {
				events.push(`authorize:${url}`);
			},
		});
		assert.equal(found.body.kind, "inline");
		assert.equal(found.body.text, "ok");
		assert.deepEqual(events, [`authorize:http://service.example:${fixture.port}/`, "dns:service.example"]);
	});
});
