import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// Real local MCP Streamable-HTTP fixture (P1-Q). Deterministic, loopback only, ephemeral port,
// no credentials. Scenario surface for Skill/MCP transport tests (K5, P2-S):
//   - initialize handshake with protocol negotiation and mcp-session-id
//   - 404 on unknown/stale sessions (session rebuild)
//   - tools/list pagination via params.cursor / result._meta.nextCursor
//   - tools/call echo, failing tool, and a slow tool targetable by JSON-RPC cancellation
//   - schema drift: $/fixtures/flip-schema flips the echo tool inputSchema (R5.4 re-activation)
//   - server-initiated notifications/tools/list_changed pushed to open SSE streams
//     ($/fixtures/notify-list-changed)
// Importable API: startMcpHttpServer(options) / withMcpHttpServer(options, run).
// Standalone: node test/fixtures/mcp-http-server.mjs [port] -> prints {"port":N,"url":...}.

const KNOWN_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const echoSchemas = [
	{ type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
	{ type: "object", properties: { payload: { type: "string" }, count: { type: "number" } }, required: ["payload"], additionalProperties: false },
];

export function startMcpHttpServer(options = {}) {
	const toolCount = options.toolCount ?? 6;
	const pageSize = options.pageSize ?? 3;
	const slowToolMs = options.slowToolMs ?? 200;
	const requestLog = [];
	const sessions = new Set();
 const streams = new Set();
	const inFlight = new Map();
	let schemaEpoch = 0;
	const toolNames = Array.from({ length: toolCount }, (_unused, index) => `fixture-tool-${index + 1}`);
	const json = (response, status, body) => {
		response.writeHead(status, { "content-type": "application/json" });
		response.end(JSON.stringify(body));
	};
	const tools = () => [
		...toolNames.map((name) => ({
			name,
			description: `Deterministic fixture tool ${name}`,
			inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false },
		})),
		{
			name: "echo",
			description: `Echoes its argument (schema epoch ${schemaEpoch})`,
			inputSchema: echoSchemas[schemaEpoch % echoSchemas.length],
		},
		{ name: "fail", description: "Always reports a tool error", inputSchema: { type: "object", additionalProperties: false } },
		{ name: "slow", description: "Waits before echoing; cancellable", inputSchema: { type: "object", properties: { value: { type: "string" } }, additionalProperties: false } },
	];

	const handle = async (request, response, body) => {
		const message = JSON.parse(body || "{}");
		if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
		const headerVersion = request.headers["mcp-protocol-version"];
		if (typeof headerVersion === "string" && !KNOWN_PROTOCOL_VERSIONS.includes(headerVersion))
			return json(response, 400, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32600, message: "Unsupported protocol version" } });
		const session = request.headers["mcp-session-id"];
		if (message.method !== "initialize") {
			if (typeof session !== "string" || !sessions.has(session))
				return json(response, 404, { jsonrpc: "2.0", id: message.id ?? null, error: { code: -32001, message: "Session not found; reinitialize" } });
		}
		if (message.id === undefined || message.id === null) {
			// Notification
			if (message.method === "notifications/cancelled") {
				const pending = inFlight.get(message.params?.requestId);
				if (pending) {
					clearTimeout(pending.timer);
					inFlight.delete(message.params?.requestId);
					pending.cancel(new Error("Request cancelled"));
				}
				response.writeHead(202);
				response.end();
				return;
			}
			response.writeHead(202);
			response.end();
			return;
		}
		const reply = (payload) => json(response, 200, payload);
		if (message.method === "initialize") {
			const requested = message.params?.protocolVersion;
			const negotiated = KNOWN_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION;
			const id = randomUUID();
			sessions.add(id);
			response.setHeader("mcp-session-id", id);
			return reply({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: negotiated, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "pi861-mcp-http-fixture", version: "1" } } });
		}
		if (message.method === "tools/list") {
			const all = tools();
			const cursor = typeof message.params?.cursor === "string" ? message.params.cursor : undefined;
			const startIndex = cursor ? all.findIndex((tool) => tool.name === cursor) : 0;
			if (startIndex < 0) return reply({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown cursor" } });
			const page = all.slice(startIndex, startIndex + pageSize);
			const next = all[startIndex + pageSize];
			return reply({ jsonrpc: "2.0", id: message.id, result: { tools: page, ...(next ? { _meta: { nextCursor: next.name } } : {}) } });
		}
		if (message.method === "tools/call") {
			const name = message.params?.name;
			const args = message.params?.arguments ?? {};
			if (name === "fail") return reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "fixture tool failure" }], isError: true } });
			if (name === "slow") {
				return await new Promise((resolve) => {
					const finish = (text) => {
						inFlight.delete(message.id);
						resolve(reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } }));
					};
					const timer = setTimeout(() => finish(`slow echo ${JSON.stringify(args)}`), slowToolMs);
					inFlight.set(message.id, { timer, cancel: () => resolve(reply({ jsonrpc: "2.0", id: message.id, error: { code: -32800, message: "Request cancelled" } })) });
				});
			}
			if (name === "echo")
				return reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `epoch ${schemaEpoch}: ${JSON.stringify(args)}` }] } });
			if (toolNames.includes(name))
				return reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: `${name} ok` }] } });
			return reply({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "Unknown tool" } });
		}
		if (message.method === "$/fixtures/flip-schema") {
			schemaEpoch += 1;
			return reply({ jsonrpc: "2.0", id: message.id, result: { schemaEpoch } });
		}
		if (message.method === "$/fixtures/notify-list-changed") {
			for (const stream of streams) stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`);
			return reply({ jsonrpc: "2.0", id: message.id, result: { notified: streams.size } });
		}
		return reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
	};

	const server = createServer((request, response) => {
		const chunks = [];
		request.on("data", (chunk) => chunks.push(chunk));
		request.on("error", () => {});
		request.on("end", () => {
			const body = Buffer.concat(chunks).toString("utf8");
			const pathOnly = (request.url ?? "").split("?")[0];
			requestLog.push({ method: request.method, path: pathOnly, session: request.headers["mcp-session-id"] ?? null, body });
			if (request.method === "POST" && pathOnly === "/mcp") {
				handle(request, response, body).catch(() => {
					if (!response.headersSent) json(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
					else response.end();
				});
				return;
			}
			if (request.method === "GET" && pathOnly === "/mcp") {
				if (!request.headers.accept?.includes("text/event-stream")) return json(response, 405, { error: "event-stream accept required" });
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				response.write(": connected\n\n");
				streams.add(response);
				response.on("close", () => streams.delete(response));
				return;
			}
			if (request.method === "DELETE" && pathOnly === "/mcp") {
				const session = request.headers["mcp-session-id"];
				if (typeof session === "string") sessions.delete(session);
				response.writeHead(202);
				response.end();
				return;
			}
			json(response, 404, { error: "no fixture route" });
		});
	});

	return new Promise((resolve) => {
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			const port = server.address().port;
			resolve({
				url: `http://127.0.0.1:${port}/mcp`,
				port,
				requestLog,
				sessions,
				currentSchemaEpoch: () => schemaEpoch,
				close: () => {
					for (const pending of inFlight.values()) clearTimeout(pending.timer);
					inFlight.clear();
					for (const stream of streams) stream.destroy();
					streams.clear();
					return new Promise((done) => {
						server.closeAllConnections();
						server.close(() => done());
					});
				},
			});
		});
	});
}

export async function withMcpHttpServer(options, run) {
	const fixture = await startMcpHttpServer(options);
	try {
		return await run(fixture);
	} finally {
		await fixture.close();
	}
}

if (process.argv[1]?.endsWith("mcp-http-server.mjs") && process.argv.length > 1) {
	const requested = Number(process.argv[2]);
	const fixture = await startMcpHttpServer(Number.isSafeInteger(requested) && requested > 0 ? { port: requested } : {});
	process.stdout.write(`${JSON.stringify({ port: fixture.port, url: fixture.url })}\n`);
	process.on("SIGTERM", async () => {
		await fixture.close();
		process.exit(0);
	});
}
