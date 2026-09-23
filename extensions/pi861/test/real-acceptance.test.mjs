import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runRealAcceptance } from "../src/live/real-acceptance.ts";

test("all real-service CLIs stay deferred with empty isolated credentials", () => {
	for (const kind of ["search", "model", "mcp"]) {
		const cli = fileURLToPath(new URL(`../scripts/real-acceptance/real-${kind}.mjs`, import.meta.url));
		const report = JSON.parse(execFileSync(process.execPath, [cli], { encoding: "utf8", env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } }));
		assert.equal(report.status, "deferred"); assert.equal(report.requests, 0);
		assert.match(report.message, /待授权/);
	}
});
test("real acceptance needs opt-in, credentials and explicit bounded budget before transport", async () => {
	for (const env of [{}, { PI861_REAL_SEARCH_ACCEPTANCE: "1", BRAVE_SEARCH_API_KEY: "fixture" }, { PI861_REAL_SEARCH_ACCEPTANCE: "1", PI861_REAL_SEARCH_BUDGET: "6", BRAVE_SEARCH_API_KEY: "fixture" }]) {
		const report = await runRealAcceptance("search", env, async () => { throw new Error("must not dispatch"); });
		assert.equal(report.status, "deferred"); assert.equal(report.requests, 0);
	}
});
test("authorized script logic is exercised only with injected transport and synthetic keys", async () => {
	const search = await runRealAcceptance("search", { PI861_REAL_SEARCH_ACCEPTANCE: "1", PI861_REAL_SEARCH_BUDGET: "1", BRAVE_SEARCH_API_KEY: "fixture" }, async (url, init) => {
		assert.equal(url.searchParams.get("q"), "PostgreSQL 17 release notes"); assert.equal(init.redirect, "error");
		return Response.json({ web: { results: [] } });
	});
	assert.equal(search.status, "passed"); assert.equal(search.requests, 1);
	const model = await runRealAcceptance("model", { PI861_REAL_MODEL_ACCEPTANCE: "1", PI861_REAL_MODEL_BUDGET: "1", PI861_REAL_MODEL_URL: "https://approved.example/chat/completions", PI861_REAL_MODEL_ID: "fixture-model", PI861_REAL_MODEL_KEY_ENV: "FIXTURE", FIXTURE: "not-a-real-key" }, async (_url, init) => {
		const payload = JSON.parse(init.body); assert.equal(payload.max_tokens, 8); assert.equal(payload.tools, undefined);
		return Response.json({ choices: [{ message: { content: "OK" } }] });
	});
	assert.equal(model.status, "passed"); assert.equal(model.requests, 1);
	assert.equal(JSON.stringify(model).includes("not-a-real-key"), false);
});
test("MCP acceptance only initializes and lists, never dispatches business tools", async () => {
	const methods = [];
	const env = { PI861_REAL_MCP_ACCEPTANCE: "1", PI861_REAL_MCP_BUDGET: "3", PI861_REAL_MCP_URL: "https://approved.example/mcp", PI861_REAL_MCP_KEY_ENV: "FIXTURE", FIXTURE: "fixture" };
	const report = await runRealAcceptance("mcp", env, async (_url, init) => {
		const payload = JSON.parse(init.body); methods.push(payload.method);
		if (payload.method === "initialize") return Response.json({ jsonrpc: "2.0", id: payload.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } });
		if (payload.method === "notifications/initialized") return new Response(null, { status: 202 });
		return Response.json({ jsonrpc: "2.0", id: payload.id, result: { tools: [] } });
	});
	assert.equal(report.status, "passed"); assert.equal(report.requests, 3);
	assert.deepEqual(methods, ["initialize", "notifications/initialized", "tools/list"]);
	const insufficient = await runRealAcceptance("mcp", { ...env, PI861_REAL_MCP_BUDGET: "2" }, async () => { throw new Error("no call"); });
	assert.equal(insufficient.status, "failed"); assert.equal(insufficient.requests, 0);
});
