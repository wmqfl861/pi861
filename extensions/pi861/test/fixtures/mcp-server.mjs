// Deterministic local MCP fixture for protocol and capability-host tests.
// Behavior is driven by environment variables so one script covers every scenario:
//   MCP_ACCOUNT     - echoed into lookup results, distinguishing same-server accounts
//   MCP_CONTROL     - when this file exists, tools/list serves schema v2 (inputSchema flip)
//   MCP_PAGE_SIZE   - paginate tools/list into pages of this size using cursors
//   MCP_LOOP_CURSOR - always return the same nextCursor to simulate a cursor loop
//   MCP_NOTIFY_LIST - emit a list_changed notification after this tools/list number
//   MCP_NOTIFY_KIND - which list_changed to emit: tools (default), resources or prompts
//   MCP_DELAY_MS    - the slow tool waits this long before responding
//   MCP_HUGE_BYTES  - the huge tool returns a text payload of this size
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const number = (name, fallback) => Number(process.env[name] ?? fallback) || fallback;
const account = process.env.MCP_ACCOUNT ?? "";
const control = process.env.MCP_CONTROL ?? "";
const pageSize = number("MCP_PAGE_SIZE", 0);
const loopCursor = process.env.MCP_LOOP_CURSOR === "1";
const notifyOnList = number("MCP_NOTIFY_LIST", 0);
const notifyKind = process.env.MCP_NOTIFY_KIND ?? "tools";
const counters = { lists: 0, calls: 0, submits: 0, cancelled: 0 };

const schemaV1 = { type: "object", properties: { project: { type: "string" }, mode: { type: "string" } }, required: ["project"], additionalProperties: false };
const schemaV2 = { type: "object", properties: { project: { type: "string" }, mode: { type: "string" } }, required: ["project", "mode"], additionalProperties: false };
const emptySchema = { type: "object", properties: {}, additionalProperties: false };

function tools() {
  return [
    { name: "lookup", description: `Read project data${account ? ` for account ${account}` : ""}`, inputSchema: control && existsSync(control) ? schemaV2 : schemaV1 },
    { name: "submit", description: "Write project data (counted side effect)", inputSchema: schemaV1 },
    { name: "slow", description: "Responds after the configured delay", inputSchema: emptySchema },
    { name: "huge", description: "Returns an oversized payload", inputSchema: emptySchema },
    { name: "stats", description: "Server-side counters for test assertions", inputSchema: emptySchema },
  ];
}

async function handleCall(params) {
  counters.calls += 1;
  if (params.name === "lookup") return { content: [{ type: "text", text: `looked up ${params.arguments.project}${account ? ` via account ${account}` : ""}` }] };
  if (params.name === "submit") { counters.submits += 1; return { content: [{ type: "text", text: `submitted change ${counters.submits}` }] }; }
  if (params.name === "slow") { await delay(number("MCP_DELAY_MS", 0)); return { content: [{ type: "text", text: "slow tool finished" }] }; }
  if (params.name === "huge") return { content: [{ type: "text", text: "x".repeat(number("MCP_HUGE_BYTES", 4096)) }] };
  if (params.name === "stats") return { content: [{ type: "text", text: JSON.stringify(counters) }] };
  return { isError: true, content: [{ type: "text", text: `unknown tool ${params.name}` }] };
}

async function handleLine(line) {
  const message = JSON.parse(line);
  if (!message.id) {
    // Notifications from the client, e.g. notifications/cancelled for an abandoned call.
    if (message.method === "notifications/cancelled") counters.cancelled += 1;
    return;
  }
  const write = value => process.stdout.write(JSON.stringify(value) + "\n");
  if (message.method === "initialize") {
    write({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } } } });
    return;
  }
  if (message.method === "tools/list") {
    counters.lists += 1;
    const all = tools();
    let result;
    if (loopCursor) result = message.params?.cursor ? { tools: [] } : { tools: all };
    else if (!pageSize) result = { tools: all };
    else {
      const start = message.params?.cursor ? Number(message.params.cursor) : 0;
      result = { tools: all.slice(start, start + pageSize) };
      if (start + pageSize < all.length) result.nextCursor = String(start + pageSize);
    }
    if (loopCursor) result.nextCursor = "loop";
    // The notification is written in the same stdout chunk as the response: the client caches the
    // stale list and must notice the announcement even though it arrives with the listing itself.
    const frames = [JSON.stringify({ jsonrpc: "2.0", id: message.id, result })];
    if (notifyOnList && counters.lists === notifyOnList) {
      frames.push(JSON.stringify({ jsonrpc: "2.0", method: `notifications/${notifyKind}/list_changed` }));
    }
    process.stdout.write(frames.map(frame => `${frame}\n`).join(""));
    return;
  }
  if (message.method === "tools/call") { write({ jsonrpc: "2.0", id: message.id, result: await handleCall(message.params) }); return; }
  write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported" } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    void handleLine(line);
  }
});
