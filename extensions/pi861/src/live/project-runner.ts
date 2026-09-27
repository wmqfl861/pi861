import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { ExecutionIdentity } from "../contracts/identity.ts";
import { digest } from "../memory.ts";
import type { Lease, TaskRecord } from "../scheduler.ts";
import type {
	ExecutionSpec,
	IntegrationHandle,
	PlanTask,
	ProjectCoordinator,
	ProjectState,
	WorkerIdentity,
} from "./coordinator.ts";
import type { ProcessSpec } from "./line-process.ts";
import { PiRpcSession, type PiRunResult } from "./pi-rpc.ts";
import type { RemoteWorkerClient } from "./remote-worker.ts";
import type { CheckCommand, Workspace, Workspaces } from "./workspace.ts";

const execute = promisify(execFile);
export interface ProjectWorkerOptions {
	identity: WorkerIdentity;
	process?: (workspace: Workspace, execution: ExecutionSpec) => ProcessSpec;
	remote?: RemoteWorkerClient;
	waitForSettled?: boolean;
}
/** Local notifications reduce latency; persisted state remains authoritative. */
export interface WakeChannel {
	wait(signal: AbortSignal, timeoutMs?: number): Promise<void>;
	wake(reason?: string): void;
}
/**
 * Integration handoff confirmation (AX9, reserved for P2-W). Before a new authority takes over an
 * integration directory after the previous lease EXPIRED (crash or lost node), the host must
 * confirm the former holder's Git process tree has actually exited: a dead lease stops state
 * commits but cannot kill a running merge. Throwing here freezes the integration resource instead
 * of handing the same directory to two process trees.
 */
export interface IntegrationHandoffGuard {
	confirmFormerHolderExited(former: { owner: string; generation: number }): Promise<void>;
}
export class InProcessWakeChannel implements WakeChannel {
	private readonly waiters = new Set<() => void>();
	wait(signal: AbortSignal, timeoutMs?: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const settle = (): void => {
				signal.removeEventListener("abort", settle);
				if (timer) clearTimeout(timer);
				this.waiters.delete(settle);
				resolve();
			};
			const timer = typeof timeoutMs === "number" ? setTimeout(settle, timeoutMs) : undefined;
			this.waiters.add(settle);
			signal.addEventListener("abort", settle, { once: true });
			if (signal.aborted) settle();
		});
	}
	wake(): void {
		for (const settle of [...this.waiters]) settle();
	}
}
export interface ProjectRunnerOptions {
	coordinator: ProjectCoordinator;
	workspaces: Workspaces;
	workers: ProjectWorkerOptions[];
	checks: CheckCommand[];
	integration: Workspace;
	maxTaskMs?: number;
	leaseMs?: number;
	onProgress?: (event: { taskId: string; state: string; detail?: string }) => void;
	/** The trusted host supplies an independent reviewer; its model calls use the shared budget service. */
	audit?: (task: TaskRecord, workspace: Workspace, result: PiRunResult, signal: AbortSignal) => Promise<boolean>;
	reviewerId?: string;
	/** Unsealed goals always remain resident. Sealed blocked goals may exit explicitly. */
	idle?: "exit" | "hold";
	wake?: WakeChannel;
	maintenanceMs?: number;
	/** Claim identities are authoritative, including after resume. */
	identity?: { goalId: string; runId: string };
	integrationLeaseMs?: number;
	integrationGraceMs?: number;
	/** Authorized callback. Actual model attempts must go through M1's shared request service. */
	planner?: (state: ProjectState, signal: AbortSignal) => Promise<{ tasks: PlanTask[]; sealed: boolean }>;
	planningLowWatermark?: number;
	planningTimeoutMs?: number;
	/** Host-supplied process-tree confirmation for expired-lease integration takeover (P2-W). */
	integrationHandoff?: IntegrationHandoffGuard;
}

/** Completion-driven refill with durable polling and fenced integration. */
export class ProjectRunner {
	private readonly options: ProjectRunnerOptions;
	private controller: AbortController | undefined;
	private runPromise: Promise<void> | undefined;
	private integrationTail: Promise<unknown> = Promise.resolve();
	private readonly integrationOwner = `runner/${randomUUID()}`;
	constructor(options: ProjectRunnerOptions) {
		if (
			!options.workers.length ||
			new Set(options.workers.map((worker) => worker.identity.id)).size !== options.workers.length
		)
			throw new Error("Distinct worker identities required");
		if (
			options.audit &&
			(!options.reviewerId || options.workers.some((worker) => worker.identity.id === options.reviewerId))
		)
			throw new Error("Independent reviewer identity required");
		for (const value of [
			options.maxTaskMs,
			options.leaseMs,
			options.maintenanceMs,
			options.integrationLeaseMs,
			options.planningTimeoutMs,
		]) {
			if (value !== undefined && (!Number.isSafeInteger(value) || value < 1))
				throw new Error("Positive runner deadlines required");
		}
		this.options = options;
	}
	start(): Promise<void> {
		if (this.runPromise) return this.runPromise;
		this.controller = new AbortController();
		this.integrationTail = Promise.resolve();
		this.runPromise = this.loop(this.controller.signal).finally(() => {
			this.runPromise = undefined;
		});
		return this.runPromise;
	}
	async pause(): Promise<void> {
		await this.options.coordinator.control("pause");
		this.controller?.abort();
		await this.runPromise;
	}
	async cancel(): Promise<void> {
		await this.options.coordinator.control("cancel");
		this.controller?.abort();
		await this.runPromise;
	}
	private async execute(
		worker: ProjectWorkerOptions,
		task: TaskRecord,
		execution: ExecutionSpec,
		baseCommit: string,
		identity: ExecutionIdentity,
		outer: AbortSignal,
	): Promise<void> {
		const lease = task.lease;
		if (!lease) throw new Error("Claim produced no execution lease");
		const leaseMs = this.options.leaseMs ?? 60_000;
		const local = new AbortController(),
			signal = AbortSignal.any([outer, local.signal, AbortSignal.timeout(this.options.maxTaskMs ?? 600_000)]);
		let session: PiRpcSession | undefined;
		const timer = setInterval(
			() => {
				void this.options.coordinator
					.heartbeat(worker.identity.id, lease, randomUUID(), leaseMs)
					.catch((error: unknown) => local.abort(error));
			},
			Math.max(10, Math.floor(leaseMs / 3)),
		);
		try {
			this.options.onProgress?.({ taskId: task.id, state: "running" });
			const checks = execution.checkIds.map((id) => {
				const check = this.options.checks.find((check) => check.id === id);
				if (!check) throw new Error("Plan requests an unapproved validation command");
				return check;
			});
			let workspace: Workspace, result: PiRunResult, commit: string;
			if (worker.remote) {
				const candidate = await worker.remote.run(
					{
						task,
						execution,
						baseCommit,
						baseBundle: await this.options.workspaces.exportCommit(baseCommit),
					},
					signal,
				);
				await this.options.workspaces.importCommit(candidate.bundle, candidate.commit);
				// Legacy two-dimension workspace identity until P2-W publishes createTask (R3.11).
				workspace = await this.options.workspaces.create(`inspect-${digest(identity).slice(0, 24)}`, 1, candidate.commit);
				workspace.baseCommit = baseCommit;
				result = { text: candidate.text, messages: [], toolCalls: 0, usage: { input: 0, output: 0 } };
				commit = candidate.commit;
			} else {
				// Legacy two-dimension workspace identity until P2-W publishes createTask (R3.11).
				workspace = await this.options.workspaces.create(task.id, task.attempts, baseCommit);
				if (!worker.process) throw new Error("No configured worker transport");
				session = new PiRpcSession(worker.process(workspace, { ...execution, writeScopes: task.writeScopes }), {
					waitForSettled: worker.waitForSettled,
				});
				result = await session.prompt(
					[
						`Task: ${task.title}`,
						execution.instructions,
						`Execution identity: ${JSON.stringify(identity)}`,
						`Permitted repository-relative write scopes: ${JSON.stringify(task.writeScopes)}`,
						`Acceptance: ${JSON.stringify(task.acceptance)}`,
						"Do not deploy, change other worktrees, expand permissions, create autonomous descendants, or run git commit. The host validates and commits your candidate.",
					].join("\n\n"),
					signal,
					this.options.maxTaskMs ?? 600_000,
				);
				await session.close();
				session = undefined;
				commit = "";
			}
			signal.throwIfAborted();
			const paths = await this.options.workspaces.changed(workspace, task.writeScopes);
			const evidence = await this.options.workspaces.check(workspace, checks, signal);
			await this.options.coordinator.recordStructuralCheck(lease, true, evidence, randomUUID(), "candidate");
			if (!commit) commit = await this.options.workspaces.commit(workspace, paths, task.id);
			await this.options.coordinator.submit(
				worker.identity.id,
				lease,
				[
					`git:${commit}`,
					`workspace:${workspace.path}`,
					`identity:${JSON.stringify(identity)}`,
					`response-sha:${digest(result.text)}`,
				],
				randomUUID(),
			);
			this.options.onProgress?.({ taskId: task.id, state: "review" });
			if (this.options.audit) {
				await this.options.coordinator.stage(lease, "review", "started", this.options.reviewerId);
				const accepted = await this.options.audit(task, workspace, result, signal);
				signal.throwIfAborted();
				await this.options.coordinator.stage(
					lease,
					"review",
					accepted ? "passed" : "failed",
					this.options.reviewerId,
				);
				if (!accepted) {
					await this.options.coordinator.rejectForRework(
						lease,
						[...evidence, `reviewer:${this.options.reviewerId}:rejected`, `candidate:${commit}`],
						randomUUID(),
					);
					this.options.onProgress?.({ taskId: task.id, state: "rework" });
					return;
				}
			}
			// A waiting delivery predecessor must not block the serial integration queue.
			while (true) {
				signal.throwIfAborted();
				const state = await this.options.coordinator.state();
				const dependencies = (task.deliveryDependsOn ?? []).map((id) =>
					state.board.tasks.find((item) => item.id === id),
				);
				if (dependencies.every((item) => item?.status === "done")) break;
				if (dependencies.some((item) => !item || item.status === "blocked" || item.status === "cancelled"))
					throw new Error("Delivery dependency requires repair");
				await sleep(this.maintenanceMs(), undefined, { signal });
			}
			const integrate = this.integrationTail.then(() =>
				this.runIntegration(task, lease, checks, evidence, commit, signal),
			);
			this.integrationTail = integrate.catch(() => {});
			await integrate;
		} catch (error) {
			await session?.close();
			session = undefined;
			const state = await this.options.coordinator.state();
			const current = state.board.tasks.find((item) => item.id === task.id);
			if (state.status === "cancelled") return;
			if (current?.lease?.token !== lease.token) return;
			if (outer.aborted || state.status === "paused") {
				await this.options.coordinator.relinquish(
					worker.identity.id,
					lease,
					randomUUID(),
					"Goal paused; owned process converged",
				);
				this.options.onProgress?.({ taskId: task.id, state: "paused" });
			} else if ((current.leaseUntil ?? 0) > Date.now()) {
				await this.options.coordinator.block(
					lease,
					error instanceof Error ? error.message : "Execution failed; inspect preserved workspace",
					randomUUID(),
				);
				this.options.onProgress?.({
					taskId: task.id,
					state: "blocked",
					detail: "Workspace and evidence retained; reconcile before retry",
				});
			}
		} finally {
			clearInterval(timer);
			await session?.close();
		}
	}
	private async runIntegration(
		task: TaskRecord,
		lease: Lease,
		checks: CheckCommand[],
		evidence: string[],
		commit: string,
		signal: AbortSignal,
	): Promise<void> {
		const leaseMs = this.options.integrationLeaseMs ?? 300_000;
		const handle = await this.acquireIntegrationAuthority(signal, leaseMs);
		const local = new AbortController(),
			effective = AbortSignal.any([signal, local.signal]);
		const timer = setInterval(
			() => {
				void this.options.coordinator
					.refreshIntegrationLease(this.integrationOwner, handle, leaseMs)
					.catch((error: unknown) => local.abort(error));
			},
			Math.max(10, Math.floor(leaseMs / 3)),
		);
		try {
			await this.options.coordinator.bindIntegration(this.options.integration, this.integrationOwner, handle);
			await this.withIntegrationDirectoryLock(this.options.integration.path, effective, async () => {
				await this.options.coordinator.refreshIntegrationLease(this.integrationOwner, handle, leaseMs);
				await this.assertIntegrationBase((await this.options.coordinator.state()).baseCommit);
				await this.options.coordinator.stage(lease, "integration", "started");
				try {
					await this.options.workspaces.integrate(this.options.integration, commit, effective);
					const integratedEvidence = await this.options.workspaces.check(
						this.options.integration,
						checks,
						effective,
					);
					await this.options.coordinator.recordStructuralCheck(
						lease,
						true,
						integratedEvidence,
						randomUUID(),
						"integration",
					);
					effective.throwIfAborted();
					const head = (
						await execute("git", ["rev-parse", "HEAD"], { cwd: this.options.integration.path })
					).stdout.trim();
					await this.options.coordinator.stage(lease, "integration", "passed");
					await this.options.coordinator.verify(
						lease,
						{ accepted: true, evidence: [...evidence, ...integratedEvidence, `integration:${head}`] },
						randomUUID(),
						head,
						{ owner: this.integrationOwner, ...handle },
					);
				} catch (error) {
					await this.options.coordinator.integrationFailed(
						task.id,
						commit,
						"Integration interrupted or checks failed; preserved workspace requires reconciliation",
						this.integrationOwner,
						handle,
					);
					throw error;
				}
			});
			this.options.onProgress?.({ taskId: task.id, state: "done" });
		} finally {
			clearInterval(timer);
			await this.options.coordinator.releaseIntegrationLease(this.integrationOwner, handle);
		}
	}
	/**
	 * Exclusive integration-directory mutex (AX9). The persistent lease decides WHO holds
	 * integration authority; this filesystem lock keeps two process trees out of the same Git
	 * worktree even when a holder crashes: only the current authority may break a stale lock, and
	 * only after the takeover grace has elapsed (the handoff guard has then confirmed the former
	 * Git process tree exited).
	 */
	private async withIntegrationDirectoryLock<T>(
		path: string,
		signal: AbortSignal,
		fn: () => Promise<T>,
	): Promise<T> {
		const lock = `${path}.intlock`;
		const graceMs = this.options.integrationGraceMs ?? 15_000;
		const start = Date.now();
		while (true) {
			signal.throwIfAborted();
			try {
				mkdirSync(lock);
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				if (Date.now() - start >= graceMs) rmSync(lock, { recursive: true, force: true });
				else await sleep(100, undefined, { signal });
			}
		}
		try {
			return await fn();
		} finally {
			rmSync(lock, { recursive: true, force: true });
		}
	}
	/** The integration worktree must sit exactly on the coordinator's pinned base before a merge. */
	private async assertIntegrationBase(expectedBase: string): Promise<void> {
		const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: this.options.integration.path }))
			.stdout.trim();
		if (head !== expectedBase)
			throw new Error(`Integration workspace diverged from the pinned base: ${head} != ${expectedBase}`);
	}
	private async acquireIntegrationAuthority(signal: AbortSignal, leaseMs: number): Promise<IntegrationHandle> {
		while (true) {
			signal.throwIfAborted();
			const state = await this.options.coordinator.state();
			if (state.status !== "active" || state.integrationFailure)
				throw new Error("Integration is paused for reconciliation");
			// Expired-lease takeover: confirm the former holder's Git process tree exited first.
			const held = state.integration;
			const graceMs = this.options.integrationGraceMs ?? 15_000;
			if (
				held &&
				held.expiresAt !== 0 &&
				Date.now() >= held.expiresAt + graceMs &&
				held.owner !== this.integrationOwner
			) {
				if (this.options.integrationHandoff)
					await this.options.integrationHandoff.confirmFormerHolderExited({
						owner: held.owner,
						generation: held.generation,
					});
				else
					throw new Error(
						`Integration lease from ${held.owner} expired without release; confirm its Git process tree exited before takeover`,
					);
			}
			const handle = await this.options.coordinator.acquireIntegrationLease(
				this.integrationOwner,
				leaseMs,
				graceMs,
			);
			if (handle) return handle;
			await sleep(100, undefined, { signal });
		}
	}
	private async plan(state: ProjectState, signal: AbortSignal): Promise<void> {
		if (!this.options.planner || !state.goal) return;
		const timeoutMs = this.options.planningTimeoutMs ?? 120_000;
		const lease = await this.options.coordinator.reservePlanning(
			this.integrationOwner,
			state.goal.planVersion,
			timeoutMs,
		);
		if (!lease) return;
		try {
			const result = await this.options.planner(state, AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]));
			signal.throwIfAborted();
			await this.options.coordinator.finishPlanning(lease, result.tasks, result.sealed);
		} catch {
			await this.options.coordinator.failPlanning(
				lease,
				"Planning failed or its version changed; inspect before resume",
			);
		}
	}
	private async loop(signal: AbortSignal): Promise<void> {
		const running = new Map<string, Promise<void>>();
		const errors: unknown[] = [];
		let planning: Promise<void> | undefined;
		try {
			while (!signal.aborted && !errors.length) {
				await this.options.coordinator.maintain();
				await this.options.coordinator.drainWakes();
				const state = await this.options.coordinator.state();
				if (state.status !== "active") break;
				if (
					!planning &&
					this.options.planner &&
					state.goal?.sealed === false &&
					state.board.tasks.filter((task) => task.status === "queued").length <
						(this.options.planningLowWatermark ?? 1)
				) {
					planning = this.plan(state, signal)
						.catch((error: unknown) => {
							errors.push(error);
						})
						.finally(() => {
							planning = undefined;
						});
				}
				for (const worker of this.options.workers) {
					if (running.has(worker.identity.id)) continue;
					const claim = await this.options.coordinator.claim(
						worker.identity,
						randomUUID(),
						this.options.leaseMs ?? 60_000,
					);
					if (!claim) continue;
					const job = this.execute(worker, claim.task, claim.execution, claim.baseCommit, claim.identity, signal)
						.catch((error: unknown) => {
							errors.push(error);
						})
						.finally(() => running.delete(worker.identity.id));
					running.set(worker.identity.id, job);
				}
				const current = await this.options.coordinator.state();
				if (
					!running.size &&
					!planning &&
					current.goal?.sealed !== false &&
					this.options.idle !== "hold" &&
					!current.board.tasks.some((task) => task.status === "running" || task.status === "review")
				)
					break;
				const wait = new AbortController();
				const effective = AbortSignal.any([signal, wait.signal]);
				try {
					await Promise.race([
						...running.values(),
						...(planning ? [planning] : []),
						this.options.wake
							? this.options.wake.wait(effective, this.maintenanceMs())
							: sleep(this.maintenanceMs(), undefined, { signal: effective }).catch(() => {}),
					]);
				} finally {
					wait.abort();
				}
			}
		} finally {
			this.controller?.abort();
			await Promise.allSettled([...running.values(), ...(planning ? [planning] : [])]);
		}
		if (errors.length) throw new AggregateError(errors, "Project state could not be committed; execution stopped");
	}
	private maintenanceMs(): number {
		return (
			this.options.maintenanceMs ?? Math.min(5000, Math.max(100, Math.floor((this.options.leaseMs ?? 60_000) / 3)))
		);
	}
}
