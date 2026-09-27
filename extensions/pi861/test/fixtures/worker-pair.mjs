import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateWorkerPairEvidence } from "../../src/live/acceptance.ts";

// P1-Q dual Pi Worker fixture (K7). Starts two REAL independent worker processes driven by the
// pi-worker.mjs protocol fixture (M4 lineage): separate OS processes, separate workspace
// directories, separate trace files, no shared state. The pair evidence this helper produces is
// what the acceptance runner's workers suite validates - a single worker can never satisfy it.
//
// startPiWorkerPair() -> {
//   root, workers: [{ pid, workspace, tracePath, child, dispatch(task), trace() }],
//   evidence(), validation(), stop()
// }

const PI_WORKER = fileURLToPath(new URL("./pi-worker.mjs", import.meta.url));

export async function startPiWorkerPair(options = {}) {
	const count = options.workers ?? 2;
	if (count !== 2) throw new Error("The K7 pair fixture starts exactly two workers");
	const root = mkdtempSync(join(tmpdir(), "pi861 worker-pair "));
	const startedAt = new Date().toISOString();
	const workers = [];
	for (let index = 0; index < count; index++) {
		const workspace = join(root, `worker-${index}`);
		mkdirSync(workspace);
		const tracePath = join(root, `trace-${index}.log`);
		const child = spawn(process.execPath, [PI_WORKER], {
			cwd: workspace,
			env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TRACE: tracePath },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stderr.on("data", () => {});
		let buffer = "";
		const waiters = [];
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			buffer += chunk;
			while (buffer.includes("\n")) {
				const end = buffer.indexOf("\n");
				const line = buffer.slice(0, end);
				buffer = buffer.slice(end + 1);
				if (!line.trim()) continue;
				let event;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (event.type === "agent_end") waiters.shift()?.();
			}
		});
		const worker = {
			pid: child.pid,
			workspace,
			tracePath,
			child,
			dispatch(task) {
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => reject(new Error(`worker ${index} did not finish task ${task}`)), options.taskTimeoutMs ?? 15_000);
					waiters.push(() => {
						clearTimeout(timer);
						resolve();
					});
					child.stdin.write(`${JSON.stringify({ type: "prompt", id: `pair-${index}-${task}`, message: `Task: ${task}\nimplement ${task}` })}\n`);
				});
			},
			trace() {
				return existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
			},
		};
		workers.push(worker);
	}
	const evidence = () => ({
		kind: "pi-worker-pair",
		workers: workers.map((worker) => ({ pid: worker.pid, workspace: worker.workspace, startedAt })),
	});
	return {
		root,
		workers,
		evidence,
		validation: () => validateWorkerPairEvidence(evidence()),
		async stop() {
			for (const worker of workers) worker.child.kill();
			await delay(150);
			rmSync(root, { recursive: true, force: true });
		},
	};
}
