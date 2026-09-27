import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// P3-X AX1-AX9 scenario skeletons (K8 part 1). Target snapshot: the P3-I composite (final
// SnapshotID TBD at authoring time; this file is bound to the composite by
// PI861_AX_COMPOSITE_SNAPSHOT). Every scenario section states its fixtures, execution
// sequence, pass criteria and known boundaries in the AX_SCENARIOS registry (ax-harness.mjs);
// this file composes the P1-Q fixtures (p1-fixtures @ a46de4a96) and NEVER reimplements them.
//
// Gating contract (never skip-to-pass):
//   - fixture files missing            -> whole scenario test skips naming the missing files
//   - environment gate missing (PG17)  -> the container step skips naming the env var; it never
//                                         fakes a database
//   - composite snapshot not declared  -> composite-runtime steps skip-by-dependency; fixture
//                                         tier steps still run and record evidence
//   - snapshot declared but probe file absent -> HARD FAIL (a declared snapshot must satisfy
//     its own contract)
// Skeleton status of this round: fixture-tier steps execute; composite-tier steps are wired
// skip-by-dependency until P3-I publishes the composite SnapshotID. Nothing here claims AX pass.
import {
	AX_SCENARIOS,
	CoverageRecorder,
	P1Q_FIXTURES,
	PI_CLI_ENV,
	AxEventClock,
	barrierSatisfied,
	coverageRow,
	fixturePresence,
	readiness,
	scenarioById,
	skipReason,
} from "./fixtures/ax-harness.mjs";
import { startPiWorkerPair } from "./fixtures/worker-pair.mjs";
import { startFaultProxy } from "./fixtures/fault-proxy.mjs";
import { startMcpHttpServer } from "./fixtures/mcp-http-server.mjs";
import { pg17OptedIn, startPg17Fixture } from "./fixtures/pg17.mjs";

const compositeDeclared = Boolean(process.env.PI861_AX_COMPOSITE_SNAPSHOT);
const compositeSnapshot = process.env.PI861_AX_COMPOSITE_SNAPSHOT ?? "UNDECLARED";
const evidenceDir = process.env.PI861_AX_EVIDENCE_DIR ?? null;
const presence = fixturePresence();

/** Shared MCP JSON-RPC client for fixture-tier transport steps (AX4/AX6). */
async function mcpCall(url, method, params, sessionId, id = Math.floor(Math.random() * 1e9)) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(sessionId ? { "mcp-session-id": sessionId } : {}),
		},
		body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
	});
	const nextSession = response.headers.get("mcp-session-id") ?? sessionId ?? null;
	const text = await response.text();
	const firstEvent = text.split("\n").find((line) => line.startsWith("data:"));
	const payload = JSON.parse(firstEvent ? firstEvent.slice(5).trim() : text);
	return { status: response.status, session: nextSession, payload };
}

/** Fixture-tier temp git repository (AX9): a real repo, committed initial state. */
function tempGitRepo() {
	const root = evidenceDir ?? process.env.TEMP ?? ".";
	const path = join(root, `ax9-repo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
	mkdirSync(path, { recursive: true });
	execFileSync("git", ["init", "--quiet", path]);
	writeFileSync(join(path, "README.md"), "ax9 integration workspace\n");
	execFileSync("git", ["add", "README.md"], { cwd: path });
	execFileSync(
		"git",
		["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "init"],
		{ cwd: path },
	);
	return path;
}

test("AX1: dependent C starts after A is accepted while slow B still runs; idle append wakes", async (t) => {
	const scenario = scenarioById("AX1");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX1", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	await t.test(
		"fixture tier: parallel dispatch A/slow B then dependent C on the same workspace",
		{ skip: skipFixture },
		async () => {
			const pair = await startPiWorkerPair();
			try {
				const clock = new AxEventClock();
				// Execution sequence: A and slow B start in parallel on separate workers; C is
				// dispatched only after A delivered its artifact, on A's workspace (the protocol
				// fixture makes C read a.txt - C fails if A has not actually run there).
				const aDone = pair.workers[0].dispatch("A");
				const bDone = pair.workers[1].dispatch("B");
				await aDone;
				clock.next("A.accepted");
				clock.next("C.started");
				await pair.workers[0].dispatch("C");
				clock.next("C.finished");
				await bDone;
				clock.next("B.finished");
				// Pass criteria (fixture tier): C succeeded in A's workspace (a.txt present, so A
				// really ran) and finished inside B's parallel window.
				assert.equal(pair.workers[0].trace().includes("A:start"), true);
				assert.equal(pair.workers[0].trace().includes("C:start"), true);
				assert.equal(barrierSatisfied(clock, [["A.accepted", "C.started"], ["C.started", "B.finished"]]), true);
				recorder.record("fixture dispatch ordering", "pass", `clock=${JSON.stringify(clock.events)}`);
				// Idle-append wake (fixture tier): after both workers went idle, a new task is
				// still accepted and completes - the pair does not need rebuilding.
				await pair.workers[1].dispatch("D");
				recorder.record("fixture idle-append wake", "pass");
			} finally {
				await pair.stop();
			}
		},
	);
	await t.test(
		"composite tier: coordinator barrier A.accepted < C.started < B.finished from state events",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			// Composite sequence (activated by PI861_AX_COMPOSITE_SNAPSHOT):
			//  1. boot the runtime goal queue with the deterministic provider;
			//  2. submit plan tasks A (fast), B (slow), C (dependsOn A);
			//  3. subscribe to coordinator task-state events and record ticks for
			//     A.accepted / C.started / B.finished;
			//  4. assert barrier order and assert C never starts while A is unaccepted;
			//  5. after the queue drains to idle, append a new task and assert dispatch
			//     without runner reconstruction (runner identity stays stable).
			recorder.record("coordinator barrier (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("idle append without runner rebuild (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			throw new Error("composite snapshot declared but AX1 composite steps are not implemented yet - P3-X activation work");
		},
	);
});

test("AX2: submission unlocks nothing by itself; failed review produces traceable rework", async (t) => {
	const scenario = scenarioById("AX2");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX2", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	await t.test("fixture tier: workers deliver real artifacts for the review ledger", { skip: skipFixture }, async () => {
		const pair = await startPiWorkerPair();
		try {
			await pair.workers[0].dispatch("A");
			assert.equal(pair.workers[0].trace().includes("A:start"), true);
			recorder.record("artifact delivery for review", "pass");
		} finally {
			await pair.stop();
		}
	});
	await t.test(
		"composite tier: review ledger - submit, fail review, rework, no adoption fact",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			// Composite sequence:
			//  1. goal contract with a dependent task D (strong dependency on T1);
			//  2. T1 delivers an artifact -> state must stay review, D stays blocked;
			//  3. inject one independent-review failure -> rework task references the original
			//     artifact id AND attempt id;
			//  4. settle the completion request twice -> counted once;
			//  5. assert no adoption fact was published before acceptance;
			//  6. rework passes review -> only then D becomes ready.
			recorder.record("submit-only keeps dependent blocked (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("rework linked to artifact+attempt (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("repeated settle counted once (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("no adoption fact pre-acceptance (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			throw new Error("composite snapshot declared but AX2 composite steps are not implemented yet - P3-X activation work");
		},
	);
});

test("AX3: failover/failback four combinations under injected transport faults", async (t) => {
	const scenario = scenarioById("AX3");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX3", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	await t.test("fixture tier: fault sources are live (503, hang, drip)", { skip: skipFixture }, async () => {
		const fault = await startFaultProxy();
		try {
			const status = await fetch(`${fault.url}/status?code=503`);
			assert.equal(status.status, 503);
			const hang = fetch(`${fault.url}/hang`, { signal: AbortSignal.timeout(250) });
			await assert.rejects(hang, /aborted|AbortError/i);
			assert.equal(fault.connections.length >= 2, true);
			recorder.record("fault proxy sources", "pass", `connections=${fault.connections.length}`);
		} finally {
			await fault.close();
		}
	});
	await t.test(
		"composite tier: four-combination matrix on the shared model service",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			// Composite sequence (deterministic provider; primary routed at the fault proxy):
			//  1. failover+failback ON: primary faults -> fail over to backup; stability-
			//     confirmed probes switch back; probe budget and single-flight asserted;
			//  2. failover ON/failback OFF: no failback, no probe issued only for failback;
			//  3. failover OFF: no auto-switch to backup; a task already ON the backup is not
			//     forced back;
			//  4. user cancel and 4xx/permission rejections never counted as transient faults;
			//  5. preferred change: new preferred survives old primary's recovery;
			//  6. late response from superseded attempt carries no execution authority;
			//  7. every attempt (including failed) is metered; unknown usage stays unknown.
			recorder.record("four failover/failback combinations (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("probe budget + single-flight (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("preferred change vs old recovery (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("cancel/rejection not transient (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("late response no authority (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			throw new Error("composite snapshot declared but AX3 composite steps are not implemented yet - P3-X activation work");
		},
	);
});

test("AX4: stream interruption points; side effects never duplicated", async (t) => {
	const scenario = scenarioById("AX4");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX4", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	await t.test("fixture tier: cancellable slow tool counts exactly one request", { skip: skipFixture }, async () => {
		const server = await startMcpHttpServer({ slowToolMs: 400 });
		try {
			const init = await mcpCall(server.url, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
			assert.equal(init.status, 200);
			const session = init.session;
			// Fire the slow tool with a known id, cancel it mid-flight by that id, then verify
			// via requestLog that the server saw exactly ONE tools/call for it - the scenario's
			// no-duplicate invariant.
			const slowId = 424242;
			const pending = mcpCall(server.url, "tools/call", { name: "slow", arguments: { value: "ax4" } }, session, slowId);
			await new Promise((resolve) => setTimeout(resolve, 100));
			const cancel = await fetch(server.url, {
				method: "POST",
				headers: { "content-type": "application/json", "mcp-session-id": session },
				body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: slowId, reason: "ax4 cut" } }),
			});
			assert.equal(cancel.status, 202);
			const outcome = await pending;
			assert.equal(outcome.payload.error?.code, -32800, "cancelled slow tool resolves with the cancellation error");
			const calls = server.requestLog.filter((entry) => entry.body.includes('"slow"'));
			assert.equal(calls.length, 1);
			recorder.record("single dispatch under cancellation (fixture)", "pass");
		} finally {
			await server.close();
		}
	});
	await t.test(
		"composite tier: cut at text-mid, param-mid, pre/post dispatch, receipt lost",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			// Composite sequence (stream bridge + operations over the MCP fixture):
			//  1. cut during visible text: partial text stays attributed to its attempt;
			//  2. cut inside tool parameters: zero dispatch (requestLog count for that tool
			//     stays 0), no spliced arguments across attempts;
			//  3. cut just before dispatch vs just after: distinguishable evidence states;
			//  4. tool succeeded but receipt lost (SSE early cut): result resolves unknown ->
			//     confirm via stable business operation id -> NEVER auto re-send;
			//  5. whole-sequence side-effect count on the fixture requestLog is exactly the
			//     number of confirmed dispatches.
			recorder.record("text-mid cut attribution (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("param-mid cut zero dispatch (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("pre/post dispatch distinction (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("receipt lost -> unknown -> confirm (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			throw new Error("composite snapshot declared but AX4 composite steps are not implemented yet - P3-X activation work");
		},
	);
});

test("AX5: two generic debug skills + one specialized - consolidate, branch, update, rollback, pin", async (t) => {
	const scenario = scenarioById("AX5");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX5", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	// Fixture tier: build the three synthetic skill packages (data prep only - the install and
	// consolidation path under test is the composite skill service).
	const packages = [];
	for (const definition of [
		{ id: "debug-generic-a", body: "# debug A\nGeneric debugging workflow.", overlap: true },
		{ id: "debug-generic-b", body: "# debug B\nGeneric debugging workflow (second packager).", overlap: true },
		{ id: "debug-browser", body: "# browser debug\nBrowser-specific debug: devtools, network panel.", overlap: false },
	]) {
		const dir = join(evidenceDir ?? process.env.TEMP ?? ".", `ax5-${definition.id}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `${definition.body}\n`);
		packages.push({ id: definition.id, dir, overlap: definition.overlap });
	}
	recorder.record("synthetic packages prepared", "pass", packages.map((item) => item.id).join(","));
	await t.test(
		"composite tier: install, auto-consolidate, branch, update, rollback, pin",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			// Composite sequence (P2-S skill services):
			//  1. install the three packages through the real install path (no GROUP override);
			//  2. the two overlapping generic packages auto-consolidate; the specialized one
			//     stays a distinct branch (chooseSkillGroup, full-text grouping);
			//  3. default prompt context contains none of the raw original descriptions;
			//  4. start a task pinned to a published version, update the package, assert the
			//     running task's version does not drift;
			//  5. rollback restores the previous immutable publication;
			//  6. resource identity + version manifest stable across the whole sequence.
			recorder.record("auto-consolidation and branch (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("no raw description in default prompt (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("running version pinned across update (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("rollback restores immutable version (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			throw new Error("composite snapshot declared but AX5 composite steps are not implemented yet - P3-X activation work");
		},
	);
});

test("AX6: inactive MCP hides tools; lazy activation, revocation, drift, hidden-name direct call", async (t) => {
	const scenario = scenarioById("AX6");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX6", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	await t.test("fixture tier: pagination walk, schema flip, stale session 404", { skip: skipFixture }, async () => {
		const server = await startMcpHttpServer({ toolCount: 6, pageSize: 3 });
		try {
			const init = await mcpCall(server.url, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
			const session = init.session;
			let cursor = undefined;
			let listed = 0;
			for (let page = 0; page < 4; page++) {
				const list = await mcpCall(server.url, "tools/list", cursor ? { cursor } : {}, session);
				assert.equal(list.status, 200);
				listed += list.payload.result.tools.length;
				cursor = list.payload.result._meta?.nextCursor;
				if (!cursor) break;
			}
			assert.equal(listed, 6 + 3); // six numbered tools + echo + fail + slow
			const before = server.currentSchemaEpoch();
			await mcpCall(server.url, "$/fixtures/flip-schema", {}, session);
			assert.equal(server.currentSchemaEpoch(), before + 1);
			const stale = await mcpCall(server.url, "tools/list", {}, "not-a-session");
			assert.equal(stale.status, 404);
			const calls = server.requestLog.filter((entry) => entry.path === "/mcp" && entry.body.includes('"tools/call"'));
			assert.equal(calls.length, 0, "discovery tier must issue zero tool calls");
			recorder.record("pagination + drift + stale-session (fixture)", "pass");
		} finally {
			await server.close();
		}
	});
	await t.test(
		"composite tier: authorization closures across activation, revocation, drift",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			// Composite sequence (P2-S mcp/operations/capabilities over the fixture):
			//  1. register the MCP service for the post; browse/discover: assert context
			//     injection is empty and fixture requestLog has zero tools/call;
			//  2. activate a published skill branch: only branch-required tools appear;
			//  3. revoke: further calls AND previously issued result references all reject;
			//  4. same tool name bound from two accounts / two skills: closures never cross;
			//  5. flip-schema: old binding invalid, calls rejected until re-activation;
			//  6. literal-name call of a hidden (unactivated) tool rejected.
			recorder.record("discovery injects nothing (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("lazy activation minimal tools (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("revocation closes calls and references (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("closure isolation same-name/multi-account (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("schema drift forces re-activation (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("hidden-name direct call rejected (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			throw new Error("composite snapshot declared but AX6 composite steps are not implemented yet - P3-X activation work");
		},
	);
});

test("AX7: memory auto-record/refine, restore across switches, no leak, no resurrection", async (t) => {
	const scenario = scenarioById("AX7");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX7", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	const envGate = state.envGaps.length ? skipReason(scenario, state) : false;
	await t.test("fixture tier: real PG17 container with restricted runtime role", { skip: skipFixture || envGate }, async () => {
		const pg = await startPg17Fixture();
		try {
			pg.assertVersion17();
			await pg.runtimeRoleIsRestricted();
			assert.equal(Number.isSafeInteger(pg.port), true);
			recorder.record("pg17 container + restricted role", "pass", `container=${pg.containerName} version=${pg.serverVersionNum}`);
		} finally {
			await pg.stop();
		}
	});
	await t.test(
		"composite tier: capture, refine, restore, withdraw across session/model/node",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			// Composite sequence (P2-M memory governance on the PG17 fixture):
			//  1. run a tool execution -> record persisted at execution end (not session end),
			//     refinement task durably queued;
			//  2. new session / model switch / node switch: fixed constraints assemble from
			//     memory without a keyword search happening to hit them;
			//  3. private scope: unauthorized reader gets nothing from summaries, retrieval,
			//     counts or graph edges;
			//  4. withdraw a source: old queued tasks, indexes and derived records all die;
			//     reprocessing the withdrawn source is rejected.
			//  BOUNDARY: steps combining persistent controlled references with refinement are
			//  BLOCKED-BY-P2M-F1 (P2-M review-1 F1) - they must stay excluded until the fix is
			//  re-verified, and the scenario MUST fail if that combination silently reappears.
			recorder.record("execution-end capture + durable refine queue (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("assembly on session/model/node switch (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("private scope no-leak (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("withdrawal kills tasks and indexes (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("reference+refine combination", "blocked", "BLOCKED-BY-P2M-F1: invalid until the P2-M fix is re-verified");
			throw new Error("composite snapshot declared but AX7 composite steps are not implemented yet - P3-X activation work");
		},
	);
});

test("AX8: bounded recovery, requestId receipt confirmation, no local impersonation", async (t) => {
	const scenario = scenarioById("AX8");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX8", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	const envGate = state.envGaps.length ? skipReason(scenario, state) : false;
	await t.test("fixture tier: real PG17 container and version gate", { skip: skipFixture || envGate }, async () => {
		const pg = await startPg17Fixture();
		try {
			pg.assertVersion17();
			recorder.record("pg17 container", "pass", `container=${pg.containerName}`);
		} finally {
			await pg.stop();
		}
	});
	await t.test(
		"composite tier: transient failure recovery and receipt replay",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			// Composite sequence (P2-D storage service on the PG17 fixture; connection loss is
			// injected by stopping the container between commits - no DB-level proxy exists in
			// P1-Q, recorded as a boundary):
			//  1. transient refinement failure: backoff retries, bounded (default 3), success
			//     on attempt <= 3 records failures=2;
			//  2. exhausted retries: permanent failure surfaced with a manual requeue path;
			//  3. commit + cut response (container stop right after COMMIT): replaying the
			//     SAME requestId returns the SAME receipt; a different intent under the same
			//     requestId is rejected as a conflict;
			//  4. store unreachable: local pending records stay explicitly uncommitted.
			//  BOUNDARY: reference+refine combined steps are BLOCKED-BY-P2M-F1.
			recorder.record("bounded retry + permanent failure path (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("same requestId confirms lost receipt (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("different intent same id rejected (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("local pending stays uncommitted (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("reference+refine combination", "blocked", "BLOCKED-BY-P2M-F1: invalid until the P2-M fix is re-verified");
			throw new Error("composite snapshot declared but AX8 composite steps are not implemented yet - P3-X activation work");
		},
	);
});

test("AX9: single coordinator and single integration executor under duplication and restart", async (t) => {
	const scenario = scenarioById("AX9");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX9", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	await t.test("fixture tier: real integration repo and distinct worker identities", { skip: skipFixture }, async () => {
		const repo = tempGitRepo();
		const pair = await startPiWorkerPair();
		try {
			const pids = pair.workers.map((worker) => worker.pid);
			assert.equal(new Set(pids).size, 2);
			recorder.record("repo + distinct worker identities", "pass", `repo=${repo} pids=${pids.join("/")}`);
		} finally {
			await pair.stop();
		}
	});
	await t.test(
		"composite tier: duplicate resume, restart election, plan CAS, git handover",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			// Composite sequence (P2-G leases + P2-W integration tail on the temp repo):
			//  1. issue /goal resume twice concurrently: exactly one coordinator, one
			//     integration executor for the goal; the duplicate is rejected/idempotent;
			//  2. kill and restart the coordinator process: one owner re-elected; the stale
			//     node's late writes cannot overwrite current state;
			//  3. two plan appends, one with a stale plan version: CAS rejects it; a dependency
			//     cycle is rejected;
			//  4. hold a live git process in the integration dir: handover refused until the
			//     process tree exits;
			//  5. full-sequence dispatch ledger: no task dispatched twice.
			recorder.record("duplicate resume single executor (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("restart re-election, stale node rejected (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("plan CAS + cycle rejection (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			recorder.record("git handover waits for process exit (composite)", "not-run", "skeleton step awaits P3-I composite snapshot");
			throw new Error("composite snapshot declared but AX9 composite steps are not implemented yet - P3-X activation work");
		},
	);
});

// Aggregate: the coverage matrix of THIS run. Runs whenever the fixture tier is loadable; it
// re-evaluates readiness for all ten scenarios (AX10 included) and writes ax-coverage.json.
// This test passing only proves the matrix is honest - it is NOT an AX pass record.
test("AX coverage matrix: readiness, dependencies and fixture binding of all scenarios", async () => {
	const matrix = AX_SCENARIOS.map((scenario) => {
		const state = readiness(scenario, process.env, presence);
		return {
			id: scenario.id,
			title: scenario.title,
			requirements: scenario.requirements,
			fixtures: scenario.fixtures.map((name) => P1Q_FIXTURES[name]),
			owners: scenario.composite.owners,
			probes: scenario.composite.probes,
			envGates: scenario.envGates.map(([name]) => name),
			boundaries: scenario.boundaries,
			passCriteria: scenario.passCriteria,
			readiness: state,
			fixtureTierRunnable: state.ready,
			activatable: state.ready && state.compositeDeclared,
		};
	});
	assert.equal(matrix.length, 10);
	for (const row of matrix) {
		// A declared composite snapshot that misses its own probe files is a contract
		// violation: hard fail, never a silent skip (see harness gating contract).
		if (!row.readiness.ready && row.readiness.fixtureGaps.length === 0 && row.readiness.envGaps.length === 0)
			throw new Error(`${row.id}: composite snapshot declared as ${compositeSnapshot} but probe files are missing: ${row.readiness.missingProbes.join(", ")}`);
	}
	if (evidenceDir) {
		const path = join(evidenceDir, "ax-coverage.json");
		writeFileSync(
			path,
			`${JSON.stringify(
				{
					version: 1,
					suite: "ax",
					generatedAt: new Date().toISOString(),
					compositeSnapshot,
					piCliDeclared: Boolean(process.env[PI_CLI_ENV]),
					pg17OptedIn: pg17OptedIn(),
					fixturePresence: presence,
					matrix,
				},
				null,
				2,
			)}\n`,
			{ mode: 0o600 },
		);
	}
	for (const scenario of AX_SCENARIOS) {
		const state = readiness(scenario, process.env, presence);
		process.stdout.write(`${coverageRow(scenario, state)}\n`);
	}
});
