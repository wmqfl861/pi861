import assert from "node:assert/strict";
import { test } from "node:test";
import { goalStatus, parseGoalCommand, GoalCommandService } from "../src/live/goal-command.ts";
import { emptyProject } from "../src/live/coordinator.ts";

test("goal command parser keeps literal objectives distinct from controls", () => {
	assert.deepEqual(parseGoalCommand("status"), { action: "status" });
	assert.deepEqual(parseGoalCommand("new status"), { action: "create", objective: "status" });
	assert.deepEqual(parseGoalCommand("edit resume"), { action: "edit", objective: "resume" });
	assert.deepEqual(parseGoalCommand("budget 12"), { action: "budget", maxWork: 12 });
	assert.deepEqual(parseGoalCommand("unblock task-a tests passed"), { action: "unblock", taskId: "task-a", reason: "tests passed" });
	assert.throws(() => parseGoalCommand("budget 0"), /positive integer/);
	assert.throws(() => parseGoalCommand("pause now"), /takes no arguments/);
});

test("goal status explains capacity, permissions and isolation boundaries", () => {
	const state = emptyProject("project");
	state.objective = "goal";
	state.status = "active";
	state.group = { id: "group", limits: { maxConcurrent: 2, maxAttempts: 2 }, maxTasks: 10, maxWork: 10, usedWork: 1 };
	state.board.tasks = [{ id: "A", title: "A", dependsOn: ["missing"], writeScopes: ["a.txt"], capabilities: ["code"], acceptance: ["check"], status: "queued", attempts: 0, artifacts: [], evidence: [] }];
	state.execution.A = { instructions: "run", roleId: "dev", modelId: "fixture", checkIds: ["verify"] };
	state.wakeQueue = { version: 1, events: [
		{ version: 1, reason: "plan-appended", subject: "goal", detail: "Tasks appended to the plan", occurredAt: 1, eventDigest: "d1", delivered: false },
		{ version: 1, reason: "task-finished", subject: "A", detail: "Task attempt finished", occurredAt: 2, eventDigest: "d2", delivered: true, deliveredAt: 3 },
	] };
	const view = goalStatus(state, [{ id: "worker", capabilities: [], roleIds: ["reader"], modelIds: ["fixture"] }]);
	assert.equal(view.reasons.dependencies, 1);
	assert.equal(view.reasons.permissions, 1);
	assert.equal(view.pendingWakes, 1);
	assert.deepEqual(view.isolation.unprotected, ["credentials", "network", "host-processes", "host-files"]);
});

test("goal command service uses the coordinator queue for create and status", async () => {
	const calls = [];
	const state = emptyProject("project");
	const coordinator = {
		create: async (objective, baseCommit, tasks, options) => { calls.push(["create", objective, baseCommit, tasks, options]); state.objective = objective; state.status = "active"; },
		state: async () => state,
	};
	const service = new GoalCommandService({
		coordinator,
		create: async (objective) => ({ baseCommit: "a".repeat(40), tasks: [], sealed: false }),
		start: () => { calls.push(["start"]); },
		pause: async () => { calls.push(["pause"]); },
		cancel: async () => { calls.push(["cancel"]); },
	});
	const view = await service.execute("new queued goal", new AbortController().signal, "request-1");
	assert.equal(view.objective, "queued goal");
	assert.deepEqual(calls.map(([name]) => name), ["create", "start"]);
	assert.equal((await service.execute("status", new AbortController().signal)).status, "active");
});
