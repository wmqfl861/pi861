import assert from "node:assert/strict";
import { test } from "node:test";
import { installWebTools } from "../src/live/web-host.ts";
import { withHttpFixture } from "./fixtures/http-fixtures.mjs";

function host() {
	const tools = new Map(), commands = new Map(), events = new Map();
	return { tools, commands, events, registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(name, command) { commands.set(name, command); },
		on(name, callback) { events.set(name, callback); }, sendMessage() {}, call(name, args) { return tools.get(name).execute("fixture-call", args, new AbortController().signal); } };
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
test("untrusted tool parameters cannot provide identity or grant an internal endpoint", async () => {
	const pi = host(); let calls = 0;
	installWebTools(pi, { identity, authorize: () => { calls++; return true; }, webRead: { enabled: true } });
	assert.equal((await pi.call("pi861_web_read", { url: "http://127.0.0.1/", owner: "admin", allowLoopbackHttp: true })).isError, true);
	assert.equal(calls, 0);
});
