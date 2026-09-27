import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkerPairEvidence } from "../src/live/acceptance.ts";
import { startPiWorkerPair } from "./fixtures/worker-pair.mjs";

// P1-Q dual-worker fixture coverage (K7): two REAL independent worker processes with isolated
// workspaces and traces, plus the single-worker counterexample that can never report a pair.

test("two real worker processes run tasks in isolation and validate as a pair", async (t) => {
	const pair = await startPiWorkerPair();
	t.after(() => pair.stop());
	const [first, second] = pair.workers;
	assert.ok(Number.isSafeInteger(first.pid) && first.pid > 0);
	assert.ok(Number.isSafeInteger(second.pid) && second.pid > 0);
	assert.notEqual(first.pid, second.pid);
	assert.notEqual(first.workspace, second.workspace);
	assert.notEqual(first.tracePath, second.tracePath);
	assert.ok(first.child.pid === first.pid && second.child.pid === second.pid);
	await first.dispatch("A");
	await second.dispatch("B");
	assert.match(first.trace(), /A:start/);
	assert.match(second.trace(), /B:start/);
	assert.equal(first.trace().includes("B:start"), false);
	assert.equal(second.trace().includes("A:start"), false);
	const validation = pair.validation();
	assert.deepEqual(validation, { valid: true, workers: 2, distinctPids: true, distinctWorkspaces: true });
	const evidence = pair.evidence();
	assert.equal(evidence.kind, "pi-worker-pair");
	assert.equal(evidence.workers.length, 2);
});

test("a single live worker never validates as a dual-worker pair", async (t) => {
	const pair = await startPiWorkerPair();
	t.after(() => pair.stop());
	const single = { kind: "pi-worker-pair", workers: pair.evidence().workers.slice(0, 1) };
	const validation = validateWorkerPairEvidence(single);
	assert.equal(validation.valid, false);
	assert.equal(validation.workers, 1);
	assert.equal(validation.reason, "fewer than two workers");
	await pair.workers[1].dispatch("B");
	assert.match(pair.workers[1].trace(), /B:start/);
});
