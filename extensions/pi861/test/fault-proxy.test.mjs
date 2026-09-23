import assert from "node:assert/strict";
import { test } from "node:test";
import { startFaultProxy } from "./fixtures/fault-proxy.mjs";
import { startHttpFixture } from "./fixtures/http-fixtures.mjs";

// P1-Q fault-proxy fixture coverage (K6 surface, reused by P2-E): redirect, hang, drip, fixed
// status, rebinding forward hops and per-connection/request counting - all on loopback.

test("fault proxy injects redirects, fixed statuses and counts attempts", async () => {
	const fixture = await startFaultProxy();
	try {
		const redirect = await fetch(`${fixture.url}/redirect?to=${encodeURIComponent("http://169.254.169.254/latest/meta-data")}&status=307`, { redirect: "manual" });
		assert.equal(redirect.status, 307);
		assert.equal(redirect.headers.get("location"), "http://169.254.169.254/latest/meta-data");
		const status = await fetch(`${fixture.url}/status?code=503&body=unavailable`);
		assert.equal(status.status, 503);
		assert.equal(await status.text(), "unavailable");
		const missing = await fetch(`${fixture.url}/redirect`);
		assert.equal(missing.status, 400);
		assert.equal(fixture.requests.length, 3);
		assert.ok(fixture.connections.length >= 1);
		assert.equal(fixture.requests[0].path, "/redirect");
	} finally {
		await fixture.close();
	}
});

test("fault proxy hangs until the client aborts (timeout injection)", async () => {
	const fixture = await startFaultProxy();
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 250);
		const started = Date.now();
		await assert.rejects(fetch(`${fixture.url}/hang`, { signal: controller.signal }), /abort/i);
		clearTimeout(timer);
		assert.ok(Date.now() - started >= 200);
		assert.equal(fixture.requests.length, 1);
	} finally {
		await fixture.close();
	}
});

test("fault proxy drips paced chunks (slow-response injection)", async () => {
	const fixture = await startFaultProxy();
	try {
		const response = await fetch(`${fixture.url}/drip?chunks=3&delay=40`);
		assert.equal(response.status, 200);
		assert.equal(await response.text(), "chunk-1\nchunk-2\nchunk-3\n");
	} finally {
		await fixture.close();
	}
});

test("forward hop rebinds to the alternate upstream after the first request", async () => {
	const primary = await startHttpFixture([{ path: "/", body: "public-upstream" }]);
	const alternate = await startHttpFixture([{ path: "/", body: "private-upstream" }]);
	const fixture = await startFaultProxy();
	try {
		const target = `${fixture.url}/proxy?target=${encodeURIComponent(`${primary.url}/`)}&alt=${encodeURIComponent(`${alternate.url}/`)}&rebindAfter=0`;
		assert.equal(await (await fetch(target)).text(), "public-upstream");
		assert.equal(await (await fetch(target)).text(), "private-upstream");
		assert.equal(await (await fetch(target)).text(), "private-upstream");
		assert.equal(primary.requests.length, 1);
		assert.equal(alternate.requests.length, 2);
	} finally {
		await fixture.close();
		await primary.close();
		await alternate.close();
	}
});
