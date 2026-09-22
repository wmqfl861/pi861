import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { McpClient } from "../src/live/mcp.ts";
const signal = () => new AbortController().signal;
const schema = { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false };
test("real stdio MCP process: initialize, discover and call", async t => {
  const client = new McpClient({ id: "local", accountId: "test", transport: { kind: "stdio", process: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], cwd: process.cwd() } } });
  t.after(() => client.close());
  const tools = await client.tools(signal()); assert.equal(tools.length, 1);
  assert.equal((await client.call("lookup", { project: "p" }, tools[0].schemaHash, signal())).content[0].text, "looked up p");
  await assert.rejects(client.call("lookup", {}, "old-schema", signal()), /schema changed/);
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
test("unsafe remote plain HTTP is rejected", () => {
  assert.throws(() => new McpClient({ id: "x", accountId: "a", transport: { kind: "http", url: "http://example.com/mcp" } }), /HTTPS/);
});
