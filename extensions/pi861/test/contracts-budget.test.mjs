import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskTreeBudget, BudgetExhausted } from "../src/contracts/budget.ts";

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
