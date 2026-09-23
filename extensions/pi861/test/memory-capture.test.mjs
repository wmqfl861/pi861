import assert from "node:assert/strict";
import { test } from "node:test";
import { CAPTURE_DIRECT_MAX_BYTES, captureToolResult, looksSensitive, planToolCapture } from "../src/live/capture.ts";
const scope = "project:p";
function backend() {
	const puts = [];
	return { puts, async put(input) { puts.push(input); return { requestId: input.requestId, state: "committed", id: input.item.id, scope: input.item.scope, revision: 1 }; } };
}
test("normal tool results are captured as direct evidence", async () => {
	const store = backend();
	const outcome = await captureToolResult(store, { sessionId: "s1", toolCallId: "t1", toolName: "read", result: { content: [{ type: "text", text: "const x = 1;" }] } }, scope);
	assert.equal(outcome.status, "captured");
	assert.equal(store.puts.length, 1);
	assert.equal(store.puts[0].item.kind, "evidence");
	assert.equal(store.puts[0].item.source.kind, "tool");
	assert.ok(store.puts[0].item.full.includes("const x = 1;"));
});
test("oversize results become truncated references with a digest, never silent drops", async () => {
	const store = backend();
	const big = "y".repeat(CAPTURE_DIRECT_MAX_BYTES + 10);
	const outcome = await captureToolResult(store, { sessionId: "s1", toolCallId: "t2", toolName: "shell", result: { stdout: big } }, scope);
	assert.equal(outcome.status, "referenced");
	const item = store.puts[0].item;
	const parsed = JSON.parse(item.full);
	assert.equal(parsed.capture, "tool-reference");
	assert.equal(parsed.truncated, true);
	assert.equal(typeof parsed.contentDigest, "string");
	assert.equal(parsed.contentDigest.length, 64);
	assert.equal(parsed.bytes, Buffer.byteLength(JSON.stringify({ tool: "shell", result: { stdout: big }, isError: false })));
	assert.ok(parsed.preview.length < CAPTURE_DIRECT_MAX_BYTES);
	assert.ok(!item.full.includes(big));
});
test("sensitive results never enter stored text or summaries", async () => {
	const store = backend();
	const token = `ghp_${"a".repeat(30)}`;
	const outcome = await captureToolResult(store, { sessionId: "s1", toolCallId: "t3", toolName: "fetch", result: { body: `token=${token}` } }, scope);
	assert.equal(outcome.status, "referenced");
	const item = store.puts[0].item;
	for (const field of [item.full, item.abstract, item.overview]) assert.ok(!field.includes(token));
	const parsed = JSON.parse(item.full);
	assert.equal(parsed.withheld, "sensitive");
	assert.equal(parsed.matchedRule, "token");
	assert.equal(parsed.contentDigest.length, 64);
});
test("oversize payloads that also contain secrets are treated as sensitive", () => {
	const plan = planToolCapture({ sessionId: "s", toolCallId: "t", toolName: "x",
		result: { padding: "z".repeat(CAPTURE_DIRECT_MAX_BYTES + 1), key: `sk-${"b".repeat(20)}` } }, scope);
	assert.equal(plan.mode, "reference");
	assert.equal(plan.reason, "sensitive");
	assert.ok(!plan.item.full.includes("sk-bbbb"));
});
test("unserializable results still produce a reference record", async () => {
	const store = backend();
	const cyclic = { name: "self" }; cyclic.self = cyclic;
	const outcome = await captureToolResult(store, { sessionId: "s1", toolCallId: "t4", toolName: "inspect", result: cyclic }, scope);
	assert.equal(outcome.status, "referenced");
	const parsed = JSON.parse(store.puts[0].item.full);
	assert.equal(parsed.withheld, "unserializable-result");
});
test("capture failures are reported, never thrown", async () => {
	const failing = { async put() { throw new Error("database unavailable"); } };
	const outcome = await captureToolResult(failing, { sessionId: "s", toolCallId: "t", toolName: "read", result: { ok: true } }, scope);
	assert.equal(outcome.status, "failed");
	assert.match(outcome.error, /database unavailable/);
});
test("secret detection covers keys, tokens and credential assignments", () => {
	assert.equal(looksSensitive("-----BEGIN RSA PRIVATE KEY-----"), true);
	assert.equal(looksSensitive("Bearer abcdefghijkl1234"), true);
	assert.equal(looksSensitive('password = "supersecret99"'), true);
	assert.equal(looksSensitive("api_key: 0123456789abcdef"), true);
	assert.equal(looksSensitive("plain text without credentials"), false);
});
