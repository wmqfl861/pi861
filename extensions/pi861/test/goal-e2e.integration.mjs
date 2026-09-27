import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// P3-X AX10 vertical closed loop (K8 part 2). Target snapshot: the P3-I composite runtime
// entry (final SnapshotID TBD at authoring time; bound via PI861_AX_COMPOSITE_SNAPSHOT).
// The nine steps below are the fixed K8 contract from CONTINUATION_PLAN_2026-09-23 section 7
// (AX10 test contract) - their order and wording must not drift.
//
// Gating contract (same as ax-runtime.integration.mjs):
//   - fixture tier (real temp git repo, MCP fixture, protocol worker pair, PG17 container when
//     opted in) runs whenever its files/environment are present and records evidence;
//   - the nine chain steps are composite-tier: skip-by-dependency until the composite snapshot
//     is declared, and HARD FAIL (never skip) if the declared snapshot misses probe files;
//   - a real Pi CLI (PI861_TEST_PI_CLI) and a real PG17 container (docker + PI861_PG17_TESTS=1)
//     are mandatory for activation; absence is recorded, never worked around;
//   - nothing in this file may claim real-model quality; the fixed report sentence is asserted
//     verbatim in step 9.
import {
	CoverageRecorder,
	P1Q_FIXTURES,
	PI_CLI_ENV,
	fixturePresence,
	readiness,
	scenarioById,
	skipReason,
} from "./fixtures/ax-harness.mjs";
import { startMcpHttpServer } from "./fixtures/mcp-http-server.mjs";
import { startPiWorkerPair } from "./fixtures/worker-pair.mjs";
import { pg17OptedIn, startPg17Fixture } from "./fixtures/pg17.mjs";

const scenario = scenarioById("AX10");
const compositeSnapshot = process.env.PI861_AX_COMPOSITE_SNAPSHOT ?? "UNDECLARED";
const compositeDeclared = Boolean(process.env.PI861_AX_COMPOSITE_SNAPSHOT);
const evidenceDir = process.env.PI861_AX_EVIDENCE_DIR ?? null;
const presence = fixturePresence();
const state = readiness(scenario, process.env, presence);
const recorder = new CoverageRecorder("AX10", evidenceDir);

/** Step skip gate: only the undeclared-snapshot case skips; a declared snapshot with missing
 * probe files must hard fail (boundary test below), never silently skip the chain. */
const chainSkip = !compositeDeclared ? skipReason(scenario, state) : false;
/** The fixed closing sentence - asserting it verbatim is part of the K8 contract. */
const CLOSING_SENTENCE = "实际宿主与本地协议闭环，模型为fixture";

function tempGoalRepo() {
	const root = evidenceDir ?? process.env.TEMP ?? ".";
	const path = join(root, `ax10-goal-repo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
	mkdirSync(path, { recursive: true });
	execFileSync("git", ["init", "--quiet", path]);
	// Synthetic requirement: three tasks A (fast), B (slow), C (depends on A) mirroring AX1
	// inside a real repository the planner and integration steps operate on.
	writeFileSync(
		join(path, "REQUIREMENT.md"),
		["# ax10 synthetic requirement", "- A: produce a.txt with content A", "- B: slow independent task", "- C: depends on A", ""].join("\n"),
	);
	writeFileSync(join(path, "check.mjs"), 'import assert from "node:assert/strict"; import { readFileSync, existsSync } from "node:fs"; assert.equal(existsSync("a.txt"), true); assert.equal(readFileSync("a.txt", "utf8"), "A");\n');
	execFileSync("git", ["add", "REQUIREMENT.md", "check.mjs"], { cwd: path });
	execFileSync(
		"git",
		["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "ax10 requirement"],
		{ cwd: path },
	);
	return path;
}

test("AX10 readiness boundary: gates are explicit, never worked around", () => {
	// Runs BEFORE the chain (defined first): a declared snapshot missing its probe files fails
	// the whole file loudly instead of letting the chain steps soft-skip.
	assert.equal(state.compositeDeclared, compositeDeclared);
	if (compositeDeclared && state.missingProbes.length)
		throw new Error(`composite snapshot ${compositeSnapshot} declared but probe files are missing: ${state.missingProbes.join(", ")}`);
	recorder.record(
		"activation checklist",
		"not-run",
		[
			`fixtures present: ${scenario.fixtures.every((name) => presence[name])}`,
			`env gates: ${scenario.envGates.map(([name, value]) => `${name}=${process.env[name] ?? "unset"}${value ? "" : "(any)"}`).join(", ")}`,
			`${PI_CLI_ENV} declared: ${Boolean(process.env[PI_CLI_ENV])}`,
			`composite snapshot: ${compositeSnapshot}`,
		].join("; "),
	);
});

test("AX10: /goal to controlled integration in one closed loop", { timeout: 240_000 }, async (t) => {
	t.after(() => recorder.write(compositeDeclared));

	await t.test("step 0 fixture tier: real git repo, MCP endpoint, protocol workers, PG17", async () => {
		const gaps = state.fixtureGaps;
		if (!gaps.length) {
			const repo = tempGoalRepo();
			const mcp = await startMcpHttpServer();
			const pair = await startPiWorkerPair();
			try {
				const response = await fetch(mcp.url, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }),
				});
				assert.equal(response.status, 200);
				await pair.workers[0].dispatch("A");
				recorder.record(
					"fixture environment assembled",
					"pass",
					`repo=${repo} mcp=${mcp.url} workers=${pair.workers.map((worker) => worker.pid).join("/")}`,
				);
				recorder.record(
					"protocol pair is not real Pi",
					"blocked",
					"the protocol pair drives process/git boundaries only; activation requires two real Pi workers via scripts/worker-service.mjs",
				);
			} finally {
				await pair.stop();
				await mcp.close();
			}
			if (pg17OptedIn()) {
				const pg = await startPg17Fixture();
				try {
					pg.assertVersion17();
					recorder.record("pg17 container", "pass", `container=${pg.containerName} version=${pg.serverVersionNum}`);
				} finally {
					await pg.stop();
				}
			} else {
				recorder.record("pg17 container", "not-run", "PI861_PG17_TESTS=1 not set; activation requires it");
			}
		} else {
			recorder.record("fixture environment assembled", "not-run", `missing fixtures: ${gaps.map((name) => P1Q_FIXTURES[name]).join(", ")}`);
			throw new Error(skipReason(scenario, state));
		}
	});

	// K8 contract step 1: create a real test git repo + synthetic requirement and enter through
	// the actual full-runtime /goal entry.
	await t.test("step 1: goal created from the real /goal entry of the full runtime", { skip: chainSkip }, async () => {
		assert.notEqual(compositeSnapshot, "UNDECLARED");
		assert.ok(process.env[PI_CLI_ENV], "activation requires a real Pi CLI");
		// Composite: boot the runtime entry, issue /goal create with the requirement contract,
		// assert the goal/run identities and the durable queue come from the shared scheduler.
		recorder.record("step1 /goal create", "not-run", "skeleton step awaits P3-I composite snapshot");
		throw new Error("composite snapshot declared but AX10 step 1 is not implemented yet - P3-X activation work");
	});

	// K8 contract step 2: deterministic provider drives the real Pi planner to produce A, slow
	// B and dependent C - no direct injection of a final done state.
	await t.test("step 2: real Pi planner produces the A/B/C plan", { skip: chainSkip }, async () => {
		assert.notEqual(compositeSnapshot, "UNDECLARED");
		// Composite: planner session on the real Pi host with the fixture provider; assert the
		// plan contains the three tasks with C depending on A and that the plan version is
		// recorded; assert no bypass that writes tasks directly into the queue.
		recorder.record("step2 planner via real Pi", "not-run", "skeleton step awaits P3-I composite snapshot");
		throw new Error("composite snapshot declared but AX10 step 2 is not implemented yet - P3-X activation work");
	});

	// K8 contract step 3: two real Pi workers claim tasks, install and activate the test skill,
	// and run restricted operations through stdio and HTTP/SSE MCP.
	await t.test("step 3: two real Pi workers, skill install, stdio + HTTP/SSE MCP", { skip: chainSkip }, async () => {
		assert.notEqual(compositeSnapshot, "UNDECLARED");
		// Composite: start scripts/worker-service.mjs twice (distinct ports, tokens, data dirs,
		// git checkouts); workers claim A/B/C; the test skill installs through the real install
		// path; MCP restricted ops run through both transports against local fixtures.
		recorder.record("step3 dual real Pi workers + skill + MCP", "not-run", "skeleton step awaits P3-I composite snapshot");
		throw new Error("composite snapshot declared but AX10 step 3 is not implemented yet - P3-X activation work");
	});

	// K8 contract step 4: receipts, memory, sources, budget and plan events land in real PG17.
	await t.test("step 4: events persisted to real temporary PG17", { skip: chainSkip }, async () => {
		assert.notEqual(compositeSnapshot, "UNDECLARED");
		// Composite: assert receipts/memory/source DAG/budget ledger/plan events are all
		// queryable from the PG17 fixture after the worker activity of step 3.
		// BOUNDARY: reference+refine combination is BLOCKED-BY-P2M-F1.
		recorder.record("step4 PG17 event persistence", "not-run", "skeleton step awaits P3-I composite snapshot");
		recorder.record("reference+refine combination", "blocked", "BLOCKED-BY-P2M-F1: invalid until the P2-M fix is re-verified");
		throw new Error("composite snapshot declared but AX10 step 4 is not implemented yet - P3-X activation work");
	});

	// K8 contract step 5: trusted checks + independent review with at least one injected
	// review failure producing rework that does not unlock the strong dependent.
	await t.test("step 5: trusted check, independent review, injected failure -> rework", { skip: chainSkip }, async () => {
		assert.notEqual(compositeSnapshot, "UNDECLARED");
		// Composite: run check.mjs through the trusted acceptance runner; inject one review
		// failure on the first A attempt; assert rework task appears, dependent stays blocked,
		// and the second attempt's acceptance references the new artifact.
		recorder.record("step5 review failure -> rework", "not-run", "skeleton step awaits P3-I composite snapshot");
		throw new Error("composite snapshot declared but AX10 step 5 is not implemented yet - P3-X activation work");
	});

	// K8 contract step 6: A accepted, C starts before slow B finishes; idle append wakes;
	// repeated resume does not start a second integration executor.
	await t.test("step 6: scheduling barriers and single integration executor", { skip: chainSkip }, async () => {
		assert.notEqual(compositeSnapshot, "UNDECLARED");
		// Composite: barrier events from the coordinator (A.accepted < C.started < B.finished);
		// append-after-idle wake; double /goal resume -> exactly one integration executor.
		recorder.record("step6 barriers + single executor", "not-run", "skeleton step awaits P3-I composite snapshot");
		throw new Error("composite snapshot declared but AX10 step 6 is not implemented yet - P3-X activation work");
	});

	// K8 contract step 7: verified artifacts apply in the single integration directory and the
	// real repository check runs there.
	await t.test("step 7: controlled integration applies artifacts and runs the repo check", { skip: chainSkip }, async () => {
		assert.notEqual(compositeSnapshot, "UNDECLARED");
		// Composite: integration lease acquired, artifacts applied to the temp repo, check.mjs
		// executed in it, file/program behavior verified (a.txt exists with content A).
		recorder.record("step7 integration + repo check", "not-run", "skeleton step awaits P3-I composite snapshot");
		throw new Error("composite snapshot declared but AX10 step 7 is not implemented yet - P3-X activation work");
	});

	// K8 contract step 8: goal contract satisfied -> adoption fact published, workers closed,
	// evidence saved.
	await t.test("step 8: acceptance, adoption fact, worker shutdown", { skip: chainSkip }, async () => {
		assert.notEqual(compositeSnapshot, "UNDECLARED");
		// Composite: goal contract clauses satisfied by evidence; adoption fact published once;
		// both worker processes and children exit (process-tree exit asserted); evidence dir
		// contains the full chain.
		recorder.record("step8 acceptance + shutdown", "not-run", "skeleton step awaits P3-I composite snapshot");
		throw new Error("composite snapshot declared but AX10 step 8 is not implemented yet - P3-X activation work");
	});

	// K8 contract step 9: the report states the exact boundary sentence - actual host and local
	// protocol closed loop with a fixture model; real model quality is NOT claimed.
	await t.test("step 9: report language boundary", () => {
		assert.equal(
			CLOSING_SENTENCE,
			"实际宿主与本地协议闭环，模型为fixture",
			"the closing sentence is part of the K8 contract and must not drift",
		);
		recorder.record("step9 closing sentence pinned", "pass", `sentence="${CLOSING_SENTENCE}"`);
		recorder.record("step9 chain report emission", "not-run", "emitted by the activated chain report at activation");
	});
});
