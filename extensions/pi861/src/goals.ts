import {
	clone,
	digest,
	type Evidence,
	type Goal,
	id,
	nonempty,
	normalizeScope,
	overlaps,
	PlatformError,
	positive,
	requireCondition,
	type Task,
	type TaskSpec,
	throwIfAborted,
} from "./core.ts";
import type { StateStore } from "./store.ts";

function findGoal(goals: Goal[], goalId: string): Goal {
	const goal = goals.find((item) => item.id === goalId);
	requireCondition(goal, "NOT_FOUND", "Goal not found");
	return goal;
}

export function validatePlan(specs: TaskSpec[]): TaskSpec[] {
	requireCondition(
		Array.isArray(specs) && specs.length > 0 && specs.length <= 256,
		"INVALID_PLAN",
		"A plan requires between 1 and 256 tasks",
	);
	const tasks = specs.map((spec) => {
		requireCondition(/^[a-zA-Z0-9_-]{1,80}$/.test(spec.id), "INVALID_PLAN", "Invalid task id");
		nonempty(spec.title, "task title", 500);
		nonempty(spec.instructions, "task instructions");
		nonempty(spec.role, "task role", 100);
		requireCondition(
			spec.mode === undefined || ["direct", "fixed", "dynamic"].includes(spec.mode),
			"INVALID_PLAN",
			"Invalid execution mode",
		);
		requireCondition(
			Array.isArray(spec.dependsOn) &&
				Array.isArray(spec.skillIds) &&
				Array.isArray(spec.requiredCapabilities) &&
				Array.isArray(spec.writeScopes) &&
				Array.isArray(spec.acceptance) &&
				spec.acceptance.length > 0 &&
				Array.isArray(spec.checks),
			"INVALID_PLAN",
			"Task lists and nonempty acceptance requirements are required",
		);
		requireCondition(
			Number.isSafeInteger(spec.minimumTier) && spec.minimumTier >= 0,
			"INVALID_PLAN",
			"minimumTier must be a nonnegative integer",
		);
		for (const requirement of spec.acceptance) nonempty(requirement, "acceptance requirement", 2000);
		for (const field of [...spec.dependsOn, ...spec.skillIds, ...spec.requiredCapabilities, ...spec.checks]) {
			nonempty(field, "task list entry", 200);
		}
		return { ...clone(spec), writeScopes: [...new Set(spec.writeScopes.map(normalizeScope))] };
	});
	const byId = new Map(tasks.map((task) => [task.id, task]));
	requireCondition(byId.size === tasks.length, "INVALID_PLAN", "Duplicate task ids");
	const active = new Set<string>();
	const done = new Set<string>();
	const visit = (taskId: string): void => {
		requireCondition(!active.has(taskId), "CYCLIC_PLAN", "Task dependencies contain a cycle");
		if (done.has(taskId)) return;
		const task = byId.get(taskId);
		requireCondition(task, "INVALID_PLAN", `Unknown dependency ${taskId}`);
		active.add(taskId);
		for (const dependency of task.dependsOn) visit(dependency);
		active.delete(taskId);
		done.add(taskId);
	};
	for (const task of tasks) visit(task.id);
	return tasks;
}

export interface ClaimedTask {
	goalId: string;
	task: Task;
	token: string;
}
export interface Worker {
	id: string;
	roles: string[];
	capabilities: string[];
}
export interface RunResult {
	summary: string;
	artifact?: string;
}
export interface Verification {
	accepted: boolean;
	evidence: Evidence[];
	reason?: string;
}
export interface TaskExecutor {
	run(task: Task, context: { goalId: string; leaseToken: string; signal: AbortSignal }): Promise<RunResult>;
	/** The trusted host implements this. Assistant text is never an acceptance oracle. */
	verify(task: Task, result: RunResult, signal: AbortSignal): Promise<Verification>;
}
export interface SchedulerEvent {
	type: "started" | "completed" | "review" | "blocked" | "idle";
	goalId: string;
	taskId?: string;
	detail?: string;
}

export class GoalService {
	readonly store: StateStore;
	private now: () => number;
	readonly projectConcurrency: number;
	constructor(store: StateStore, options: { now?: () => number; projectConcurrency?: number } = {}) {
		this.store = store;
		this.now = options.now ?? Date.now;
		this.projectConcurrency = positive(options.projectConcurrency ?? 4, "projectConcurrency");
	}
	async create(objective: string, options: { maxConcurrent?: number; maxAttempts?: number } = {}): Promise<Goal> {
		const timestamp = this.now();
		const goal: Goal = {
			id: id("goal"),
			objective: nonempty(objective, "objective"),
			status: "draft",
			planRevision: 0,
			planValidated: false,
			tasks: [],
			maxConcurrent: positive(options.maxConcurrent ?? 2, "maxConcurrent"),
			maxAttempts: positive(options.maxAttempts ?? 64, "maxAttempts"),
			attemptsStarted: 0,
			createdAt: timestamp,
			updatedAt: timestamp,
			notes: [],
		};
		return this.store.transact((state) => {
			state.goals.push(goal);
			state.focusedGoalId = goal.id;
			return goal;
		});
	}
	async get(goalId?: string): Promise<Goal> {
		const state = await this.store.read();
		return findGoal(state.goals, goalId ?? state.focusedGoalId ?? "");
	}
	async setPlan(goalId: string, specs: TaskSpec[], expectedRevision: number): Promise<Goal> {
		const plan = validatePlan(specs);
		return this.store.transact((state) => {
			const goal = findGoal(state.goals, goalId);
			requireCondition(goal.planRevision === expectedRevision, "REVISION_CONFLICT", "Plan has changed");
			requireCondition(
				goal.status === "draft" || goal.status === "paused" || goal.status === "blocked",
				"PAUSE_REQUIRED",
				"Pause the goal before replacing its plan",
			);
			requireCondition(
				!goal.tasks.some((task) => task.status === "running"),
				"WORK_IN_FLIGHT",
				"Wait for in-flight tasks before replacing the plan",
			);
			const previous = new Map(goal.tasks.map((task) => [task.id, task]));
			for (const task of previous.values()) {
				if (task.status === "completed" || task.status === "review" || task.status === "blocked") {
					const replacement = plan.find((spec) => spec.id === task.id);
					const fields = ({
						status: _s,
						attempt: _a,
						maxAttempts: _m,
						evidence: _e,
						lease: _l,
						result: _r,
						artifact: _f,
						blockedReason: _b,
						...spec
					}: Task): TaskSpec => spec;
					requireCondition(
						replacement && digest(replacement) === digest(fields(task)),
						"COMPLETED_TASK_IMMUTABLE",
						"Do not rewrite or remove an accepted task; add corrective work",
					);
				}
			}
			goal.tasks = plan.map((spec) => {
				const old = previous.get(spec.id);
				return old && ["completed", "review", "blocked"].includes(old.status)
					? old
					: { ...spec, status: "pending", attempt: old?.attempt ?? 0, maxAttempts: 3, evidence: [] };
			});
			goal.planRevision++;
			goal.planValidated = true;
			goal.updatedAt = this.now();
			return goal;
		});
	}
	async start(goalId: string): Promise<Goal> {
		return this.store.transact((state) => {
			const goal = findGoal(state.goals, goalId);
			requireCondition(
				goal.status !== "completed" && goal.status !== "cancelled",
				"TERMINAL_GOAL",
				"Terminal goals cannot resume",
			);
			requireCondition(
				goal.tasks.length > 0 && goal.planValidated,
				"PLAN_REQUIRED",
				"A validated task plan is required",
			);
			requireCondition(goal.attemptsStarted < goal.maxAttempts, "BUDGET_EXHAUSTED", "Attempt budget exhausted");
			goal.status = goal.tasks.every((task) => task.status === "completed") ? "completed" : "active";
			goal.updatedAt = this.now();
			return goal;
		});
	}
	async pause(goalId: string, reason = "Paused by user"): Promise<Goal> {
		return this.store.transact((state) => {
			const goal = findGoal(state.goals, goalId);
			requireCondition(
				goal.status !== "completed" && goal.status !== "cancelled",
				"TERMINAL_GOAL",
				"Terminal goals cannot pause",
			);
			goal.status = "paused";
			goal.notes.push(nonempty(reason, "reason", 1000));
			goal.updatedAt = this.now();
			return goal;
		});
	}
	async cancel(goalId: string): Promise<Goal> {
		return this.store.transact((state) => {
			const goal = findGoal(state.goals, goalId);
			requireCondition(goal.status !== "completed", "TERMINAL_GOAL", "Completed goals cannot cancel");
			goal.status = "cancelled";
			for (const task of goal.tasks) {
				if (task.status !== "completed") {
					task.status = "cancelled";
					delete task.lease;
				}
			}
			goal.updatedAt = this.now();
			return goal;
		});
	}
	async editObjective(goalId: string, objective: string): Promise<Goal> {
		return this.store.transact((state) => {
			const goal = findGoal(state.goals, goalId);
			requireCondition(
				goal.status === "draft" || goal.status === "paused",
				"PAUSE_REQUIRED",
				"Pause before changing the objective",
			);
			requireCondition(
				!goal.tasks.some((task) => task.status === "running"),
				"WORK_IN_FLIGHT",
				"Tasks still running",
			);
			goal.objective = nonempty(objective, "objective");
			goal.planValidated = false;
			goal.planRevision++;
			goal.updatedAt = this.now();
			goal.notes.push("Objective changed; revalidate the plan before resuming.");
			goal.status = "draft";
			return goal;
		});
	}
	async claim(goalId: string, worker: Worker, leaseMs = 60_000): Promise<ClaimedTask | null> {
		positive(leaseMs, "leaseMs");
		return this.store.transact((state) => {
			const goal = findGoal(state.goals, goalId);
			if (goal.status !== "active") return null;
			// Expiry fences completion but does not prove an external operation did not happen.
			for (const item of state.goals)
				for (const task of item.tasks) {
					if (task.status === "running" && task.lease && task.lease.expiresAt <= this.now()) {
						task.status = "blocked";
						task.blockedReason = "Lease expired; reconcile side effects before retry";
						delete task.lease;
					}
				}
			const running = state.goals.flatMap((item) => item.tasks.filter((task) => task.status === "running"));
			if (
				running.length >= this.projectConcurrency ||
				goal.tasks.filter((task) => task.status === "running").length >= goal.maxConcurrent
			)
				return null;
			if (goal.attemptsStarted >= goal.maxAttempts) {
				goal.status = "paused";
				goal.notes.push("Attempt budget exhausted; not completed.");
				return null;
			}
			const complete = new Set(goal.tasks.filter((task) => task.status === "completed").map((task) => task.id));
			const task = goal.tasks.find(
				(candidate) =>
					candidate.status === "pending" &&
					candidate.attempt < candidate.maxAttempts &&
					candidate.dependsOn.every((dependency) => complete.has(dependency)) &&
					worker.roles.includes(candidate.role) &&
					candidate.requiredCapabilities.every((capability) => worker.capabilities.includes(capability)) &&
					!running.some((other) =>
						candidate.writeScopes.some((scope) =>
							other.writeScopes.some((otherScope) => overlaps(scope, otherScope)),
						),
					),
			);
			if (!task) return null;
			const token = id("lease");
			task.status = "running";
			task.attempt++;
			task.lease = { token, workerId: worker.id, expiresAt: this.now() + leaseMs };
			goal.attemptsStarted++;
			goal.updatedAt = this.now();
			return { goalId, task, token };
		});
	}
	async renew(claim: ClaimedTask, leaseMs = 60_000): Promise<void> {
		positive(leaseMs, "leaseMs");
		await this.store.transact((state) => {
			const goal = findGoal(state.goals, claim.goalId);
			const task = goal.tasks.find((item) => item.id === claim.task.id);
			requireCondition(
				goal.status !== "cancelled" &&
					task?.status === "running" &&
					task.lease?.token === claim.token &&
					task.lease.expiresAt > this.now(),
				"STALE_LEASE",
				"Worker no longer owns this execution",
			);
			task.lease.expiresAt = this.now() + leaseMs;
		});
	}
	async finish(claim: ClaimedTask, result: RunResult, verification: Verification): Promise<TaskStatusResult> {
		return this.store.transact((state) => {
			const goal = findGoal(state.goals, claim.goalId);
			const task = goal.tasks.find((item) => item.id === claim.task.id);
			requireCondition(
				goal.status !== "cancelled" &&
					task?.status === "running" &&
					task.lease?.token === claim.token &&
					task.lease.expiresAt > this.now(),
				"STALE_LEASE",
				"Ignoring stale or cancelled completion",
			);
			task.result = nonempty(result.summary, "result", 100_000);
			if (result.artifact) task.artifact = result.artifact;
			task.evidence = clone(verification.evidence);
			const verified =
				verification.accepted &&
				verification.evidence.length > 0 &&
				verification.evidence.every((entry) => entry.passed && entry.reference && entry.verifier);
			task.status = verified ? "completed" : "review";
			if (!verified) task.blockedReason = verification.reason ?? "Awaiting independent verification";
			delete task.lease;
			goal.updatedAt = this.now();
			if (goal.tasks.length > 0 && goal.tasks.every((item) => item.status === "completed")) {
				if (goal.status === "active") goal.status = "completed";
			}
			return task.status;
		});
	}
	async fail(claim: ClaimedTask, reason: string): Promise<void> {
		await this.store.transact((state) => {
			const goal = findGoal(state.goals, claim.goalId);
			const task = goal.tasks.find((item) => item.id === claim.task.id);
			if (task?.status !== "running" || task.lease?.token !== claim.token) return;
			task.status = "blocked";
			task.blockedReason = nonempty(reason, "failure", 2000);
			delete task.lease;
			goal.updatedAt = this.now();
		});
	}
	async accept(goalId: string, taskId: string, evidence: Evidence): Promise<void> {
		requireCondition(
			evidence.passed && evidence.verifier && evidence.reference,
			"EVIDENCE_REQUIRED",
			"Acceptance requires evidence",
		);
		await this.store.transact((state) => {
			const goal = findGoal(state.goals, goalId);
			requireCondition(goal.status !== "cancelled", "TERMINAL_GOAL", "Cancelled goal");
			const task = goal.tasks.find((item) => item.id === taskId);
			requireCondition(task?.status === "review", "INVALID_TRANSITION", "Only reviewed results can be accepted");
			task.evidence.push(clone(evidence));
			task.status = "completed";
			delete task.blockedReason;
			if (goal.tasks.every((item) => item.status === "completed")) goal.status = "completed";
		});
	}
	async reconcileRetry(goalId: string, taskId: string): Promise<void> {
		// Host command only: the user must reconcile possible side effects before invoking.
		await this.store.transact((state) => {
			const goal = findGoal(state.goals, goalId);
			requireCondition(goal.status !== "completed" && goal.status !== "cancelled", "TERMINAL_GOAL", "Terminal goal");
			const task = goal.tasks.find((item) => item.id === taskId);
			requireCondition(
				task?.status === "blocked" || task?.status === "review",
				"INVALID_TRANSITION",
				"Task not retryable",
			);
			requireCondition(task.attempt < task.maxAttempts, "BUDGET_EXHAUSTED", "Task attempt limit reached");
			task.status = "pending";
			delete task.blockedReason;
			delete task.lease;
		});
	}
}
type TaskStatusResult = "completed" | "review";

/** A completion-driven queue, not a batch barrier. New dependency-ready tasks are reconsidered immediately. */
export class Scheduler {
	private service: GoalService;
	private active = new Map<string, AbortController>();
	private runningGoals = new Set<string>();
	constructor(service: GoalService) {
		this.service = service;
	}
	stop(goalId: string): void {
		this.active.get(goalId)?.abort();
	}
	async run(
		goalId: string,
		workers: Worker[],
		executor: TaskExecutor,
		onEvent: (event: SchedulerEvent) => void = () => undefined,
	): Promise<Goal> {
		requireCondition(!this.runningGoals.has(goalId), "ALREADY_RUNNING", "Goal already has a local scheduler");
		requireCondition(
			workers.length > 0 && new Set(workers.map((worker) => worker.id)).size === workers.length,
			"INVALID_WORKERS",
			"Workers must have unique ids",
		);
		this.runningGoals.add(goalId);
		const controller = new AbortController();
		this.active.set(goalId, controller);
		const running = new Map<string, Promise<void>>();
		const emit = (event: SchedulerEvent): void => {
			try {
				onEvent(event);
			} catch {
				/* Observers do not own execution. */
			}
		};
		const execute = async (claim: ClaimedTask, worker: Worker): Promise<void> => {
			const attempt = new AbortController();
			const abort = (): void => attempt.abort();
			controller.signal.addEventListener("abort", abort, { once: true });
			let renewing = false;
			const heartbeat = setInterval(() => {
				if (renewing) return;
				renewing = true;
				void this.service
					.renew(claim)
					.catch(() => attempt.abort())
					.finally(() => {
						renewing = false;
					});
			}, 15_000);
			try {
				throwIfAborted(controller.signal);
				emit({ type: "started", goalId, taskId: claim.task.id });
				const result = await executor.run(claim.task, { goalId, leaseToken: claim.token, signal: attempt.signal });
				throwIfAborted(attempt.signal);
				const verification = await executor.verify(claim.task, result, attempt.signal);
				throwIfAborted(attempt.signal);
				const status = await this.service.finish(claim, result, verification);
				emit({ type: status, goalId, taskId: claim.task.id });
			} catch (error) {
				const detail =
					error instanceof PlatformError
						? `${error.code}: ${error.message}`
						: "Worker failed; inspect its execution log";
				await this.service.fail(claim, detail);
				emit({ type: "blocked", goalId, taskId: claim.task.id, detail });
			} finally {
				clearInterval(heartbeat);
				controller.signal.removeEventListener("abort", abort);
				running.delete(worker.id);
			}
		};
		try {
			while (!controller.signal.aborted) {
				const goal = await this.service.get(goalId);
				if (goal.status !== "active") break;
				for (const worker of workers) {
					if (running.has(worker.id) || controller.signal.aborted) continue;
					const claim = await this.service.claim(goalId, worker);
					if (claim) {
						const promise = execute(claim, worker);
						running.set(worker.id, promise);
					}
				}
				if (running.size === 0) {
					emit({
						type: "idle",
						goalId,
						detail: "No eligible task: dependencies, review, capacity or budget may block dispatch",
					});
					break;
				}
				await Promise.race(running.values());
			}
			await Promise.allSettled(running.values());
			return await this.service.get(goalId);
		} finally {
			controller.abort();
			await Promise.allSettled(running.values());
			this.active.delete(goalId);
			this.runningGoals.delete(goalId);
		}
	}
}
