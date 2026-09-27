import { randomUUID } from "node:crypto";
import { scopesConflict } from "../scheduler.ts";
import type { PlanTask, ProjectCoordinator, ProjectState, WorkerIdentity } from "./coordinator.ts";

export type GoalCommand =
	| { action: "status" | "pause" | "resume" | "cancel" | "clear" | "accept" }
	| { action: "create" | "edit"; objective: string }
	| { action: "budget"; maxWork: number }
	| { action: "unblock"; taskId: string; reason: string };

export function parseGoalCommand(input: string): GoalCommand {
	const trimmed = input.trim();
	if (!trimmed) return { action: "status" };
	const [verb, ...parts] = trimmed.split(/\s+/);
	const remainder = parts.join(" ");
	if (["status", "pause", "resume", "cancel", "clear", "accept"].includes(verb ?? "")) {
		if (remainder) throw new Error("Goal control command takes no arguments; use new <objective> for literal text");
		switch (verb) {
			case "pause":
			case "resume":
			case "cancel":
			case "clear":
			case "accept":
				return { action: verb };
			default:
				return { action: "status" };
		}
	}
	if (verb === "new" || verb === "edit") {
		if (!remainder) throw new Error("Goal objective required");
		return { action: verb === "new" ? "create" : "edit", objective: remainder };
	}
	if (verb === "budget") {
		const maxWork = Number(remainder);
		if (!/^\d+$/.test(remainder) || !Number.isSafeInteger(maxWork) || maxWork < 1)
			throw new Error("Usage: budget <positive integer>");
		return { action: "budget", maxWork };
	}
	if (verb === "unblock") {
		const [taskId, ...reason] = parts;
		if (!taskId || !reason.length) throw new Error("Usage: unblock <taskId> <reconciliation reason>");
		return { action: "unblock", taskId, reason: reason.join(" ") };
	}
	return { action: "create", objective: trimmed };
}

export function goalStatus(state: ProjectState, workers: WorkerIdentity[] = []) {
	const tasks = state.board.tasks;
	const busy = tasks.filter((task) => task.status === "running" || task.status === "review");
	const queued = tasks.filter((task) => task.status === "queued");
	const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
	const reasons = {
		dependencies: queued.filter((task) => task.dependsOn.some((id) => !done.has(id))).length,
		resources: queued.filter((task) =>
			busy.some(
				(active) =>
					scopesConflict(task.writeScopes, active.writeScopes) ||
					task.resources?.some((resource) => active.resources?.includes(resource)),
			),
		).length,
		review: tasks.filter((task) => task.status === "review").length,
		permissions: queued.filter(
			(task) =>
				!workers.some(
					(worker) =>
						task.capabilities.every((item) => worker.capabilities.includes(item)) &&
						worker.roleIds.includes(state.execution[task.id]?.roleId ?? "") &&
						worker.modelIds.includes(state.execution[task.id]?.modelId ?? ""),
				),
		).length,
		faults: tasks.filter((task) => task.status === "blocked").length + (state.integrationFailure ? 1 : 0),
		budget: Boolean(state.group && state.group.usedWork >= state.group.maxWork),
		noQueuedWork: queued.length === 0,
	};
	return {
		status: state.status,
		objective: state.objective,
		goal: state.goal,
		group: state.group,
		pendingWakes: state.wakeQueue?.events.filter((event) => !event.delivered).length ?? 0,
		counts: Object.fromEntries(
			["queued", "running", "waiting", "review", "done", "blocked", "cancelled"].map((status) => [
				status,
				tasks.filter((task) => task.status === status).length,
			]),
		),
		unusedCapacity: Math.max(0, (state.group?.limits.maxConcurrent ?? 0) - busy.length - (state.planning ? 1 : 0)),
		reasons,
		reason: state.reason,
		integration: state.integration,
		evidence: state.evidence ?? [],
		isolation: {
			backend: "none",
			protected: ["git-worktree", "declared-write-scopes"],
			unprotected: ["credentials", "network", "host-processes", "host-files"],
		},
	};
}

export interface GoalCommandOptions {
	coordinator: ProjectCoordinator;
	workers?: WorkerIdentity[];
	/** Trusted integration wiring supplies planning, base selection and runner construction. */
	create: (
		objective: string,
		signal: AbortSignal,
	) => Promise<{ baseCommit: string; tasks: PlanTask[]; sealed?: boolean }>;
	start: () => void | Promise<void>;
	pause: () => Promise<void>;
	cancel: () => Promise<void>;
}
/** One command service over the existing queue; no separate continuation loop. */
export class GoalCommandService {
	private readonly options: GoalCommandOptions;
	constructor(options: GoalCommandOptions) {
		this.options = options;
	}
	async execute(input: string, signal: AbortSignal, requestId = randomUUID()): Promise<ReturnType<typeof goalStatus>> {
		signal.throwIfAborted();
		const command = parseGoalCommand(input);
		const coordinator = this.options.coordinator;
		switch (command.action) {
			case "create": {
				const plan = await this.options.create(command.objective, signal);
				signal.throwIfAborted();
				await coordinator.create(command.objective, plan.baseCommit, plan.tasks, {
					sealed: plan.sealed,
					requestId,
				});
				await this.options.start();
				break;
			}
			case "pause":
				await this.options.pause();
				break;
			case "cancel":
			case "clear":
				await this.options.cancel();
				break;
			case "resume":
				await coordinator.control("resume", requestId);
				await this.options.start();
				break;
			case "accept":
				await coordinator.control("accept", requestId);
				break;
			case "edit":
				await coordinator.edit(command.objective, requestId);
				break;
			case "budget":
				await coordinator.budget(command.maxWork, requestId);
				break;
			case "unblock":
				await coordinator.unblock(command.taskId, requestId, command.reason);
				break;
			case "status":
				break;
		}
		return goalStatus(await coordinator.state(), this.options.workers);
	}
}
