import { randomUUID } from "node:crypto";
import { Compile } from "typebox/compile";
import { digest } from "../memory.ts";
import { record } from "../search.ts";
import { LineProcess, type ProcessSpec } from "./line-process.ts";

export interface McpTool {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	schemaHash: string;
}
export type McpTransport =
	| { kind: "stdio"; process: ProcessSpec }
	| { kind: "http"; url: string; headers?: Record<string, string>; allowLoopbackHttp?: boolean };
export interface McpServer {
	id: string;
	accountId: string;
	transport: McpTransport;
	timeoutMs?: number;
	maxBytes?: number;
	deploymentMode?: "trusted-local" | "isolated";
	/** Trusted deployment assertion; this client does not implement an OS sandbox. */
	isolatedTransportApproved?: boolean;
}
export class McpFailure extends Error {
	readonly outcome: "not_dispatched" | "unknown" | "reported_error";
	constructor(message: string, outcome: McpFailure["outcome"]) {
		super(message);
		this.outcome = outcome;
	}
}

/** A bounded tool client, not an OAuth broker. Endpoint credentials are resolved by the trusted host. */
export class McpClient {
	readonly server: McpServer;
	private process: LineProcess | undefined;
	private connected: Promise<void> | undefined;
	private session: string | undefined;
	private protocol = "2025-11-25";
	private generation = 0;
	private dirty = true;
	private changeToken = 0;
	private cached: McpTool[] = [];
	private lifetime = new AbortController();
	private closing: Promise<void> = Promise.resolve();
	private stream: AbortController | undefined;
	constructor(server: McpServer) {
		if (!/^[a-zA-Z0-9_-]+$/.test(server.id) || !server.accountId) throw new Error("Invalid MCP server identity");
		for (const value of [server.timeoutMs, server.maxBytes]) {
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error("Invalid MCP limit");
		}
		if (server.deploymentMode === "isolated" && !server.isolatedTransportApproved)
			throw new Error("Isolated MCP requires a transport approved by the deployment operator");
		if (server.transport.kind === "http") {
			const endpoint = new URL(server.transport.url);
			const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
			if (
				endpoint.username ||
				endpoint.password ||
				endpoint.hash ||
				(endpoint.protocol !== "https:" &&
					!(endpoint.protocol === "http:" && local && server.transport.allowLoopbackHttp))
			) {
				throw new Error("MCP requires HTTPS, or explicitly allowed loopback HTTP");
			}
		}
		this.server = structuredClone(server);
	}
	private message(event: Record<string, unknown>): void {
		if (
			typeof event.method === "string" &&
			/^notifications\/(tools|resources|prompts)\/list_changed$/.test(event.method)
		) {
			this.dirty = true;
			this.changeToken++;
		}
		if (event.type === "process_error") {
			this.connected = undefined;
			this.dirty = true;
		}
		if (event.id !== undefined && typeof event.method === "string") {
			// No model sampling, elicitation or execution initiated by an untrusted server.
			this.process?.send({
				jsonrpc: "2.0",
				id: event.id,
				error: { code: -32601, message: "Client capability not supported" },
			});
		}
	}
	async connect(signal: AbortSignal): Promise<void> {
		signal = AbortSignal.any([signal, this.lifetime.signal]);
		signal.throwIfAborted();
		await this.closing;
		if (!this.connected) {
			const epoch = this.generation;
			this.connected = (async () => {
				if (this.server.transport.kind === "stdio") {
					await this.process?.close();
					signal.throwIfAborted();
					this.process = new LineProcess(this.server.transport.process, this.server.maxBytes);
					this.process.onEvent((event) => this.message(event));
				}
				const reply = record(
					await this.raw(
						"initialize",
						{
							protocolVersion: "2025-11-25",
							capabilities: {},
							clientInfo: { name: "pi861", version: "0.2.0-alpha.1" },
						},
						signal,
					),
				);
				if (
					!reply ||
					!["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(String(reply.protocolVersion)) ||
					!record(reply.capabilities)?.tools
				) {
					throw new Error("Unsupported MCP version or missing tools capability");
				}
				this.protocol = String(reply.protocolVersion);
				await this.notify("notifications/initialized", {}, signal);
				if (
					this.server.transport.kind === "http" &&
					record(record(reply.capabilities)?.tools)?.listChanged === true
				) {
					// Only servers that announce tools.listChanged get a standing GET stream; a server
					// answering 405 has no push channel and requests keep working via POST.
					void this.openNotificationStream();
				}
				if (epoch !== this.generation) throw new Error("Stale MCP connection");
			})().catch(async (error: unknown) => {
				if (epoch === this.generation) {
					this.connected = undefined;
					await this.process?.close();
				}
				throw error;
			});
		}
		await this.connected;
		signal.throwIfAborted();
	}
	private async notify(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<void> {
		const payload = { jsonrpc: "2.0", method, params };
		if (this.process) {
			this.process.send(payload);
			return;
		}
		await this.http(payload, signal);
	}
	/**
	 * Standing GET event stream for server-initiated notifications (Streamable HTTP). Failures are
	 * contained: the stream dying never breaks request/response traffic, and every frame stays
	 * bounded and read-only - server-initiated requests are refused with -32601.
	 */
	private async openNotificationStream(): Promise<void> {
		const transport = this.server.transport;
		if (transport.kind !== "http") return;
		this.stream?.abort();
		const controller = new AbortController();
		this.stream = controller;
		const signal = AbortSignal.any([controller.signal, this.lifetime.signal]);
		const headers: Record<string, string> = {
			...transport.headers,
			Accept: "text/event-stream",
			"MCP-Protocol-Version": this.protocol,
		};
		if (this.session) headers["Mcp-Session-Id"] = this.session;
		try {
			const response = await fetch(transport.url, { method: "GET", headers, signal, redirect: "error" });
			if (response.status === 405 || response.status === 404 || !response.ok || !response.body) {
				await response.body?.cancel();
				return;
			}
			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";
			while (true) {
				const { value, done } = await reader.read();
				if (done) return;
				buffer += decoder.decode(value, { stream: true });
				if (Buffer.byteLength(buffer) > (this.server.maxBytes ?? 4_194_304)) return; // bounded stream
				while (true) {
					const boundary = /\r?\n\r?\n/.exec(buffer);
					if (!boundary) break;
					const frame = buffer.slice(0, boundary.index);
					buffer = buffer.slice(boundary.index + boundary[0].length);
					const data = frame
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).replace(/^ /, ""))
						.join("\n");
					if (!data) continue;
					const message = record(JSON.parse(data));
					if (!message) return;
					this.message(message);
					if (message.id !== undefined && typeof message.method === "string") {
						await this.http(
							{ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported" } },
							new AbortController().signal,
						);
					}
				}
			}
		} catch {
			// A dead push channel is not a connection failure; POST traffic continues.
		}
	}
	/** Current wire session id, for host-side diagnostics on Streamable HTTP connections. */
	get sessionId(): string | undefined {
		return this.session;
	}
	private async http(
		payload: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<Record<string, unknown> | undefined> {
		const transport = this.server.transport;
		if (transport.kind !== "http") throw new Error("MCP process unavailable");
		const effective = AbortSignal.any([signal, AbortSignal.timeout(this.server.timeoutMs ?? 30_000)]);
		const headers: Record<string, string> = {
			...transport.headers,
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (this.session) headers["Mcp-Session-Id"] = this.session;
		if (payload.method !== "initialize") headers["MCP-Protocol-Version"] = this.protocol;
		const response = await fetch(transport.url, {
			method: "POST",
			headers,
			body: JSON.stringify(payload),
			signal: effective,
			redirect: "error",
		});
		if (!response.ok) {
			await response.body?.cancel();
			if (response.status === 404) {
				this.session = undefined;
				this.connected = undefined;
				this.dirty = true;
			}
			throw new McpFailure(
				`MCP HTTP ${response.status}`,
				payload.method === "tools/call" ? "unknown" : "not_dispatched",
			);
		}
		if (payload.method === "initialize") {
			const session = response.headers.get("Mcp-Session-Id");
			if (session && !/^[\x21-\x7e]{1,1024}$/.test(session)) throw new Error("Invalid MCP session header");
			this.session = session ?? undefined;
		}
		if (payload.id === undefined || payload.method === undefined) {
			await response.body?.cancel();
			return undefined;
		}
		if (!response.body) throw new Error("MCP response has no body");
		const isSse = response.headers.get("content-type")?.includes("text/event-stream");
		if (!isSse && !response.headers.get("content-type")?.includes("application/json")) {
			await response.body.cancel();
			throw new Error("Unexpected MCP content type");
		}
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "",
			total = 0;
		const max = this.server.maxBytes ?? 4_194_304;
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > max) throw new Error("MCP response exceeds byte limit");
				buffer += decoder.decode(value, { stream: true });
				if (!isSse) continue;
				while (true) {
					const boundary = /\r?\n\r?\n/.exec(buffer);
					if (!boundary) break;
					const frame = buffer.slice(0, boundary.index);
					buffer = buffer.slice(boundary.index + boundary[0].length);
					const data = frame
						.split(/\r?\n/)
						.filter((line) => line.startsWith("data:"))
						.map((line) => line.slice(5).replace(/^ /, ""))
						.join("\n");
					if (!data) continue;
					const message = record(JSON.parse(data));
					if (!message) throw new Error("Invalid MCP SSE message");
					if (message.id === payload.id && ("result" in message || "error" in message)) return message;
					this.message(message);
					if (message.id !== undefined && typeof message.method === "string") {
						await this.http(
							{ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Not supported" } },
							effective,
						);
					}
				}
			}
			buffer += decoder.decode();
			if (isSse)
				throw new McpFailure("MCP stream ended before its response; do not replay tool operations", "unknown");
			const message = record(JSON.parse(buffer));
			if (!message || message.id !== payload.id) throw new Error("MCP response id mismatch");
			return message;
		} finally {
			await reader.cancel().catch(() => {});
			reader.releaseLock();
		}
	}
	private async raw(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
		signal = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.server.timeoutMs ?? 30_000)]);
		signal.throwIfAborted();
		const id = randomUUID();
		const payload = { jsonrpc: "2.0", method, params, id };
		let dispatched = false;
		// Client-side abandonment alone leaves the server working blindly; tell it the request is
		// cancelled. The dispatch outcome stays unknown either way, so cancellation is never a replay license.
		const onAbort = (): void => {
			if (dispatched) this.notifyCancelled(id);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		let reply: Record<string, unknown> | undefined;
		try {
			if (this.process) {
				signal.throwIfAborted();
				const pending = this.process.request(payload, signal, this.server.timeoutMs ?? 30_000);
				dispatched = true;
				reply = await pending;
			} else {
				signal.throwIfAborted();
				dispatched = true;
				reply = await this.http(payload, signal);
			}
		} catch (error) {
			if (error instanceof McpFailure) throw error;
			throw new McpFailure(
				signal.aborted ? "MCP call cancelled; reconcile any dispatched operation" : "MCP transport failed",
				method === "tools/call" ? "unknown" : "not_dispatched",
			);
		} finally {
			signal.removeEventListener("abort", onAbort);
		}
		if (reply?.error) throw new McpFailure("MCP server reported an operation error", "reported_error");
		if (!reply || !("result" in reply)) throw new Error("Missing MCP result");
		return reply.result;
	}
	/** Best effort: a notification for an id the server never saw is harmlessly ignored by JSON-RPC rules. */
	private notifyCancelled(id: string): void {
		void this.notify(
			"notifications/cancelled",
			{ requestId: id, reason: "client aborted the request" },
			new AbortController().signal,
		).catch(() => {
			/* the connection may already be gone; the outcome remains unknown */
		});
	}
	async tools(signal: AbortSignal, refresh = false): Promise<McpTool[]> {
		await this.connect(signal);
		if (!this.dirty && !refresh) return structuredClone(this.cached);
		// A list_changed notification that arrives while the listing is in flight must survive it:
		// the fetched list predates the announced change, so only clear dirty when no notification
		// was observed since the fetch started.
		const token = this.changeToken;
		const tools: McpTool[] = [],
			seen = new Set<string>(),
			cursors = new Set<string>();
		let cursor: string | undefined;
		for (let page = 0; page < 100; page++) {
			const result = record(await this.raw("tools/list", cursor ? { cursor } : {}, signal));
			if (!result || !Array.isArray(result.tools)) throw new Error("Invalid MCP tool list");
			for (const value of result.tools) {
				const tool = record(value);
				if (
					!tool ||
					typeof tool.name !== "string" ||
					!/^[\w./:-]{1,128}$/.test(tool.name) ||
					!record(tool.inputSchema) ||
					seen.has(tool.name)
				)
					throw new Error("Invalid or duplicate MCP tool");
				seen.add(tool.name);
				const inputSchema = tool.inputSchema as Record<string, unknown>;
				tools.push({
					name: tool.name,
					description: typeof tool.description === "string" ? tool.description.slice(0, 16_000) : tool.name,
					inputSchema,
					schemaHash: digest({ name: tool.name, inputSchema }),
				});
				if (tools.length > 10_000) throw new Error("MCP tool list too large");
			}
			// Spec places the cursor at result.nextCursor; some servers send result._meta.nextCursor.
			const meta = record(result._meta);
			const nextCursor =
				typeof result.nextCursor === "string"
					? result.nextCursor
					: typeof meta?.nextCursor === "string"
						? meta.nextCursor
						: undefined;
			if (!nextCursor) {
				this.cached = tools;
				if (token === this.changeToken) this.dirty = false;
				return structuredClone(tools);
			}
			if (cursors.has(nextCursor)) throw new Error("Invalid MCP pagination");
			cursor = nextCursor;
			cursors.add(cursor);
		}
		throw new Error("MCP pagination limit exceeded");
	}
	async call(
		name: string,
		args: Record<string, unknown>,
		schemaHash: string,
		signal: AbortSignal,
		beforeDispatch?: () => void,
	): Promise<unknown> {
		const generation = this.generation;
		// Fresh metadata on every dispatch is intentional: servers need not announce schema changes.
		const tool = (await this.tools(signal, true)).find((item) => item.name === name);
		if (!tool || tool.schemaHash !== schemaHash)
			throw new McpFailure("MCP schema changed; reactivate the skill", "not_dispatched");
		if (!Compile(tool.inputSchema).Check(args))
			throw new McpFailure("MCP arguments do not match the approved schema", "not_dispatched");
		signal.throwIfAborted();
		if (generation !== this.generation)
			throw new McpFailure("MCP connection closed before dispatch", "not_dispatched");
		beforeDispatch?.();
		return this.raw("tools/call", { name, arguments: args }, signal); // Deliberately never retry.
	}
	close(): Promise<void> {
		this.generation++;
		this.stream?.abort();
		this.stream = undefined;
		this.lifetime.abort(new Error("MCP client closed"));
		this.lifetime = new AbortController();
		const closing = this.process?.close() ?? Promise.resolve();
		this.closing = Promise.all([this.closing, closing]).then(() => {});
		this.process = undefined;
		this.connected = undefined;
		this.session = undefined;
		this.dirty = true;
		return this.closing;
	}
}
