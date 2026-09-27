import { randomUUID } from "node:crypto";
import type { EvidenceKind } from "../contracts/acceptance.ts";
import type { ExecutionIdentity } from "../contracts/identity.ts";
import {
	issueLease,
	type PersistentLease,
	type WakeEvent,
	WakeQueue,
	type WakeReason,
} from "../contracts/lifecycle.ts";
import { digest } from "../memory.ts";
import {
	type BoardOptions,
	type BoardSnapshot,
	type Lease,
	TaskBoard,
	type TaskRecord,
	type TaskSpec,
	type Verification,
} from "../scheduler.ts";
import type { StateStore } from "./store.ts";
import type { Workspace } from "./workspace.ts";

export interface ExecutionSpec {
	instructions: string;
	modelId: string;
	roleId: string;
	checkIds: string[];
	writeScopes?: string[];
}
export interface PlanTask {
	task: TaskSpec;
	execution: ExecutionSpec;
}
export interface IntegrationHandle {
	token: string;
	generation: number;
	expiresAt: number;
}
export interface ProjectEvidence {
	kind: EvidenceKind;
	taskId: string;
	attempt: number;
	recordedBy: string;
	detail: string[];
	at: number;
}
export interface ProjectState {
	format: 1;
	id: string;
	objective: string;
	baseCommit: string;
	status: "idle" | "active" | "paused" | "review" | "completed" | "cancelled";
	board: BoardSnapshot;
	execution: Record<string, ExecutionSpec>;
	receipts: Record<string, { hash: string; result: unknown }>;
	reason?: string;
	goal?: { id: string; runId: string; generation: number; planVersion: number; sealed: boolean };
	group?: { id: string; limits: BoardOptions; maxTasks: number; maxWork: number; usedWork: number };
	/** Durable wake queue (C2): all seven dispatcher wake sources persist across restarts. */
	wakeQueue?: { version: 1; events: WakeEvent[] };
	integration?: PersistentLease;
	integrationWorkspace?: Workspace;
	integrationFailure?: { taskId: string; commit: string; reason: string };
	planning?: PersistentLease & { planVersion: number };
	evidence?: ProjectEvidence[];
	stages?: {
		taskId: string;
		attempt: number;
		kind: "execution" | "review" | "integration";
		status: "started" | "passed" | "failed";
		at: number;
	}[];
}
export function emptyProject(id: string): ProjectState {
	return {
		format: 1,
		id,
		objective: "",
		baseCommit: "",
		status: "idle",
		board: { version: 0, tasks: [] },
		execution: {},
		receipts: {},
		wakeQueue: { version: 1, events: [] },
	};
}
export interface WorkerIdentity {
	id: string;
	capabilities: string[];
	roleIds: string[];
	modelIds: string[];
}
export interface PlanPolicy {
	roleIds: string[];
	modelIds: string[];
	checkIds: string[];
}

/**
 * Plan-entry contract check: every task needs an executable, verifiable contract and may only use
 * model/role/check ids from the operator-approved vocabulary. The planner port (P1-S) validates the
 * model output against its vocabulary; this is the scheduling-layer backstop for every entry path.
 */
export function validateTaskContracts(tasks: PlanTask[], policy: PlanPolicy | undefined): void {
	for (const { execution } of tasks) {
		if (!execution.instructions.trim() || !execution.modelId || !execution.roleId || !execution.checkIds.length)
			throw new Error("Every task needs an executable/verifiable contract");
		if (
			policy &&
			(!policy.roleIds.includes(execution.roleId) ||
				!policy.modelIds.includes(execution.modelId) ||
				execution.checkIds.some((id) => !policy.checkIds.includes(id)))
		)
			throw new Error("Unapproved task contract");
	}
}

/**
 * Scheduling-layer plan graph validation (P1-S handover): the shared projectPlan port only checks
 * the model/role/check vocabulary of its model output; reference existence and acyclicity are a
 * property of the board this plan lands on, so the coordinator validates them on every append path.
 */
export function validatePlanGraph(
	existing: readonly { id: string; dependsOn: string[]; deliveryDependsOn?: string[] }[],
	additions: readonly PlanTask[],
): void {
	const edges = new Map<string, { dependsOn: string[]; deliveryDependsOn: string[] }>();
	for (const task of existing)
		edges.set(task.id, { dependsOn: [...task.dependsOn], deliveryDependsOn: [...(task.deliveryDependsOn ?? [])] });
	for (const { task } of additions) {
		if (edges.has(task.id)) throw new Error(`Duplicate plan task: ${task.id}`);
		edges.set(task.id, { dependsOn: [...task.dependsOn], deliveryDependsOn: [...(task.deliveryDependsOn ?? [])] });
	}
	for (const node of edges.values())
		for (const dependency of [...node.dependsOn, ...node.deliveryDependsOn])
			if (!edges.has(dependency)) throw new Error(`Plan references unknown dependency: ${dependency}`);
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const visit = (id: string): void => {
		if (visiting.has(id)) throw new Error(`Plan dependency cycle through ${id}`);
		if (visited.has(id)) return;
		visiting.add(id);
		for (const dependency of edges.get(id)?.dependsOn ?? []) visit(dependency);
		visiting.delete(id);
		visited.add(id);
	};
	for (const id of edges.keys()) visit(id);
}

/** All state transitions run inside one storage transaction; external work never runs under that lock. */
export class ProjectCoordinator {
	private readonly store: StateStore<ProjectState>;
	private readonly limits: BoardOptions;
	private readonly maxTasks: number;
	private readonly policy: PlanPolicy | undefined;
	constructor(
		store: StateStore<ProjectState>,
		limits: BoardOptions,
		maxTasks = 100,
		_receiptLimit = 256,
		policy?: PlanPolicy,
	) {
		if (!Number.isSafeInteger(maxTasks) || maxTasks < 1) throw new Error("Invalid task budget");
		this.store = store;
		this.limits = limits;
		this.maxTasks = maxTasks;
		this.policy = policy;
	}
	async state(): Promise<ProjectState> {
		return this.store.read();
	}
	private async change<R>(
		principal: string,
		requestId: string,
		intent: unknown,
		fn: (state: ProjectState, board: TaskBoard, queue: WakeQueue) => R,
		receipt: boolean | "non-null" = true,
	): Promise<R> {
		if (!principal || !requestId || requestId.length > 200) throw new Error("Mutation identity required");
		return this.store.update((state) => {
			const key = digest([principal, requestId]),
				hash = digest(intent),
				prior = state.receipts[key];
			if (receipt && prior) {
				if (prior.hash !== hash) throw new Error("Coordinator idempotency conflict");
				return structuredClone(prior.result as R);
			}
			const beforeBoard = state.board;
			const board = new TaskBoard(state.group?.limits ?? this.limits, state.board);
			const queue = new WakeQueue();
			if (state.wakeQueue) queue.restore(state.wakeQueue);
			const result = fn(state, board, queue);
			if (state.board === beforeBoard) state.board = board.state;
			state.wakeQueue = queue.exportState();
			// Never silently expire an idempotency key. Polling and heartbeat traffic do not create receipts.
			if (receipt && (receipt !== "non-null" || result !== null))
				state.receipts[key] = { hash, result: result ?? null };
			return result;
		});
	}
	private contracts(tasks: PlanTask[]): void {
		validateTaskContracts(tasks, this.policy);
	}
	private record(queue: WakeQueue, reason: WakeReason, subject: string, detail: string): void {
		queue.record(reason, subject, detail, Date.now());
	}
	async create(
		objective: string,
		baseCommit: string,
		tasks: PlanTask[],
		options: { requestId?: string; sealed?: boolean } = {},
	): Promise<void> {
		if (
			!objective.trim() ||
			!/^[a-f0-9]{40,64}$/.test(baseCommit) ||
			(!tasks.length && options.sealed !== false) ||
			tasks.length > this.maxTasks
		)
			throw new Error("Invalid project plan");
		this.contracts(tasks);
		validatePlanGraph([], tasks);
		await this.change(
			"operator",
			options.requestId ?? randomUUID(),
			{ op: "create", objective, baseCommit, tasks, sealed: options.sealed ?? true },
			(state, _board, queue) => {
				if (!["idle", "completed", "cancelled"].includes(state.status))
					throw new Error("Project already has an unfinished goal");
				if (state.integration && state.integration.expiresAt > Date.now())
					throw new Error("Integration has not converged");
				const next = new TaskBoard(this.limits);
				next.add(tasks.map((item) => item.task));
				state.board = next.state;
				state.execution = {};
				for (const item of tasks) state.execution[item.task.id] = structuredClone(item.execution);
				state.goal = {
					id: randomUUID(),
					runId: randomUUID(),
					generation: (state.goal?.generation ?? 0) + 1,
					planVersion: 1,
					sealed: options.sealed ?? true,
				};
				state.group = {
					id: state.group?.id ?? randomUUID(),
					limits: { ...this.limits },
					maxTasks: this.maxTasks,
					maxWork: this.maxTasks * (this.limits.maxAttempts + 3),
					usedWork: 0,
				};
				state.objective = objective;
				state.baseCommit = baseCommit;
				state.status = "active";
				state.evidence = [];
				state.stages = [];
				delete state.integrationWorkspace;
				delete state.integrationFailure;
				delete state.planning;
				delete state.reason;
				this.record(queue, "plan-appended", state.goal.id, "Tasks appended to the plan");
			},
		);
	}
	async append(
		tasks: PlanTask[],
		expectedVersion: number,
		options: { sealed?: boolean; requestId?: string } = {},
	): Promise<void> {
		this.contracts(tasks);
		await this.change(
			"planner",
			options.requestId ?? randomUUID(),
			{ op: "append", tasks, expectedVersion, ...(options.sealed === undefined ? {} : { sealed: options.sealed }) },
			(state, board, queue) => {
				if (state.status !== "active" || !state.goal || state.goal.planVersion !== expectedVersion)
					throw new Error("Stale plan version");
				if (state.board.tasks.length + tasks.length > (state.group?.maxTasks ?? this.maxTasks))
					throw new Error("Task budget exhausted");
				validatePlanGraph(board.state.tasks, tasks);
				board.add(tasks.map((item) => item.task));
				for (const item of tasks) state.execution[item.task.id] = structuredClone(item.execution);
				state.goal.planVersion++;
				if (options.sealed !== undefined) state.goal.sealed = options.sealed;
				if (
					state.goal.sealed &&
					board.state.tasks.length &&
					board.state.tasks.every((task) => task.status === "done")
				)
					state.status = "review";
				this.record(queue, "plan-appended", state.goal.id, "Tasks appended to the plan");
			},
		);
	}
	async revise(tasks: PlanTask[], expectedVersion: number, requestId: string): Promise<void> {
		this.contracts(tasks);
		await this.change("operator", requestId, { op: "revise", tasks, expectedVersion }, (state, board, queue) => {
			if (!state.goal || state.goal.planVersion !== expectedVersion || !["active", "paused"].includes(state.status))
				throw new Error("Stale plan version");
			validatePlanGraph(
				board.state.tasks.filter((task) => !tasks.some((item) => item.task.id === task.id)),
				tasks,
			);
			board.revise(tasks.map((item) => item.task));
			for (const item of tasks) state.execution[item.task.id] = structuredClone(item.execution);
			state.goal.planVersion++;
			this.record(queue, "plan-appended", state.goal.id, "Tasks appended to the plan");
		});
	}
	async claim(
		worker: WorkerIdentity,
		requestId: string,
		leaseMs = 60_000,
	): Promise<{ task: TaskRecord; execution: ExecutionSpec; baseCommit: string; identity: ExecutionIdentity } | null> {
		return this.change(
			worker.id,
			requestId,
			{ op: "claim", worker, leaseMs },
			(state, board, _queue) => {
				if (state.status !== "active" || !state.goal || !state.group) return null;
				board.recoverExpired(Date.now());
				board.wakeParents();
				const occupied = board.state.tasks.filter(
					(task) => task.status === "running" || task.status === "review",
				).length;
				if (occupied + (state.planning ? 1 : 0) >= state.group.limits.maxConcurrent) return null;
				if (state.group.usedWork >= state.group.maxWork) {
					state.reason = "Work budget exhausted";
					return null;
				}
				const allowed = state.board.tasks
					.filter((task) => {
						const execution = state.execution[task.id];
						return (
							execution &&
							worker.roleIds.includes(execution.roleId) &&
							worker.modelIds.includes(execution.modelId)
						);
					})
					.map((task) => task.id);
				const task = board.claim(worker.id, worker.capabilities, Date.now(), leaseMs, allowed);
				if (!task) return null;
				const execution = state.execution[task.id];
				if (!execution) throw new Error("Missing execution contract");
				state.group.usedWork++;
				state.stages?.push({
					taskId: task.id,
					attempt: task.attempts,
					kind: "execution",
					status: "started",
					at: Date.now(),
				});
				return {
					task,
					execution,
					baseCommit: state.baseCommit,
					identity: {
						tenantId: "local",
						projectId: state.id,
						goalId: state.goal.id,
						runId: state.goal.runId,
						taskId: task.id,
						attempt: task.attempts,
					},
				};
			},
			"non-null",
		);
	}
	async heartbeat(workerId: string, lease: Lease, requestId: string, leaseMs = 60_000): Promise<void> {
		if (workerId !== lease.workerId) throw new Error("Foreign task lease");
		await this.change(
			workerId,
			requestId,
			{ op: "heartbeat", lease },
			(state, board, _queue) => {
				if (state.status !== "active") throw new Error("Project is not active");
				board.heartbeat(lease, Date.now(), leaseMs);
			},
			false,
		);
	}
	async maintain(): Promise<number> {
		return this.change(
			"maintenance",
			randomUUID(),
			{ op: "maintain" },
			(state, board, queue) => {
				if (state.status !== "active") return 0;
				const recovered = board.recoverExpired(Date.now());
				board.wakeParents();
				if (recovered) this.record(queue, "lease-recovered", state.id, "Expired leases recovered by maintenance");
				if (state.planning && state.planning.expiresAt <= Date.now()) {
					state.status = "paused";
					state.reason = "Planner lost its lease; reconcile before resume";
					delete state.planning;
				}
				return recovered;
			},
			false,
		);
	}
	async unblock(taskId: string, requestId: string, reason: string): Promise<void> {
		await this.change("operator", requestId, { op: "unblock", taskId, reason }, (_state, board, queue) => {
			board.unblock(taskId, reason);
			this.record(queue, "manual-unblock", taskId, `Operator unblock: ${reason}`);
		});
	}
	/** Durable wake events still awaiting delivery; a restarted runner drains exactly these. */
	async pendingWakes(): Promise<WakeEvent[]> {
		const queue = new WakeQueue();
		const state = await this.state();
		if (state.wakeQueue) queue.restore(state.wakeQueue);
		return queue.pending();
	}
	/** Atomically returns and acknowledges all pending wake events (at-least-once delivery). */
	async drainWakes(): Promise<WakeEvent[]> {
		return this.change(
			"scheduler",
			randomUUID(),
			{ op: "drain-wakes" },
			(_state, _board, queue) => {
				const pending = queue.pending();
				queue.acknowledge(
					pending.map((event) => event.eventDigest),
					Date.now(),
				);
				return pending;
			},
			false,
		);
	}
	/** A Worker node reports it is available again (P2-W remote recovery); dispatch reconsiders. */
	async noteNodeRecovered(nodeId: string): Promise<void> {
		if (!nodeId || nodeId.length > 200) throw new Error("Node identity required");
		await this.change(
			"operator",
			randomUUID(),
			{ op: "node-recovered", nodeId },
			(_state, _board, queue) => {
				this.record(queue, "node-recovered", nodeId, "Worker node reported recovery");
			},
			false,
		);
	}
	/**
	 * Trusted structural-check evidence (C7): recorded only by the host checker that actually ran
	 * an approved command, never by the implementing model. Distinct from the behavioral verdict
	 * of verify(), the independent reviewer and the separate human acceptance.
	 */
	async recordStructuralCheck(
		lease: Lease,
		passed: boolean,
		detail: string[],
		requestId: string,
		stage: "candidate" | "integration" = "candidate",
	): Promise<void> {
		if (!detail.length || detail.some((item) => !item.trim())) throw new Error("Structural check detail required");
		await this.change(
			"checker",
			requestId,
			{ op: "structural-check", lease, passed, detail, stage },
			(state) => {
				const task = state.board.tasks.find((item) => item.id === lease.taskId);
				if (state.status !== "active" || task?.lease?.token !== lease.token || (task.leaseUntil ?? 0) <= Date.now())
					throw new Error("Stale task for structural evidence");
				state.evidence ??= [];
				state.evidence.push({
					kind: "structural-check",
					taskId: lease.taskId,
					attempt: lease.attempt,
					recordedBy: "trusted-checker",
					detail: [`stage:${stage}`, passed ? "passed" : "failed", ...detail],
					at: Date.now(),
				});
			},
			false,
		);
	}
	async relinquish(workerId: string, lease: Lease, requestId: string, reason: string): Promise<void> {
		if (workerId !== lease.workerId) throw new Error("Foreign task lease");
		await this.change(workerId, requestId, { op: "relinquish", lease, reason }, (state, board, queue) => {
			if (state.status === "cancelled") return;
			board.relinquish(lease, reason, Date.now());
			this.record(queue, "task-finished", lease.taskId, "Task attempt finished");
		});
	}
	async acquireIntegrationLease(owner: string, leaseMs: number, graceMs = 0): Promise<IntegrationHandle | null> {
		if (!owner || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isSafeInteger(graceMs) || graceMs < 0)
			throw new Error("Invalid integration lease request");
		return this.change(
			"integrator",
			randomUUID(),
			{ op: "integration-acquire" },
			(state) => {
				if (state.status !== "active" || state.integrationFailure) return null;
				const now = Date.now(),
					held = state.integration;
				if (held && held.expiresAt !== 0 && now < held.expiresAt + graceMs) return null;
				const next = issueLease("integration", owner, (held?.generation ?? 0) + 1, now, leaseMs);
				state.integration = next;
				return { token: next.token, generation: next.generation, expiresAt: next.expiresAt };
			},
			false,
		);
	}
	private authority(state: ProjectState, owner: string, handle: IntegrationHandle): PersistentLease {
		const held = state.integration;
		if (
			!held ||
			held.owner !== owner ||
			held.token !== handle.token ||
			held.generation !== handle.generation ||
			held.expiresAt <= Date.now()
		)
			throw new Error("Integration authority stale or lost; late result rejected");
		return held;
	}
	async refreshIntegrationLease(owner: string, handle: IntegrationHandle, leaseMs: number): Promise<void> {
		await this.change(
			"integrator",
			randomUUID(),
			{ op: "integration-refresh" },
			(state) => {
				this.authority(state, owner, handle).expiresAt = Date.now() + leaseMs;
			},
			false,
		);
	}
	async releaseIntegrationLease(owner: string, handle: IntegrationHandle): Promise<void> {
		await this.change(
			"integrator",
			randomUUID(),
			{ op: "integration-release" },
			(state) => {
				const held = state.integration;
				if (held?.owner === owner && held.token === handle.token && held.generation === handle.generation)
					held.expiresAt = 0;
			},
			false,
		);
	}
	async bindIntegration(workspace: Workspace, owner: string, handle: IntegrationHandle): Promise<void> {
		await this.change(
			"integrator",
			randomUUID(),
			{ op: "bind-integration", workspace },
			(state) => {
				this.authority(state, owner, handle);
				if (state.integrationWorkspace && state.integrationWorkspace.path !== workspace.path)
					throw new Error("Another integration workspace is already bound");
				state.integrationWorkspace = structuredClone(workspace);
			},
			false,
		);
	}
	async integrationFailed(
		taskId: string,
		commit: string,
		reason: string,
		owner: string,
		handle: IntegrationHandle,
	): Promise<void> {
		await this.change(
			"integrator",
			randomUUID(),
			{ op: "integration-failure", taskId, commit },
			(state) => {
				this.authority(state, owner, handle);
				state.integrationFailure = { taskId, commit, reason };
			},
			false,
		);
	}
	/** Caller proves the preserved workspace was reconciled and rechecked before clearing the gate. */
	async reconcileIntegration(baseCommit: string, evidence: string[], requestId: string): Promise<void> {
		if (!evidence.length) throw new Error("Repair verification evidence required");
		await this.change(
			"operator",
			requestId,
			{ op: "reconcile-integration", baseCommit, evidence },
			(state, _board, queue) => {
				if (
					state.status !== "paused" ||
					(state.integration?.expiresAt && state.integration.expiresAt > Date.now()) ||
					baseCommit !== state.baseCommit
				)
					throw new Error("Pause, converge and restore the verified base before reconciliation");
				delete state.integrationFailure;
				this.record(queue, "manual-unblock", "integration", "Integration reconciled after repair");
			},
		);
	}
	async submit(workerId: string, lease: Lease, artifacts: string[], requestId: string): Promise<void> {
		if (workerId !== lease.workerId) throw new Error("Foreign task lease");
		await this.change(workerId, requestId, { op: "submit", lease, artifacts }, (state, board, queue) => {
			if (state.status !== "active") throw new Error("Project no longer active");
			board.submit(lease, artifacts, Date.now());
			this.record(queue, "task-finished", lease.taskId, "Task attempt finished");
		});
	}
	async stage(
		lease: Lease,
		kind: "review" | "integration",
		status: "started" | "passed" | "failed",
		reviewer?: string,
	): Promise<void> {
		await this.change(
			"verifier",
			randomUUID(),
			{ op: "stage", lease, kind, status, ...(reviewer === undefined ? {} : { reviewer }) },
			(state) => {
				const task = state.board.tasks.find((task) => task.id === lease.taskId);
				if (state.status !== "active" || task?.lease?.token !== lease.token || (task.leaseUntil ?? 0) <= Date.now())
					throw new Error("Stale task stage");
				if (kind === "review" && (!reviewer || reviewer === lease.workerId))
					throw new Error("Independent reviewer identity required");
				if (status === "started" && state.group) {
					if (state.group.usedWork >= state.group.maxWork) throw new Error("Work budget exhausted");
					state.group.usedWork++;
				}
				state.stages ??= [];
				state.stages.push({ taskId: lease.taskId, attempt: lease.attempt, kind, status, at: Date.now() });
				if (kind === "review" && status === "passed" && reviewer) {
					state.evidence ??= [];
					state.evidence.push({
						kind: "independent-review",
						taskId: lease.taskId,
						attempt: lease.attempt,
						recordedBy: reviewer,
						detail: ["Independent candidate review passed"],
						at: Date.now(),
					});
				}
			},
			false,
		);
	}
	async rejectForRework(lease: Lease, evidence: string[], requestId: string): Promise<string> {
		if (!evidence.length) throw new Error("Failed review evidence required");
		return this.change("verifier", requestId, { op: "rework", lease, evidence }, (state, board, queue) => {
			const original = board.state.tasks.find((task) => task.id === lease.taskId),
				execution = state.execution[lease.taskId];
			if (!original || !execution || !state.goal) throw new Error("Missing repair target");
			board.block(lease, `Review rejected: ${evidence.join("; ")}`, Date.now());
			if (board.state.tasks.length >= (state.group?.maxTasks ?? this.maxTasks))
				throw new Error("Rework task budget exhausted");
			const id = `${original.id}-repair-${lease.attempt}`;
			const repair: TaskSpec = {
				id,
				title: original.title,
				dependsOn: [...original.dependsOn],
				deliveryDependsOn: original.deliveryDependsOn,
				resources: original.resources,
				writeScopes: [...original.writeScopes],
				capabilities: [...original.capabilities],
				acceptance: [...original.acceptance],
				retrySafe: original.retrySafe,
				reworkFor: original.reworkFor ?? original.id,
			};
			board.add([repair]);
			state.execution[id] = {
				...execution,
				instructions: `${execution.instructions}\nRepair ${original.id} attempt ${lease.attempt}. Review evidence: ${evidence.join("; ")}\nPrior artifacts: ${original.artifacts.join(", ")}`,
			};
			state.goal.planVersion++;
			this.record(queue, "plan-appended", id, "Rework task appended after review rejection");
			return id;
		});
	}
	async verify(
		lease: Lease,
		verdict: Verification,
		requestId: string,
		integratedCommit?: string,
		integration?: { owner: string } & IntegrationHandle,
	): Promise<void> {
		await this.change(
			"verifier",
			requestId,
			{
				op: "verify",
				lease,
				verdict,
				...(integratedCommit === undefined ? {} : { integratedCommit }),
				...(integration === undefined ? {} : { integration }),
			},
			(state, board, queue) => {
				if (state.status !== "active") throw new Error("Project no longer active");
				if (verdict.accepted) {
					if (integratedCommit) {
						if (!/^[a-f0-9]{40,64}$/.test(integratedCommit) || !integration)
							throw new Error("Current integration authority required");
						this.authority(state, integration.owner, integration);
						if (state.integrationFailure) throw new Error("Integration requires reconciliation");
						state.baseCommit = integratedCommit;
					}
					board.accept(lease, verdict.evidence, Date.now());
					const repaired = board.state.tasks.find((task) => task.id === lease.taskId)?.reworkFor;
					if (repaired) board.acceptRepair(repaired, verdict.evidence);
					state.evidence ??= [];
					state.evidence.push({
						kind: "behavioral-check",
						taskId: lease.taskId,
						attempt: lease.attempt,
						recordedBy: "trusted-verifier",
						detail: [...verdict.evidence],
						at: Date.now(),
					});
				} else board.block(lease, verdict.reason ?? "Verification rejected", Date.now());
				board.wakeParents();
				// A completed dependency releases every dependent waiting on it: durable wake source 3.
				for (const task of board.state.tasks)
					if (task.status === "queued" && task.dependsOn.includes(lease.taskId))
						this.record(queue, "dependency-released", task.id, `Dependency ${lease.taskId} accepted`);
				if (state.goal?.sealed !== false && board.state.tasks.every((task) => task.status === "done"))
					state.status = "review";
				this.record(queue, "acceptance-recorded", lease.taskId, "Verification verdict recorded");
			},
		);
	}
	async block(lease: Lease, reason: string, requestId: string): Promise<void> {
		await this.change(lease.workerId, requestId, { op: "block", lease, reason }, (_state, board, queue) => {
			board.block(lease, reason, Date.now());
			this.record(queue, "task-finished", lease.taskId, "Task attempt finished");
		});
	}
	async control(action: "pause" | "resume" | "accept" | "cancel", requestId = randomUUID()): Promise<void> {
		await this.change("operator", requestId, { action }, (state, board, queue) => {
			if (action === "accept") {
				if (
					state.status !== "review" ||
					!state.board.tasks.every((task) => task.status === "done") ||
					!state.goal?.sealed
				)
					throw new Error("Goal is not ready for acceptance");
				state.status = "completed";
				state.evidence ??= [];
				state.evidence.push({
					kind: "human-acceptance",
					taskId: state.goal.id,
					attempt: 0,
					recordedBy: "operator",
					detail: ["Goal accepted by operator"],
					at: Date.now(),
				});
			} else if (action === "cancel") {
				state.status = "cancelled";
				board.cancel("Goal cancelled; in-flight side effects may require reconciliation");
			} else if (action === "pause") {
				if (state.status === "active") state.status = "paused";
			} else {
				if (state.status !== "paused") throw new Error("Only a paused goal may resume");
				if (state.board.tasks.some((task) => task.status === "running" || task.status === "review"))
					throw new Error("In-flight attempts must converge before resume");
				state.status = "active";
				if (state.goal) {
					state.goal.runId = randomUUID();
					state.goal.generation++;
				}
				// The coordinating node is back: durable wake source 5 (resume after pause or restart).
				this.record(queue, "node-recovered", state.id, "Coordinator node resumed");
			}
		});
	}
	async edit(objective: string, requestId: string): Promise<void> {
		if (!objective.trim()) throw new Error("Objective required");
		await this.change("operator", requestId, { op: "edit", objective }, (state) => {
			if (state.status !== "paused" || !state.goal) throw new Error("Pause the goal before editing");
			state.objective = objective;
			state.goal.planVersion++;
			state.goal.sealed = false;
		});
	}
	async budget(maxWork: number, requestId: string): Promise<void> {
		await this.change("operator", requestId, { op: "budget", maxWork }, (state) => {
			if (!state.group || !Number.isSafeInteger(maxWork) || maxWork < state.group.maxWork)
				throw new Error("Budget may only increase");
			state.group.maxWork = maxWork;
			delete state.reason;
		});
	}
	async reservePlanning(owner: string, expectedVersion: number, leaseMs: number): Promise<PersistentLease | null> {
		return this.change(
			"planner",
			randomUUID(),
			{ op: "planning-reserve" },
			(state) => {
				if (
					state.status !== "active" ||
					!state.goal ||
					state.goal.sealed ||
					state.goal.planVersion !== expectedVersion ||
					state.planning ||
					!state.group
				)
					return null;
				if (
					state.board.tasks.filter((task) => task.status === "running" || task.status === "review").length >=
					state.group.limits.maxConcurrent
				)
					return null;
				if (state.group.usedWork >= state.group.maxWork) throw new Error("Work budget exhausted");
				state.group.usedWork++;
				state.planning = {
					...issueLease("planning", owner, state.goal.generation, Date.now(), leaseMs),
					planVersion: expectedVersion,
				};
				return state.planning;
			},
			false,
		);
	}
	async finishPlanning(lease: PersistentLease, tasks: PlanTask[], sealed: boolean): Promise<void> {
		this.contracts(tasks);
		await this.change("planner", lease.token, { op: "planning-result", tasks, sealed }, (state, board, queue) => {
			if (
				state.status !== "active" ||
				state.planning?.token !== lease.token ||
				state.planning.expiresAt <= Date.now() ||
				!state.goal ||
				state.goal.planVersion !== state.planning.planVersion
			)
				throw new Error("Stale planning result");
			if (state.board.tasks.length + tasks.length > (state.group?.maxTasks ?? this.maxTasks))
				throw new Error("Task budget exhausted");
			validatePlanGraph(board.state.tasks, tasks);
			board.add(tasks.map((item) => item.task));
			for (const item of tasks) state.execution[item.task.id] = structuredClone(item.execution);
			state.goal.planVersion++;
			state.goal.sealed = sealed;
			delete state.planning;
			if (sealed && board.state.tasks.length && board.state.tasks.every((task) => task.status === "done"))
				state.status = "review";
			this.record(queue, "plan-appended", state.goal.id, "Tasks appended to the plan");
		});
	}
	async failPlanning(lease: PersistentLease, reason: string): Promise<void> {
		await this.change(
			"planner",
			randomUUID(),
			{ op: "planning-failure", reason },
			(state) => {
				if (state.planning?.token !== lease.token) return;
				delete state.planning;
				state.status = "paused";
				state.reason = reason;
			},
			false,
		);
	}
}
