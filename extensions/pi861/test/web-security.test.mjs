import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultStore } from "../src/result-store.ts";
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
