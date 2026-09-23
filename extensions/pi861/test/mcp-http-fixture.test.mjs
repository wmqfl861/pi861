import assert from "node:assert/strict";
import { test } from "node:test";
import { startMcpHttpServer, withMcpHttpServer } from "./fixtures/mcp-http-server.mjs";

// P1-Q fixture coverage: the HTTP MCP fixture must really exercise handshake, session,
// pagination, notifications (SSE), cancellation and schema drift over actual HTTP.

async function initialize(fixture, protocolVersion = "2025-06-18") {
	const response = await fetch(fixture.url, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion, capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
	});
	assert.equal(response.status, 200);
	const session = response.headers.get("mcp-session-id");
	assert.match(session ?? "", /^[\x21-\x7e]{8,}$/);
	const body = await response.json();
	assert.equal(body.result.protocolVersion, protocolVersion);
	return { session, headers: { "content-type": "application/json", accept: "application/json", "mcp-session-id": session, "mcp-protocol-version": protocolVersion } };
}

async function call(fixture, headers, payload) {
	const response = await fetch(fixture.url, { method: "POST", headers, body: JSON.stringify(payload) });
	return { status: response.status, body: await response.json() };
}

test("initialize negotiates versions, unknown sessions get 404, deletion ends the session", async () => {
	await withMcpHttpServer({}, async (fixture) => {
		const legacy = await initialize(fixture, "2024-11-05");
		assert.equal(legacy.session.length > 0, true);
		const future = await fetch(fixture.url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01", capabilities: {} } }),
		});
		assert.equal((await future.json()).result.protocolVersion, "2025-06-18");
		const missing = await call(fixture, { "content-type": "application/json" }, { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} });
		assert.equal(missing.status, 404);
		const stale = await call(fixture, { "content-type": "application/json", "mcp-session-id": "no-such-session" }, { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} });
		assert.equal(stale.status, 404);
		const badVersion = await call(fixture, { ...legacy.headers, "mcp-protocol-version": "2000-01-01" }, { jsonrpc: "2.0", id: 5, method: "tools/list", params: {} });
		assert.equal(badVersion.status, 400);
		const removed = await fetch(fixture.url, { method: "DELETE", headers: { "mcp-session-id": legacy.session } });
		assert.equal(removed.status, 202);
		const afterDelete = await call(fixture, legacy.headers, { jsonrpc: "2.0", id: 6, method: "tools/list", params: {} });
		assert.equal(afterDelete.status, 404);
	});
});

test("tools/list paginates through every fixture tool with cursors", async () => {
	await withMcpHttpServer({ toolCount: 4, pageSize: 3 }, async (fixture) => {
		const { headers } = await initialize(fixture);
		const names = [];
		let cursor;
		let pages = 0;
		do {
			const { body } = await call(fixture, headers, { jsonrpc: "2.0", id: 10, method: "tools/list", params: cursor ? { cursor } : {} });
			assert.equal(body.error, undefined);
			names.push(...body.result.tools.map((tool) => tool.name));
			cursor = body.result._meta?.nextCursor;
			pages += 1;
		} while (cursor);
		assert.equal(pages, 3); // 4 fixture tools + echo + fail + slow = 7 tools at page size 3
		assert.equal(new Set(names).size, names.length);
		assert.equal(names.length, 7);
		for (const expected of ["fixture-tool-1", "echo", "fail", "slow"]) assert.ok(names.includes(expected));
		const badCursor = await call(fixture, headers, { jsonrpc: "2.0", id: 11, method: "tools/list", params: { cursor: "fixture-tool-999" } });
		assert.equal(badCursor.body.error.code, -32602);
	});
});

test("slow tool calls observe JSON-RPC cancellation before completion", async () => {
	await withMcpHttpServer({ slowToolMs: 400 }, async (fixture) => {
		const { headers } = await initialize(fixture);
		const pending = call(fixture, { ...headers, "content-type": "application/json" }, { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "slow", arguments: { value: "x" } } });
		await new Promise((resolve) => setTimeout(resolve, 50));
		const cancellation = await fetch(fixture.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 20, reason: "user" } }) });
		assert.equal(cancellation.status, 202);
		const outcome = await pending;
		assert.equal(outcome.body.error.code, -32800);
		assert.equal(outcome.body.error.message, "Request cancelled");
		const completed = await call(fixture, headers, { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "echo", arguments: { message: "hi" } } });
		assert.equal(completed.body.result.content[0].type, "text");
	});
});

test("schema flip changes the echo tool schema for later tools/list calls (schema drift)", async () => {
	await withMcpHttpServer({}, async (fixture) => {
		const { headers } = await initialize(fixture);
		const before = await call(fixture, headers, { jsonrpc: "2.0", id: 30, method: "tools/list", params: { cursor: "echo" } });
		const echoBefore = before.body.result.tools.find((tool) => tool.name === "echo");
		assert.deepEqual(echoBefore.inputSchema.required, ["message"]);
		const flip = await call(fixture, headers, { jsonrpc: "2.0", id: 31, method: "$/fixtures/flip-schema" });
		assert.equal(flip.body.result.schemaEpoch, 1);
		const after = await call(fixture, headers, { jsonrpc: "2.0", id: 32, method: "tools/list", params: { cursor: "echo" } });
		const echoAfter = after.body.result.tools.find((tool) => tool.name === "echo");
		assert.deepEqual(echoAfter.inputSchema.required, ["payload"]);
		const echo = await call(fixture, headers, { jsonrpc: "2.0", id: 33, method: "tools/call", params: { name: "echo", arguments: { payload: "p" } } });
		assert.match(echo.body.result.content[0].text, /epoch 1/);
	});
});

test("server pushes tools/list_changed notifications to open SSE streams", async () => {
	const fixture = await startMcpHttpServer({});
	try {
		const { headers } = await initialize(fixture);
		const stream = await fetch(fixture.url, { headers: { accept: "text/event-stream", "mcp-session-id": headers["mcp-session-id"] } });
		assert.equal(stream.status, 200);
		const reader = stream.body.getReader();
		const decoder = new TextDecoder();
		let text = "";
		const deadline = Date.now() + 5_000;
		while (Date.now() < deadline) {
			const chunk = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve(undefined), 500))]);
			if (!chunk) continue;
			text += decoder.decode(chunk.value, { stream: true });
			if (text.includes(": connected")) break;
		}
		assert.ok(text.includes(": connected"));
		const push = await call(fixture, headers, { jsonrpc: "2.0", id: 40, method: "$/fixtures/notify-list-changed" });
		assert.equal(push.body.result.notified, 1);
		let events = "";
		while (Date.now() < deadline) {
			const chunk = await Promise.race([reader.read(), new Promise((resolve) => setTimeout(() => resolve(undefined), 500))]);
			if (!chunk) continue;
			events += decoder.decode(chunk.value, { stream: true });
			if (events.includes("notifications/tools/list_changed")) break;
		}
		assert.match(events, /event: message\ndata: .*notifications\/tools\/list_changed/);
		await reader.cancel();
	} finally {
		await fixture.close();
	}
});
