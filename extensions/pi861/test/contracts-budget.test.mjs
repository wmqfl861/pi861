import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskTreeBudget, BudgetExhausted, ProbeInFlight, TaskTreeCapacity, CapacityExhausted, DEFAULT_SCHEDULING } from "../src/contracts/budget.ts";

const usage = (costUsd, inputTokens = 0, outputTokens = 0) =>
	({ inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd });

test("reserves are settled with reported usage and meter every attempt", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 3, maxInputTokens: 1000, maxOutputTokens: 1000 });
	budget.registerTask("t1", null);
	const reservation = budget.reserve("t1", "execution", usage(0.2, 100), 1);
	budget.settle(reservation.reservationId, usage(0.25, 120));
	assert.deepEqual(budget.usage, { attempts: 1, usage: usage(0.25, 120), unknownSettlements: 0 });
	assert.deepEqual(budget.taskSummary("t1"), { taskId: "t1", parentTaskId: null, limits: undefined, attempts: 1, usage: usage(0.25, 120), unknownSettlements: 0 });
});

test("auxiliary and probe calls without a task are metered against the tree", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 5, maxInputTokens: 1000, maxOutputTokens: 1000 });
	const reception = budget.reserve(null, "reception", usage(0.1), 1);
	budget.settle(reception.reservationId, usage(0.1));
	const probe = budget.reserve(null, "probe", usage(0.05), 2);
	budget.settle(probe.reservationId, usage(0.05));
	assert.equal(budget.usage.attempts, 2);
	assert.ok(Math.abs(budget.usage.usage.costUsd - 0.15) < 1e-9);
});

test("whole-tree exhaustion blocks further reserves regardless of kind", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 10, maxInputTokens: 1000, maxOutputTokens: 1000 });
	const first = budget.reserve(null, "execution", usage(0.6), 1);
	budget.settle(first.reservationId, usage(0.6));
	assert.throws(() => budget.reserve(null, "planning", usage(0.5), 2), (error) => error instanceof BudgetExhausted && error.scope === "tree");
});

test("open reservations hold capacity until settled or released", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 10, maxInputTokens: 1000, maxOutputTokens: 1000 });
	const held = budget.reserve(null, "execution", usage(0.7), 1);
	assert.throws(() => budget.reserve(null, "execution", usage(0.4), 2), BudgetExhausted);
	budget.release(held.reservationId);
	const retry = budget.reserve(null, "execution", usage(0.4), 3);
	budget.settle(retry.reservationId, usage(0.4));
	assert.equal(budget.usage.attempts, 1);
});

test("subtree limits constrain descendants and settle upward into ancestors", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 10, maxAttempts: 100, maxInputTokens: 1000, maxOutputTokens: 1000 });
	budget.registerTask("parent", null, { maxTotalCostUsd: 1, maxAttempts: 4, maxInputTokens: 1000, maxOutputTokens: 1000 });
	budget.registerTask("child-a", "parent");
	budget.registerTask("child-b", "parent");
	const a = budget.reserve("child-a", "execution", usage(0.4), 1);
	budget.settle(a.reservationId, usage(0.4));
	const b = budget.reserve("child-b", "execution", usage(0.4), 2);
	budget.settle(b.reservationId, usage(0.4));
	assert.equal(budget.taskSummary("child-a").usage.costUsd, 0.4);
	assert.equal(budget.taskSummary("parent").usage.costUsd, 0.8);
	assert.equal(budget.taskSummary("parent").attempts, 2);
	assert.throws(() => budget.reserve("child-a", "execution", usage(0.4), 3), (error) => error instanceof BudgetExhausted && error.scope === "task:parent");
});

test("attempt limits are enforced per subtree and per tree", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 10, maxAttempts: 2, maxInputTokens: 1000, maxOutputTokens: 1000 });
	budget.registerTask("t1", null);
	const first = budget.reserve("t1", "execution", usage(0.1), 1);
	budget.settle(first.reservationId, usage(0.1));
	const second = budget.reserve(null, "probe", usage(0.1), 2);
	budget.settle(second.reservationId, usage(0.1));
	assert.throws(() => budget.reserve("t1", "execution", usage(0.1), 3), BudgetExhausted);
});

test("unknown usage books a bounded conservative estimate and never zero", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 10, maxAttempts: 10, maxInputTokens: 1000, maxOutputTokens: 1000 });
	budget.registerTask("t1", null);
	const reservation = budget.reserve("t1", "execution", usage(0.5, 100), 1);
	assert.throws(() => budget.settleUnknown(reservation.reservationId, usage(0)), /cannot be booked as zero/);
	budget.settleUnknown(reservation.reservationId, usage(0.5, 100));
	assert.equal(budget.usage.unknownSettlements, 1);
	assert.equal(budget.taskSummary("t1").unknownSettlements, 1);
	assert.equal(budget.usage.usage.costUsd, 0.5);
	assert.equal(budget.usage.attempts, 1);
});

test("input token limits count cache reads and settled usage together", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 10, maxAttempts: 10, maxInputTokens: 100, maxOutputTokens: 100 });
	const reservation = budget.reserve(null, "execution", { inputTokens: 60, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, 1);
	budget.settle(reservation.reservationId, { inputTokens: 30, outputTokens: 0, cacheReadTokens: 30, cacheWriteTokens: 0, costUsd: 0 });
	assert.throws(() => budget.reserve(null, "execution", { inputTokens: 50, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }, 2), BudgetExhausted);
});

test("F03 restored reservations retain unique ids and enforce held attempt capacity", () => {
	const limits = { maxTotalCostUsd: 10, maxAttempts: 2, maxInputTokens: 100, maxOutputTokens: 100 };
	const before = new TaskTreeBudget(limits);
	const old = before.reserve(null, "execution", usage(1), 1);
	const restored = new TaskTreeBudget(limits);
	restored.restore(before.exportState());
	const next = restored.reserve(null, "planning", usage(1), 2);
	assert.notEqual(next.reservationId, old.reservationId);
	assert.throws(() => restored.reserve(null, "probe", usage(1), 3), BudgetExhausted);
	const again = new TaskTreeBudget(limits);
	again.restore(restored.exportState());
	again.settle(old.reservationId, usage(1));
	again.settle(next.reservationId, usage(1));
	assert.equal(again.usage.attempts, 2);
	assert.throws(() => again.reserve(null, "probe", usage(1), 4), BudgetExhausted);
});

test("budget reservation views cannot reduce held capacity", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 10, maxInputTokens: 100, maxOutputTokens: 100 });
	const reservation = budget.reserve(null, "execution", usage(1), 1);
	reservation.estimate.costUsd = 0;
	budget.openReservations()[0].estimate.costUsd = 0;
	budget.exportState().reservations[0].estimate.costUsd = 0;
	assert.throws(() => budget.reserve(null, "planning", usage(0.1), 2), BudgetExhausted);
});

test("snapshots round-trip task hierarchy, subtree limits and unknown counts", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 10, maxAttempts: 10, maxInputTokens: 1000, maxOutputTokens: 1000 });
	budget.registerTask("parent", null, { maxTotalCostUsd: 1, maxAttempts: 4, maxInputTokens: 1000, maxOutputTokens: 1000 });
	budget.registerTask("child", "parent");
	const reservation = budget.reserve("child", "distill", usage(0.2), 1);
	budget.settleUnknown(reservation.reservationId, usage(0.2));
	const snapshot = budget.exportState();
	const restored = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 1, maxInputTokens: 1, maxOutputTokens: 1 });
	restored.restore(snapshot);
	assert.equal(restored.taskSummary("parent").limits?.maxTotalCostUsd, 1);
	assert.equal(restored.taskSummary("child").unknownSettlements, 1);
	assert.equal(restored.taskSummary("child").parentTaskId, "parent");
	assert.throws(() => budget.reserve("unregistered", "execution", usage(0.1), 2), /Unknown task/);
});

test("root budget ids are explicit or unique per tree and survive snapshots", () => {
	const first = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 1, maxInputTokens: 1, maxOutputTokens: 1 }, { budgetId: "goal-42" });
	assert.equal(first.budgetId, "goal-42");
	const snapshot = first.exportState();
	assert.equal(snapshot.version, 2);
	assert.equal(snapshot.budgetId, "goal-42");
	const restored = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 1, maxInputTokens: 1, maxOutputTokens: 1 });
	restored.restore(snapshot);
	assert.equal(restored.budgetId, "goal-42");
	const anonymousA = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 1, maxInputTokens: 1, maxOutputTokens: 1 });
	const anonymousB = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 1, maxInputTokens: 1, maxOutputTokens: 1 });
	assert.notEqual(anonymousA.budgetId, anonymousB.budgetId);
	const legacy = structuredClone(snapshot);
	legacy.version = 1;
	delete legacy.budgetId;
	assert.throws(() => new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 1, maxInputTokens: 1, maxOutputTokens: 1 }).restore(legacy), /Invalid budget snapshot/);
	assert.throws(() => new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 1, maxInputTokens: 1, maxOutputTokens: 1 }, { budgetId: "" }));
});

test("one physical probe bills once: a shared probeKey rejects duplicate in-flight reserves", () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 10, maxAttempts: 20, maxInputTokens: 1000, maxOutputTokens: 1000 });
	const probe = budget.reserve(null, "probe", usage(0.05), 1, { probeKey: "probe:api.example.com:acc-1" });
	assert.equal(probe.probeKey, "probe:api.example.com:acc-1");
	assert.throws(() => budget.reserve(null, "probe", usage(0.05), 2, { probeKey: "probe:api.example.com:acc-1" }), (error) => error instanceof ProbeInFlight && error.probeKey === "probe:api.example.com:acc-1");
	budget.settle(probe.reservationId, usage(0.05));
	// The settled probe is a past physical probe; a NEW physical probe may use the key again.
	const next = budget.reserve(null, "probe", usage(0.05), 3, { probeKey: "probe:api.example.com:acc-1" });
	budget.release(next.reservationId);
	// A released reservation no longer blocks the single-flight key either.
	assert.doesNotThrow(() => budget.reserve(null, "probe", usage(0.05), 4, { probeKey: "probe:api.example.com:acc-1" }));
	assert.throws(() => budget.reserve("x", "execution", usage(0.05), 5, { probeKey: "k" }), /Only probe reservations/);
	assert.throws(() => budget.reserve(null, "probe", usage(0.05), 6, { probeKey: "" }), /Invalid probe key/);
	const snapshot = budget.exportState();
	const restored = new TaskTreeBudget({ maxTotalCostUsd: 10, maxAttempts: 20, maxInputTokens: 1000, maxOutputTokens: 1000 });
	restored.restore(snapshot);
	const open = restored.exportState().reservations.find((reservation) => reservation.state === "reserved");
	assert.equal(open?.probeKey, "probe:api.example.com:acc-1");
});

test("probe keys snapshot rejects duplicate open keys and non-probe kinds", () => {
	const snapshot = new TaskTreeBudget({ maxTotalCostUsd: 10, maxAttempts: 10, maxInputTokens: 10, maxOutputTokens: 10 }).exportState();
	snapshot.reservations.push({ reservationId: "r-1", taskId: null, kind: "probe", estimate: usage(0.1), openedAt: 1, state: "reserved", probeKey: "k" });
	snapshot.reservations.push({ reservationId: "r-2", taskId: null, kind: "probe", estimate: usage(0.1), openedAt: 2, state: "reserved", probeKey: "k" });
	assert.throws(() => new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 1, maxInputTokens: 1, maxOutputTokens: 1 }).restore(snapshot), /Invalid (budget|reservation) snapshot/);
	const misplaced = new TaskTreeBudget({ maxTotalCostUsd: 10, maxAttempts: 10, maxInputTokens: 10, maxOutputTokens: 10 }).exportState();
	misplaced.reservations.push({ reservationId: "r-1", taskId: null, kind: "execution", estimate: usage(0.1), openedAt: 1, state: "reserved", probeKey: "k" });
	assert.throws(() => new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 1, maxInputTokens: 1, maxOutputTokens: 1 }).restore(misplaced), /Invalid (budget|reservation) snapshot/);
});

test("task capacity holds slots while running and frees them when a parent waits (R3.6)", () => {
	assert.deepEqual(DEFAULT_SCHEDULING, { maxConcurrentTasks: 2, attemptsPerTask: 2, maxProjectTasks: 100 });
	const capacity = new TaskTreeCapacity();
	capacity.registerTask("parent", null);
	capacity.registerTask("child-a", "parent");
	capacity.registerTask("child-b", "parent");
	capacity.start("parent", 1);
	capacity.start("child-a", 2);
	assert.equal(capacity.runningCount, 2);
	assert.throws(() => capacity.start("child-b", 3), (error) => error instanceof CapacityExhausted && error.runningCount === 2);
	capacity.beginWaiting("parent", 4);
	assert.equal(capacity.runningCount, 1);
	capacity.start("child-b", 5);
	assert.equal(capacity.runningCount, 2);
	assert.deepEqual(capacity.slotSummary("parent"), { taskId: "parent", parentTaskId: null, state: "waiting", since: 4 });
	capacity.finish("child-a", 6);
	assert.equal(capacity.runningCount, 1);
	capacity.start("parent", 7);
	assert.equal(capacity.runningCount, 2);
	capacity.registerTask("child-c", "parent");
	assert.throws(() => capacity.finish("child-a", 8), /already finished/);
	assert.throws(() => capacity.beginWaiting("child-c", 9), /Only a running task/);
	assert.throws(() => capacity.start("parent", 10), /cannot start from running/);
});

test("task capacity bounds the project total and restores snapshots with integrity checks", () => {
	const capacity = new TaskTreeCapacity({ maxConcurrentTasks: 1, maxProjectTasks: 3 });
	capacity.registerTask("t1", null);
	capacity.registerTask("t2", "t1");
	capacity.registerTask("t3", "t1");
	assert.throws(() => capacity.registerTask("t4", null), /Project task limit reached/);
	capacity.start("t2", 1);
	const snapshot = capacity.exportState();
	const restored = new TaskTreeCapacity();
	restored.restore(snapshot);
	assert.equal(restored.runningCount, 1);
	assert.equal(restored.maxProjectTasks, 3);
	assert.equal(restored.slotSummary("t2").state, "running");
	const forged = structuredClone(snapshot);
	forged.slots[0].state = "bogus";
	assert.throws(() => new TaskTreeCapacity().restore(forged), /Invalid capacity snapshot/);
	const cyclic = structuredClone(snapshot);
	cyclic.slots[0].parentTaskId = "t3";
	assert.throws(() => new TaskTreeCapacity().restore(cyclic), /Invalid capacity snapshot|cyclic/);
	const overConcurrent = structuredClone(snapshot);
	overConcurrent.slots[1].state = "running";
	overConcurrent.slots[2].state = "running";
	assert.throws(() => new TaskTreeCapacity().restore(overConcurrent), /over concurrency/);
	assert.throws(() => new TaskTreeCapacity({ maxConcurrentTasks: 0 }));
	assert.throws(() => capacity.start("missing", 2), /Unknown task/);
	assert.throws(() => capacity.registerTask("t2", null), /duplicate/);
});
