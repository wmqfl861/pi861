import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { McpClient, McpFailure } from "../src/live/mcp.ts";

const signal = () => new AbortController().signal;
const fixture = (t, env = {}) => {
  const client = new McpClient({ id: "local", accountId: "test", transport: { kind: "stdio", process: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], cwd: process.cwd(), env } }, ...("maxBytes" in env ? { maxBytes: env.maxBytes } : {}), ...("timeoutMs" in env ? { timeoutMs: env.timeoutMs } : {}) });
  t.after(() => client.close());
  return client;
};
const schema = { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false };
const callCounters = async (client) => JSON.parse((await client.call("stats", {}, (await client.tools(signal())).find(tool => tool.name === "stats").schemaHash, signal())).content[0].text);

test("real stdio MCP process: initialize, discover and call", async t => {
  const client = fixture(t);
  const tools = await client.tools(signal()); assert.equal(tools.length, 5);
  assert.equal((await client.call("lookup", { project: "p" }, tools[0].schemaHash, signal())).content[0].text, "looked up p");
  await assert.rejects(client.call("lookup", {}, "old-schema", signal()), /schema changed/);
});
test("multi-page tools/list walks every cursor page", async t => {
  const client = fixture(t, { MCP_PAGE_SIZE: 2 });
  const tools = await client.tools(signal());
  assert.deepEqual(tools.map(tool => tool.name), ["lookup", "submit", "slow", "huge", "stats"]);
  // The stats read forces one more full walk inside the call's schema re-check (the helper's own
  // listing is served from cache): 3 + 3 pages in total.
  assert.equal((await callCounters(client)).lists, 6);
});
test("a repeated pagination cursor is rejected as a loop", async t => {
  const client = fixture(t, { MCP_LOOP_CURSOR: "1" });
  await assert.rejects(client.tools(signal()), /pagination/);
});
test("list_changed after a cached listing keeps the cache invalid", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi861-mcp-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const client = fixture(t, { MCP_NOTIFY_LIST: 2, MCP_CONTROL: join(directory, "flip") });
  const first = await client.tools(signal()); // listing 1: schema v1, cached clean
  assert.deepEqual(first[0].inputSchema.required, ["project"]);
  await client.tools(signal(), true); // listing 2: v1 again, then the server announces a change
  writeFileSync(join(directory, "flip"), "v2");
  // Unforced listing must re-query because the notification arrived during listing 2.
  const third = await client.tools(signal());
  assert.deepEqual(third[0].inputSchema.required, ["project", "mode"]);
});
test("resources and prompts list_changed notifications also invalidate", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi861-mcp-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const kind of ["resources", "prompts"]) {
    const client = fixture(t, { MCP_NOTIFY_LIST: 2, MCP_NOTIFY_KIND: kind, MCP_CONTROL: join(directory, `flip-${kind}`) });
    await client.tools(signal());
    await client.tools(signal(), true); // listing 2 carries the notification in the same stdout chunk
    writeFileSync(join(directory, `flip-${kind}`), "v2");
    const refreshed = await client.tools(signal());
    assert.deepEqual(refreshed[0].inputSchema.required, ["project", "mode"], `${kind} notification must keep the cache invalid`);
  }
});
test("aborting a dispatched call notifies cancellation and stays unknown", async t => {
  const client = fixture(t, { MCP_DELAY_MS: 1500 });
  const tool = (await client.tools(signal())).find(item => item.name === "slow");
  const controller = new AbortController();
  const pending = client.call("slow", {}, tool.schemaHash, controller.signal);
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, error => error instanceof McpFailure && error.outcome === "unknown" && /cancelled/.test(error.message));
  const counters = await callCounters(client);
  assert.ok(counters.cancelled >= 1, "server must observe notifications/cancelled");
});
test("a stalled server call fails within the bounded timeout", async t => {
  const client = fixture(t, { MCP_DELAY_MS: 30_000, timeoutMs: 150 });
  const tool = (await client.tools(signal())).find(item => item.name === "slow");
  const started = Date.now();
  await assert.rejects(client.call("slow", {}, tool.schemaHash, signal()), error => error instanceof McpFailure && error.outcome === "unknown");
  assert.ok(Date.now() - started < 5_000, "timeout must be bounded");
});
test("an oversized stdio record is rejected", async t => {
  const client = fixture(t, { MCP_HUGE_BYTES: 262_144, maxBytes: 8_192 });
  const tool = (await client.tools(signal())).find(item => item.name === "huge");
  await assert.rejects(client.call("huge", {}, tool.schemaHash, signal()), /large|failed/);
});
for (const mode of ["json", "sse"]) test(`real HTTP MCP ${mode}: session and protocol headers`, async t => {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const input = JSON.parse(body); seen.push({ input, headers: req.headers });
    if (!input.id) { res.writeHead(202).end(); return; }
    let result;
    if (input.method === "initialize") { res.setHeader("Mcp-Session-Id", "s-test"); result = { protocolVersion: "2025-11-25", capabilities: { tools: {} } }; }
    else if (input.method === "tools/list") result = { tools: [{ name: "lookup", inputSchema: schema }] };
    else result = { content: [{ type: "text", text: "ok" }] };
    const output = JSON.stringify({ jsonrpc: "2.0", id: input.id, result });
    res.setHeader("Content-Type", mode === "sse" ? "text/event-stream" : "application/json");
    res.end(mode === "sse" ? `: ping\r\n\r\ndata: ${output}\r\n\r\n` : output);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const client = new McpClient({ id: "http", accountId: "test", transport: { kind: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, allowLoopbackHttp: true, headers: { Authorization: "Bearer test-only" } } });
  t.after(() => client.close()); const [tool] = await client.tools(signal()); await client.call("lookup", { project: "p" }, tool.schemaHash, signal());
  assert.equal(seen[1].headers["mcp-session-id"], "s-test"); assert.equal(seen[1].headers["mcp-protocol-version"], "2025-11-25");
});
test("HTTP 404 invalidates the session and the next call re-initializes", async t => {
  const methods = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const input = JSON.parse(body);
    if (!input.id) { res.writeHead(202).end(); return; }
    methods.push(input.method);
    if (input.method === "tools/list" && methods.filter(method => method === "tools/list").length === 2) { res.writeHead(404).end(); return; }
    let result;
    if (input.method === "initialize") { res.setHeader("Mcp-Session-Id", "s-test"); result = { protocolVersion: "2025-11-25", capabilities: { tools: {} } }; }
    else if (input.method === "tools/list") result = { tools: [{ name: "lookup", inputSchema: schema }] };
    else result = { content: [{ type: "text", text: "ok" }] };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const client = new McpClient({ id: "http404", accountId: "test", transport: { kind: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, allowLoopbackHttp: true } });
  t.after(() => client.close());
  await client.tools(signal()); // initialize + listing 1
  await assert.rejects(client.tools(signal(), true), error => error instanceof McpFailure && error.outcome === "not_dispatched");
  const refreshed = await client.tools(signal()); // session was reset: initialize again
  assert.equal(refreshed.length, 1);
  assert.equal(methods.filter(method => method === "initialize").length, 2);
});
test("an SSE stream that ends before its response stays unknown", async t => {
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    const input = JSON.parse(body);
    if (!input.id) { res.writeHead(202).end(); return; }
    if (input.method === "initialize") {
      res.setHeader("Mcp-Session-Id", "s-test"); res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } }));
      return;
    }
    if (input.method === "tools/list") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: { tools: [{ name: "lookup", inputSchema: schema }] } }));
      return;
    }
    // tools/call: SSE that closes without ever delivering the response frame.
    res.setHeader("Content-Type", "text/event-stream");
    res.end(": ping\r\n\r\n");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => server.close());
  const client = new McpClient({ id: "httpsse", accountId: "test", transport: { kind: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, allowLoopbackHttp: true } });
  t.after(() => client.close());
  const [tool] = await client.tools(signal());
  await assert.rejects(client.call("lookup", { project: "p" }, tool.schemaHash, signal()),
    error => error instanceof McpFailure && error.outcome === "unknown" && /stream ended/.test(error.message));
});
test("unsafe remote plain HTTP is rejected", () => {
  assert.throws(() => new McpClient({ id: "x", accountId: "a", transport: { kind: "http", url: "http://example.com/mcp" } }), /HTTPS/);
});

// ---------------------------------------------------------------------------
// P2-S additions (K5): Streamable HTTP protocol completeness against the real
// local P1-Q fixture (test/fixtures/mcp-http-server.mjs, imported read-only
// from P1-Q @ dd8131966): handshake negotiation, _meta pagination, GET-stream
// notifications, schema drift, JSON-RPC cancellation and 404 session rebuild.
// ---------------------------------------------------------------------------

import { startMcpHttpServer } from "./fixtures/mcp-http-server.mjs";

const httpFixture = (t, options = {}) => {
  const client = { fixture: undefined, client: undefined };
  return startMcpHttpServer(options).then(async fixture => {
    t.after(() => fixture.close());
    const instance = new McpClient({
      id: "qfix", accountId: "test",
      transport: { kind: "http", url: fixture.url, allowLoopbackHttp: true },
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    t.after(() => instance.close());
    client.fixture = fixture;
    client.client = instance;
    return client;
  });
};
const fixtureControl = (fixture, session, method, params = {}) =>
  fetch(fixture.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(session ? { "Mcp-Session-Id": session, "MCP-Protocol-Version": "2025-06-18" } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: `ctrl-${Math.random()}`, method, params }),
  }).then(response => response.json());

test("K5 fixture: negotiated handshake, _meta pagination and session headers", async t => {
  const { fixture, client } = await httpFixture(t, { toolCount: 6, pageSize: 3 });
  const tools = await client.tools(signal());
  assert.equal(tools.length, 9); // 6 fixture tools + echo + fail + slow
  assert.equal(new Set(tools.map(tool => tool.name)).size, 9);
  // The client requested 2025-11-25; the fixture knows it, so negotiation echoes it back.
  assert.equal(client.sessionId !== undefined, true);
  const lists = fixture.requestLog.filter(entry => entry.method === "POST" && entry.body.includes('"tools/list"'));
  assert.equal(lists.length, 3); // three cursor pages, no extra listings
  assert.ok(lists.every(entry => typeof entry.session === "string"));
  assert.equal(fixture.requestLog.some(entry => entry.body.includes('"initialize"')), true);
});

test("K5 fixture: list_changed over the standing GET stream invalidates the cached tools", async t => {
  const { fixture, client } = await httpFixture(t);
  await client.tools(signal());
  const listsBefore = fixture.requestLog.filter(entry => entry.body.includes('"tools/list"')).length;
  await client.tools(signal()); // cached: no new listing
  assert.equal(fixture.requestLog.filter(entry => entry.body.includes('"tools/list"')).length, listsBefore);
  // Wait until the client's standing stream is registered with the fixture.
  let notified = 0;
  for (let attempt = 0; attempt < 50 && notified === 0; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 50));
    const reply = await fixtureControl(fixture, client.sessionId, "$/fixtures/notify-list-changed");
    notified = reply?.result?.notified ?? 0;
  }
  assert.ok(notified >= 1, "the client must hold an open GET event stream");
  const echoBefore = (await client.tools(signal())).find(tool => tool.name === "echo").schemaHash;
  await fixtureControl(fixture, client.sessionId, "$/fixtures/flip-schema");
  await fixtureControl(fixture, client.sessionId, "$/fixtures/notify-list-changed");
  let echoAfter = echoBefore;
  for (let attempt = 0; attempt < 50 && echoAfter === echoBefore; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 40));
    echoAfter = (await client.tools(signal())).find(tool => tool.name === "echo").schemaHash;
  }
  assert.notEqual(echoAfter, echoBefore, "the pushed notification must invalidate the cached listing");
});

test("K5 fixture: schema drift refuses dispatch and reactivation is required", async t => {
  const { fixture, client } = await httpFixture(t);
  const echo = (await client.tools(signal())).find(tool => tool.name === "echo");
  await fixtureControl(fixture, client.sessionId, "$/fixtures/flip-schema");
  await assert.rejects(
    client.call("echo", { message: "x" }, echo.schemaHash, signal()),
    error => error instanceof McpFailure && error.outcome === "not_dispatched" && /schema changed/.test(error.message));
});

test("K5 fixture: aborting a dispatched call sends notifications/cancelled and stays unknown", async t => {
  const { fixture, client } = await httpFixture(t, { slowToolMs: 400 });
  const slow = (await client.tools(signal())).find(tool => tool.name === "slow");
  const controller = new AbortController();
  const pending = client.call("slow", { value: "x" }, slow.schemaHash, controller.signal);
  setTimeout(() => controller.abort(), 80);
  await assert.rejects(pending, error => error instanceof McpFailure && error.outcome === "unknown");
  let cancelledSeen = false;
  for (let attempt = 0; attempt < 50 && !cancelledSeen; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 40));
    cancelledSeen = fixture.requestLog.some(entry => entry.method === "POST" && entry.body.includes("notifications/cancelled"));
  }
  assert.ok(cancelledSeen, "the client must notify the server about the abandoned request");
});

test("K5 fixture: a deleted session 404s once and the client rebuilds transparently", async t => {
  const { fixture, client } = await httpFixture(t);
  await client.tools(signal());
  const response = await fetch(fixture.url, {
    method: "DELETE",
    headers: { "Mcp-Session-Id": String(client.sessionId), "MCP-Protocol-Version": "2025-06-18" },
  });
  assert.equal(response.status, 202);
  await assert.rejects(client.tools(signal(), true), error => error instanceof McpFailure && error.outcome === "not_dispatched");
  const rebuilt = await client.tools(signal());
  assert.equal(rebuilt.length, 9);
  assert.equal(fixture.requestLog.filter(entry => entry.body.includes('"initialize"')).length, 2);
});
