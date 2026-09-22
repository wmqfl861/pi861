import type { RemoteWorkerClient } from "./remote-worker.ts";
import { digest } from "../memory.ts";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Lease, TaskRecord } from "../scheduler.ts";
import { ProjectCoordinator, type ExecutionSpec, type WorkerIdentity } from "./coordinator.ts";
import { PiRpcSession, type PiRunResult } from "./pi-rpc.ts";
import type { ProcessSpec } from "./line-process.ts";
import { Workspaces, type Workspace, type CheckCommand } from "./workspace.ts";
const execute = promisify(execFile);
export interface ProjectWorkerOptions {
	identity: WorkerIdentity;
	process?: (workspace: Workspace, execution: ExecutionSpec) => ProcessSpec;
	remote?: RemoteWorkerClient;
	waitForSettled?: boolean;
}
export interface ProjectRunnerOptions {
	coordinator: ProjectCoordinator; workspaces: Workspaces; workers: ProjectWorkerOptions[];
	checks: CheckCommand[]; integration: Workspace;
	maxTaskMs?: number; leaseMs?: number;
	onProgress?: (event: { taskId: string; state: string; detail?: string }) => void;
	/** Optional independent review; tests are still mandatory. */
	audit?: (task: TaskRecord, workspace: Workspace, result: PiRunResult, signal: AbortSignal) => Promise<boolean>;
}

/** Real Pi processes; one completion unlocks successors independently of unrelated slow workers. */
export class ProjectRunner {
	private readonly options: ProjectRunnerOptions;
	private controller: AbortController | undefined;
	private runPromise: Promise<void> | undefined;
	private integrationTail: Promise<unknown> = Promise.resolve();
	constructor(options: ProjectRunnerOptions) {
		if (!options.workers.length || new Set(options.workers.map((worker) => worker.identity.id)).size !== options.workers.length) throw new Error("Distinct worker identities required");
		this.options = options;
	}
	start(): Promise<void> {
		if (this.runPromise) return this.runPromise;
		this.controller = new AbortController();
		this.runPromise = this.loop(this.controller.signal).finally(() => { this.runPromise = undefined; });
		return this.runPromise;
	}
	async pause(): Promise<void> { await this.options.coordinator.control("pause"); this.controller?.abort(); await this.runPromise?.catch(() => {}); }
	private async execute(worker: ProjectWorkerOptions, task: TaskRecord, execution: ExecutionSpec, baseCommit: string, outer: AbortSignal): Promise<void> {
		const lease = task.lease as Lease, leaseMs = this.options.leaseMs ?? 60_000;
		const local = new AbortController(), signal = AbortSignal.any([outer, local.signal, AbortSignal.timeout(this.options.maxTaskMs ?? 600_000)]);
		let session: PiRpcSession | undefined;
		const timer = setInterval(() => {
			void this.options.coordinator.heartbeat(worker.identity.id, lease, randomUUID(), leaseMs).catch((error: unknown) => local.abort(error));
		}, Math.max(10, Math.floor(leaseMs / 3)));
		try {
			this.options.onProgress?.({ taskId: task.id, state: "running" });
			const checks = execution.checkIds.map((id) => {
				const check = this.options.checks.find((check) => check.id === id); if (!check) throw new Error("Plan requests an unapproved validation command"); return check;
			});
			let workspace: Workspace, result: PiRunResult, commit: string;
			if (worker.remote) {
				const candidate = await worker.remote.run({ task, execution, baseCommit, baseBundle: await this.options.workspaces.exportCommit(baseCommit) }, signal);
				await this.options.workspaces.importCommit(candidate.bundle, candidate.commit);
				workspace = await this.options.workspaces.create(`inspect-${task.id}`, task.attempts, candidate.commit);
				workspace.baseCommit = baseCommit; // Revalidate the complete remote diff, not only its claimed output.
				result = { text: candidate.text, messages: [], toolCalls: 0, usage: { input: 0, output: 0 } }; commit = candidate.commit;
			} else {
				workspace = await this.options.workspaces.create(task.id, task.attempts, baseCommit);
				if (!worker.process) throw new Error("No configured worker transport");
				session = new PiRpcSession(worker.process(workspace, { ...execution, writeScopes: task.writeScopes }), { waitForSettled: worker.waitForSettled });
				result = await session.prompt([
					`Task: ${task.title}`, execution.instructions,
					`Permitted repository-relative write scopes: ${JSON.stringify(task.writeScopes)}`,
					`Acceptance: ${JSON.stringify(task.acceptance)}`,
					"Do not deploy, change other worktrees, expand permissions, create autonomous descendants, or run git commit. The host validates and commits your candidate.",
				].join("\n\n"), signal, this.options.maxTaskMs ?? 600_000);
				commit = "";
			}
			signal.throwIfAborted();
			const paths = await this.options.workspaces.changed(workspace, task.writeScopes);
			const evidence = await this.options.workspaces.check(workspace, checks, signal);
			if (this.options.audit && !await this.options.audit(task, workspace, result, signal)) throw new Error("Independent reviewer rejected candidate");
			if (!commit) commit = await this.options.workspaces.commit(workspace, paths, task.id);
			await this.options.coordinator.submit(worker.identity.id, lease, [`git:${commit}`, `workspace:${workspace.path}`, `response-sha:${digest(result.text)}`], randomUUID());
			this.options.onProgress?.({ taskId: task.id, state: "review" });
			const integrate = this.integrationTail.then(async () => {
				signal.throwIfAborted();
				await this.options.workspaces.integrate(this.options.integration, commit, signal);
				const integratedEvidence = await this.options.workspaces.check(this.options.integration, checks, signal);
				const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: this.options.integration.path })).stdout.trim();
				await this.options.coordinator.verify(lease, { accepted: true, evidence: [...evidence, ...integratedEvidence, `integration:${head}`] }, randomUUID(), head);
				this.options.onProgress?.({ taskId: task.id, state: "done" });
			});
			// A failed integration blocks subsequent merges: never work on an unresolved merge tree.
			this.integrationTail = integrate;
			await integrate;
		} catch {
			await this.options.coordinator.block(lease, "Execution or validation failed; inspect preserved workspace before retry", randomUUID()).catch(() => {});
			this.options.onProgress?.({ taskId: task.id, state: "blocked", detail: "Workspace and evidence retained; no task replay" });
		} finally { clearInterval(timer); session?.close(); }
	}
	private async loop(signal: AbortSignal): Promise<void> {
		const running = new Map<string, Promise<void>>();
		while (true) {
			if (!signal.aborted && (await this.options.coordinator.state()).status === "active") {
				for (const worker of this.options.workers) {
					if (running.has(worker.identity.id)) continue;
					const claim = await this.options.coordinator.claim(worker.identity, randomUUID(), this.options.leaseMs ?? 60_000);
					if (!claim) continue;
					const job = this.execute(worker, claim.task, claim.execution, claim.baseCommit, signal).finally(() => running.delete(worker.identity.id));
					running.set(worker.identity.id, job);
				}
			}
			if (!running.size) break;
			await Promise.race(running.values());
		}
	}
}
