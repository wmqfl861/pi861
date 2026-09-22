let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    const request = JSON.parse(line); if (!request.id) continue;
    let result;
    if (request.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } } };
    else if (request.method === "tools/list") result = { tools: [{ name: "lookup", description: "Read project data", inputSchema: { type: "object", properties: { project: { type: "string" } }, required: ["project"], additionalProperties: false } }] };
    else if (request.method === "tools/call") result = { content: [{ type: "text", text: `looked up ${request.params.arguments.project}` }] };
    else { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unsupported" } }) + "\n"); continue; }
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
  }
});
