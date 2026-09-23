import { record, webSearch } from "../search.ts";
import { abortable } from "../web-control.ts";

export type RealAcceptanceKind = "search" | "model" | "mcp";
export interface RealAcceptanceReport {
	kind: RealAcceptanceKind;
	status: "deferred" | "passed" | "failed";
	requests: number;
	budget: number;
	message: string;
	evidence: string;
}
/** Operator opt-in only. No files, business tool calls, ambient prompts, retries or response text are retained. */
export async function runRealAcceptance(
	kind: RealAcceptanceKind,
	env: Record<string, string | undefined> = process.env,
	transport: typeof fetch = fetch,
): Promise<RealAcceptanceReport> {
	const prefix = `PI861_REAL_${kind.toUpperCase()}`;
	const budget = Number(env[`${prefix}_BUDGET`] ?? "0");
	const keyName = kind === "search" ? "BRAVE_SEARCH_API_KEY" : env[`${prefix}_KEY_ENV`];
	const key = keyName ? env[keyName] : undefined;
	let requests = 0;
	const output = (status: RealAcceptanceReport["status"], message: string): RealAcceptanceReport => ({
		kind,
		status,
		requests,
		budget: Number.isSafeInteger(budget) ? budget : 0,
		message,
		evidence: "Only service connectivity and protocol shape; not model quality or business-task acceptance.",
	});
	if (env[`${prefix}_ACCEPTANCE`] !== "1" || !key || !Number.isSafeInteger(budget) || budget < 1 || budget > 5) {
		return output("deferred", "真实服务验收待授权；本次未执行真实请求，也不证明代码或协议已通过。");
	}
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 30_000);
	const boundedFetch: typeof fetch = async (input, init) => {
		if (requests >= budget) throw new Error("Acceptance request budget exhausted");
		requests++;
		const effective = init?.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal;
		return transport(input, { ...init, signal: effective, redirect: "error" });
	};
	try {
		if (kind === "search") {
			await webSearch(
				"PostgreSQL 17 release notes",
				{ enabled: true, apiKey: key, maxResults: 1, timeoutMs: 20_000, fetch: boundedFetch },
				controller.signal,
			);
		} else {
			const endpoint = new URL(env[`${prefix}_URL`] ?? "");
			if (
				endpoint.protocol !== "https:" ||
				endpoint.username ||
				endpoint.password ||
				endpoint.hash ||
				endpoint.search
			)
				throw new Error("An explicitly approved HTTPS endpoint is required");
			const headers: Record<string, string> = {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			};
			const send = async (payload: unknown, notification = false): Promise<Record<string, unknown>> => {
				const response = await boundedFetch(endpoint, {
					method: "POST",
					headers,
					body: JSON.stringify(payload),
					signal: controller.signal,
				});
				if (!response.ok) {
					void response.body?.cancel();
					throw new Error("Service rejected the request");
				}
				const session = response.headers.get("mcp-session-id");
				if (session) {
					if (!/^[\x21-\x7e]{1,1024}$/.test(session)) throw new Error("Invalid session");
					headers["Mcp-Session-Id"] = session;
				}
				if (notification) {
					void response.body?.cancel();
					return {};
				}
				if (!response.headers.get("content-type")?.includes("application/json") || !response.body) {
					void response.body?.cancel();
					throw new Error("JSON service response required");
				}
				const reader = response.body.getReader();
				let bytes = 0,
					body = "";
				const decoder = new TextDecoder("utf-8", { fatal: true });
				try {
					while (true) {
						const chunk = await abortable(reader.read(), controller.signal);
						if (chunk.done) break;
						bytes += chunk.value.byteLength;
						if (bytes > 262_144) throw new Error("Response too large");
						body += decoder.decode(chunk.value, { stream: true });
					}
					const result = record(JSON.parse(body + decoder.decode()));
					if (!result) throw new Error("Invalid service response");
					return result;
				} finally {
					void reader.cancel().catch(() => {});
					reader.releaseLock();
				}
			};
			if (kind === "model") {
				const model = env.PI861_REAL_MODEL_ID;
				if (!model) throw new Error("Explicit model id required");
				// This script supports the Chat Completions JSON protocol only. No config is modified.
				const reply = await send({
					model,
					messages: [{ role: "user", content: "Reply with the word OK." }],
					max_tokens: 8,
					stream: false,
				});
				const first = Array.isArray(reply.choices) ? record(reply.choices[0]) : undefined;
				if (typeof record(first?.message)?.content !== "string") throw new Error("Invalid model response");
			} else {
				if (budget < 3) throw new Error("MCP validation requires a three-request budget");
				headers.Accept = "application/json, text/event-stream";
				const init = await send({
					jsonrpc: "2.0",
					id: "pi861-acceptance-init",
					method: "initialize",
					params: {
						protocolVersion: "2025-11-25",
						capabilities: {},
						clientInfo: { name: "pi861-acceptance", version: "1" },
					},
				});
				const result = record(init.result);
				if (
					init.id !== "pi861-acceptance-init" ||
					init.error ||
					!record(result?.capabilities)?.tools ||
					!["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(String(result?.protocolVersion))
				)
					throw new Error("MCP initialization failed");
				headers["MCP-Protocol-Version"] = String(result?.protocolVersion);
				await send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, true);
				const tools = await send({ jsonrpc: "2.0", id: "pi861-acceptance-list", method: "tools/list", params: {} });
				if (tools.id !== "pi861-acceptance-list" || tools.error || !Array.isArray(record(tools.result)?.tools))
					throw new Error("MCP discovery failed");
				// Discovery only: no business tools, writes or pagination are invoked.
			}
		}
		return output("passed", "Authorized connectivity and protocol check completed.");
	} catch {
		return output(
			"failed",
			"Service unavailable, protocol unsupported, cancelled or configured budget exhausted; sensitive diagnostics withheld.",
		);
	} finally {
		clearTimeout(timer);
	}
}
