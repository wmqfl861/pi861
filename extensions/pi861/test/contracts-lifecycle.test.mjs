import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionLifecycle, issueLease, leaseValid, WakeQueue, wakeEligible } from "../src/contracts/lifecycle.ts";

test("pause, cancel and resume each invalidate permits from earlier generations", () => {
	const session = new SessionLifecycle("s1", 0);
	const permit = session.beginExecution(1);
	assert.equal(session.settleExecution(permit, 2), "accepted");
	session.pause("user request", 3);
	assert.equal(session.settleExecution(permit, 4), "rejected-late");
	session.resume("user request", 5);
	const stale = session.beginExecution(1);
	session.requestCancel("user request", 6);
	assert.equal(session.settleExecution(stale, 7), "rejected-late");
	const outcome = session.completeCancel(7);
	assert.deepEqual(outcome, { reconciliationRequired: false });
});

test("cancellation reports outstanding side effects instead of claiming they never happened", () => {
	const session = new SessionLifecycle("s1", 0);
	const permit = session.beginExecution(1);
	assert.ok(permit);
	session.recordDispatch("op-digest-1", 2);
	session.recordDispatch("op-digest-2", 3);
	session.settleSideEffect("op-digest-1", 4);
	session.requestCancel("stop", 5);
	assert.equal(session.reconciliationRequired, true);
	const outcome = session.completeCancel(6);
	assert.equal(outcome.reconciliationRequired, true);
	assert.equal(session.outstandingDispatches.length, 1);
	assert.throws(() => session.pause("late", 7), /running/);
});

test("execution authority requires a running phase", () => {
	const session = new SessionLifecycle("s1", 0);
	session.pause("hold", 1);
	assert.throws(() => session.beginExecution(2), /running/);
	session.resume("back", 3);
	assert.ok(session.beginExecution(4));
	session.settle("failed", "attempt collapsed", 5);
	assert.equal(session.currentPhase, "failed");
	assert.throws(() => session.beginExecution(6), /running/);
});

test("restoring a session never revives the lost generation's authority", () => {
	const session = new SessionLifecycle("s1", 0);
	const permit = session.beginExecution(1);
	const snapshot = session.exportState();
	const revived = new SessionLifecycle("s1", 0);
	revived.restore(snapshot);
	assert.equal(revived.settleExecution(permit, 2), "rejected-late");
	assert.equal(revived.currentToken.generation, snapshot.generation + 1);
});

test("leases carry generation and expiry and expire deterministically", () => {
	const lease = issueLease("integration", "coordinator-1", 4, 1_000, 500);
	assert.equal(leaseValid(lease, 4, 1_100), true);
	assert.equal(leaseValid(lease, 5, 1_100), false);
	assert.equal(leaseValid(lease, 4, 1_500), false);
	assert.throws(() => issueLease("integration", "owner", 0, 0, 100));
});

test("wake events are idempotent, ordered and acknowledged exactly once", () => {
	const queue = new WakeQueue();
	const first = queue.record("task-finished", "task-1", "done", 10);
	const replay = queue.record("task-finished", "task-1", "done", 10);
	assert.equal(replay.eventDigest, first.eventDigest);
	queue.record("plan-appended", "goal-1", "two tasks", 12);
	assert.equal(queue.pending().length, 2);
	queue.acknowledge([first.eventDigest], 20);
	assert.equal(queue.pending().length, 1);
	queue.acknowledge([first.eventDigest], 21);
	assert.deepEqual(queue.pending()[0].subject, "goal-1");
	assert.throws(() => queue.acknowledge(["missing"], 22), /Unknown wake event/);
});

test("restored wake events fail integrity re-derivation when tampered", () => {
	const queue = new WakeQueue();
	queue.record("node-recovered", "worker-2", "back online", 5);
	const snapshot = queue.exportState();
	const restored = new WakeQueue();
	restored.restore(snapshot);
	assert.equal(restored.pending().length, 1);
	const forged = structuredClone(snapshot);
	forged.events[0].detail = "forged";
	assert.throws(() => new WakeQueue().restore(forged), /integrity/);
});

test("wake eligibility requires a running phase, pending events and free capacity", () => {
	assert.equal(wakeEligible("running", 1, true), true);
	assert.equal(wakeEligible("running", 0, true), false);
	assert.equal(wakeEligible("running", 1, false), false);
	assert.equal(wakeEligible("paused", 1, true), false);
});
