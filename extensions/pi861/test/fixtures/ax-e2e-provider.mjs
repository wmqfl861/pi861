// P3-X deterministic scenario provider for the AX10 vertical chain (K8). Loaded into REAL Pi
// hosts (coordinator host and both worker hosts) as a normal pi.registerProvider extension; it
// never bypasses a port - the real AuxiliaryModelInvocations planning port, the real runtime
// reviewer, the real worker write tool and the real worker guard all execute against it.
// Branches (matched by prompt shape, exactly like the P1-Q native-provider):
//   - planning port prompt ("Plan only the authorized project objective...") -> fixed A / slow
//     B / C(dependsOn A) plan built strictly from the supplied model/role/check vocabulary
//   - runtime reviewer prompt ("Independent review of a completed task...") -> FAIL exactly
//     once for task A (cross-process marker file), PASS afterwards (the injected K8 step-5
//     review failure and its rework)
//   - worker task prompt ("Task: <ID> ...") -> write toolCall for <id>.txt with content <ID>
//     through the REAL write tool; task B answers slowly (the AX1 parallel window)
//   - distillation prompt -> the P1-Q fixture summary shape
// The model is a fixture; the chain report must say so.
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createAssistantMessageEventStream, getCurrentTools } from "@earendil-works/pi-ai";

const text = (message) =>
	typeof message.content === "string"
		? message.content
		: (message.content ?? []).filter((x) => x.type === "text").map((x) => x.text).join("\n");

export default function fixture(pi) {
	let failedReview = false;
	pi.registerProvider("pi861-ax-e2e", {
		baseUrl: "http://127.0.0.1/unused-ax-e2e",
		api: "openai-completions",
		apiKey: "test-no-external-request",
		models: ["cheap", "strong"].map((id) => ({
			id,
			name: id,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 8192,
		})),
		streamSimple(model, context) {
			const output = createAssistantMessageEventStream();
			const messages = context.messages;
			const users = messages.filter((m) => m.role === "user");
			const prompt = users.map(text).join("\n");
			if (process.env.PI861_FIXTURE_LOG)
				appendFileSync(process.env.PI861_FIXTURE_LOG, JSON.stringify({ model: model.id, prompt: prompt.slice(-400) }) + "\n");
			const done = (result) => {
				output.push({ type: "start", partial: result });
				output.push({ type: "done", reason: result.stopReason, message: result });
			};
			const base = {
				role: "assistant",
				api: "openai-completions",
				provider: model.provider,
				model: model.id,
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				timestamp: Date.now(),
			};
			if (prompt.includes("health probe")) {
				done({ ...base, content: [{ type: "text", text: "OK" }], stopReason: "stop" });
				return output;
			}
			if (prompt.startsWith("Plan only the authorized project objective")) {
				const vocabulary = JSON.parse(prompt.split("\n\n").at(-1));
				const modelId = vocabulary.modelIds[0];
				const roleId = vocabulary.roleIds[0];
				const checkId = vocabulary.checkIds[0];
				const task = (id, extra = {}) => ({
					task: {
						id,
						title: `${id} produce ${id.toLowerCase()}.txt with content ${id}`,
						dependsOn: id === "C" ? ["A"] : [],
						writeScopes: [`${id.toLowerCase()}.txt`],
						capabilities: [],
						acceptance: [`${id} check succeeds and the file contains ${id}`],
						retrySafe: true,
						...extra,
					},
					execution: { instructions: `Write ${id.toLowerCase()}.txt with the exact content ${id}.`, roleId, modelId, checkIds: [checkId] },
				});
				done({ ...base, content: [{ type: "text", text: JSON.stringify({ tasks: [task("A"), task("B"), task("C")] }) }], stopReason: "stop" });
				return output;
			}
			if (prompt.startsWith("Independent review of a completed task")) {
				const marker = process.env.PI861_AX_E2E_MARKDIR;
				const failFile = marker ? `${marker}/review-failed-a` : null;
				if (marker && !existsSync(failFile) && prompt.includes("\nTask: A produce")) {
					mkdirSync(marker, { recursive: true });
					writeFileSync(failFile, "1");
					done({ ...base, content: [{ type: "text", text: "FAIL\nfirst review of A is injected as failing (K8 step 5)" }], stopReason: "stop" });
					return output;
				}
				done({ ...base, content: [{ type: "text", text: "PASS\nfixture reviewer accepts" }], stopReason: "stop" });
				return output;
			}
			if (prompt.startsWith("Summarize the following untrusted historical record")) {
				const input = JSON.parse(text(users.at(-1)).split("\n\n").at(-1));
				done({
					...base,
					content: [
						{ type: "text", text: JSON.stringify({ abstract: "Generated fixture summary", overview: "Generated with source evidence", facts: [{ text: input.text.slice(0, 20), quote: input.text.slice(0, 20) }] }) },
					],
					stopReason: "stop",
				});
				return output;
			}
			const task = /Task: (\w)/.exec(prompt)?.[1];
			if (task && !messages.some((m) => m.role === "toolResult")) {
				const result = { ...base, content: [{ type: "toolCall", id: `ax-e2e-write-${task}`, name: "write", arguments: { path: `${task.toLowerCase()}.txt`, content: task } }], stopReason: "toolUse" };
				if (task === "B") setTimeout(() => done(result), Number(process.env.PI861_AX_E2E_SLOW_MS ?? 600));
				else done(result);
				return output;
			}
			done({ ...base, content: [{ type: "text", text: `Implemented fixture ${task ?? "task"}` }], stopReason: "stop" });
			return output;
		},
	});
}
