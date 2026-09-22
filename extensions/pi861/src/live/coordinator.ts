import { randomUUID } from "node:crypto";
import { TaskBoard, type BoardOptions, type BoardSnapshot, type Lease, type TaskRecord, type TaskSpec, type Verification } from "../scheduler.ts";
import { digest } from "../memory.ts";
import type { StateStore } from "./store.ts";

export interface ExecutionSpec { instructions: string; modelId: string; roleId: string; checkIds: string[]; writeScopes?: string[]; }
export interface ProjectState {
	format: 1; id: string; objective: string; baseCommit: string;
	status: "idle" | "active" | "paused" | "review" | "completed" | "cancelled";
	board: BoardSnapshot; execution: Record<string, ExecutionSpec>;
	receipts: Record<string, { hash: string; result: unknown }>; reason?: string;
}
export function emptyProject(id: string): ProjectState {
	return { format: 1, id, objective: "", baseCommit: "", status: "idle", board: { version: 0, tasks: [] }, execution: {}, receipts: {} };
}
export interface WorkerIdentity { id: string; capabilities: string[]; roleIds: string[]; modelIds: string[]; }
export class ProjectCoordinator {
	private readonly store: StateStore<ProjectState>;
	private readonly limits: BoardOptions;
	private readonly maxTasks: number;
	constructor(store: StateStore<ProjectState>, limits: BoardOptions, maxTasks = 100) { this.store = store; this.limits = limits; this.maxTasks = maxTasks; }
	async state(): Promise<ProjectState> { return this.store.read(); }
	private async change<R>(principal: string, requestId: string, intent: unknown, fn: (state: ProjectState, board: TaskBoard) => R): Promise<R> {
		if (!principal || !requestId || requestId.length > 200) throw new Error("Mutation identity required");
		return this.store.update((state) => {
			const key = digest([principal, requestId]), hash = digest(intent), receipt = state.receipts[key];
			if (receipt) { if (receipt.hash !== hash) throw new Error("Coordinator idempotency conflict"); return structuredClone(receipt.result as R); }
			const beforeBoard = state.board;
			const board = new TaskBoard(this.limits, state.board);
			const result = fn(state, board); if (state.board === beforeBoard) state.board = board.state;
			state.receipts[key] = { hash, result: result ?? null };
			return result;
		});
	}
	async create(objective: string, baseCommit: string, tasks: { task: TaskSpec; execution: ExecutionSpec }[]): Promise<void> {
		if (!objective.trim() || !/^[a-f0-9]{40,64}$/.test(baseCommit) || !tasks.length || tasks.length > this.maxTasks) throw new Error("Invalid project plan");
		await this.change("operator", randomUUID(), { objective, baseCommit, tasks }, (state, board) => {
			if (!["idle", "completed", "cancelled"].includes(state.status)) throw new Error("Project already has an unfinished goal");
			state.board = { version: 0, tasks: [] }; state.execution = {};
			const next = new TaskBoard(this.limits);
			next.add(tasks.map((item) => item.task));
			for (const item of tasks) {
				if (!item.execution.instructions.trim() || !item.execution.modelId || !item.execution.roleId || !item.execution.checkIds.length) throw new Error("Every task needs an executable/verifiable contract");
				state.execution[item.task.id] = structuredClone(item.execution);
			}
			state.board = next.state;
			state.objective = objective; state.baseCommit = baseCommit; state.status = "active";
		});
	}
	async append(tasks: { task: TaskSpec; execution: ExecutionSpec }[], expectedVersion: number): Promise<void> {
		await this.change("planner", randomUUID(), { tasks, expectedVersion }, (state, board) => {
			if (state.status !== "active" || state.board.version !== expectedVersion || state.board.tasks.length + tasks.length > this.maxTasks) throw new Error("Stale plan or task budget exhausted");
			for (const item of tasks) if (!item.execution.instructions.trim() || !item.execution.modelId || !item.execution.roleId || !item.execution.checkIds.length) throw new Error("Missing task execution contract");
			board.add(tasks.map((item) => item.task));
			for (const item of tasks) state.execution[item.task.id] = item.execution;
		});
	}
	async claim(worker: WorkerIdentity, requestId: string, leaseMs = 60_000): Promise<{ task: TaskRecord; execution: ExecutionSpec; baseCommit: string } | null> {
		return this.change(worker.id, requestId, { op: "claim", worker, leaseMs }, (state, board) => {
			if (state.status !== "active") return null;
			board.recoverExpired(Date.now());
			// Ineligible role/model requirements become unmatchable capabilities in this worker's view.
			const allowed = state.board.tasks.filter((task) => {
				const execution = state.execution[task.id];
				return execution && worker.roleIds.includes(execution.roleId) && worker.modelIds.includes(execution.modelId);
			}).map((task) => task.id);
			const task = board.claim(worker.id, worker.capabilities, Date.now(), leaseMs, allowed);
			if (!task) return null;
			return { task, execution: state.execution[task.id] as ExecutionSpec, baseCommit: state.baseCommit };
		});
	}
	async heartbeat(workerId: string, lease: Lease, requestId: string, leaseMs = 60_000): Promise<void> {
		if (workerId !== lease.workerId) throw new Error("Foreign task lease");
		await this.change(workerId, requestId, { op: "heartbeat", lease, leaseMs }, (state, board) => {
			if (state.status !== "active") throw new Error("Project is not active");
			board.heartbeat(lease, Date.now(), leaseMs);
		});
	}
	async submit(workerId: string, lease: Lease, artifacts: string[], requestId: string): Promise<void> {
		if (workerId !== lease.workerId) throw new Error("Foreign task lease");
		await this.change(workerId, requestId, { op: "submit", lease, artifacts }, (state, board) => {
			if (state.status !== "active") throw new Error("Project no longer active");
			board.submit(lease, artifacts, Date.now());
		});
	}
	async verify(lease: Lease, verdict: Verification, requestId: string, integratedCommit?: string): Promise<void> {
		await this.change("verifier", requestId, { op: "verify", lease, verdict, integratedCommit: integratedCommit ?? null }, (state, board) => {
			if (state.status !== "active") throw new Error("Project no longer active");
			if (verdict.accepted) {
				board.accept(lease, verdict.evidence, Date.now());
				if (integratedCommit) { if (!/^[a-f0-9]{40,64}$/.test(integratedCommit)) throw new Error("Invalid integrated commit"); state.baseCommit = integratedCommit; }
			}
			else board.block(lease, verdict.reason ?? "Verification rejected", Date.now());
			if (board.state.tasks.every((task) => task.status === "done")) state.status = "review";
		});
	}
	async block(lease: Lease, reason: string, requestId: string): Promise<void> {
		await this.change(lease.workerId, requestId, { op: "block", lease, reason }, (_state, board) => board.block(lease, reason, Date.now()));
	}
	async control(action: "pause" | "resume" | "accept" | "cancel"): Promise<void> {
		await this.change("operator", randomUUID(), { action }, (state) => {
			if (action === "accept") { if (state.status !== "review") throw new Error("Goal is not ready for acceptance"); state.status = "completed"; }
			else if (action === "cancel") state.status = "cancelled";
			else if (action === "pause") { if (state.status === "active") state.status = "paused"; }
			else { if (state.status !== "paused") throw new Error("Only a paused goal may resume"); state.status = "active"; }
		});
	}
}
