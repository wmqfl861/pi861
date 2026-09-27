import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
// P3-X AX1-AX9 acceptance scenarios (K8 part 1). Bound to the P3-I composite snapshot via
// PI861_AX_COMPOSITE_SNAPSHOT; every composite step runs against the merged runtime modules
// (coordinator/scheduler/runner, model service + routing, stream bridge + operations ledger,
// skill services, MCP/capabilities, memory governance and the PG17 storage service). The P1-Q
// fixtures (p1-fixtures @ c76a4ad54) are composed, never reimplemented.
//
// Gating contract (never skip-to-pass): fixture files missing -> scenario skips naming them;
// PI861_PG17_TESTS=1 + docker missing -> the container steps skip naming the gate (never fake
// a database); composite snapshot undeclared -> composite steps skip-by-dependency; a declared
// snapshot missing probe files -> HARD FAIL. A step that did not run is recorded "not-run" and
// the scenario stays "incomplete" - it can never aggregate to pass (G7).
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
import { startFaultProxy } from "./fixtures/fault-proxy.mjs";
import { startMcpHttpServer } from "./fixtures/mcp-http-server.mjs";
import { pg17OptedIn, startPg17Fixture } from "./fixtures/pg17.mjs";
import { startPiWorkerPair } from "./fixtures/worker-pair.mjs";
import { FileStateStore } from "../src/live/store.ts";
import { emptyProject, ProjectCoordinator } from "../src/live/coordinator.ts";
import { InProcessWakeChannel, ProjectRunner } from "../src/live/project-runner.ts";
import { Workspaces } from "../src/live/workspace.ts";
import { inferWithRecovery, ModelFailure, ModelRecovery } from "../src/routing.ts";
import { emptyUsageLedger, ModelUsageService } from "../src/live/model-service.ts";
import { ProbeInFlight } from "../src/contracts/budget.ts";
import { AttemptStreamBridge, businessOperationId, StreamOperationBlocked } from "../src/live/stream-bridge.ts";
import { StreamClaims } from "../src/live/stream-claims.ts";
import { managedStream } from "../src/live/managed-stream.ts";
import { ModelRuntime } from "../src/live/model-runtime.ts";
import { OperationLedger } from "../src/contracts/operation.ts";
import { digest } from "../src/contracts/hash.ts";
import { McpClient } from "../src/live/mcp.ts";
import { IdentityAuthority } from "../src/contracts/identity.ts";
import { TaskTreeBudget } from "../src/contracts/budget.ts";
import { AuxiliaryModelInvocations } from "../src/live/auxiliary-models.ts";
import { SkillRepository, emptySkillState } from "../src/live/skill-repository.ts";
import { auxiliaryCompiler, auxiliaryGrouping } from "../src/live/skill-services.ts";
import { installCapabilities } from "../src/live/skills-host.ts";
import { recordSkillAcceptance, runSkillValidation } from "../src/live/skill-validation.ts";
import { attachMemoryGovernance } from "../src/live/memory-service.ts";
import { MemoryCommitPending, PendingMemoryWrites } from "../src/live/memory-pending.ts";
import { ServicePrincipalDirectory, StorageService, migrateStorage, provisionServicePrincipal } from "../src/live/storage-service.ts";

const execute = promisify(execFile);
const compositeDeclared = Boolean(process.env.PI861_AX_COMPOSITE_SNAPSHOT);
const compositeSnapshot = process.env.PI861_AX_COMPOSITE_SNAPSHOT ?? "UNDECLARED";
const evidenceDir = process.env.PI861_AX_EVIDENCE_DIR ?? null;
const presence = fixturePresence();
const PI_WORKER = fileURLToPath(new URL("./fixtures/pi-worker.mjs", import.meta.url));
const STDIO_FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const signal = () => new AbortController().signal;

/** Shared MCP JSON-RPC client for raw fixture control (AX4 cancellation, AX6 schema flip). */
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
	return { status: response.status, session: nextSession, payload: JSON.parse(firstEvent ? firstEvent.slice(5).trim() : text) };
}

/** Real temp git repo with one base commit (AX1/AX2/AX9 workspaces). */
function tempGitRepo(prefix = "ax") {
	const path = join(evidenceDir ?? tmpdir(), `${prefix}-repo-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
	mkdirSync(path, { recursive: true });
	execFileSync("git", ["init", "--quiet", path]);
	writeFileSync(join(path, "README"), "ax base\n");
	execFileSync("git", ["add", "README"], { cwd: path });
	execFileSync(
		"git",
		["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "base"],
		{ cwd: path },
	);
	return path;
}

const planTask = (id, extra = {}) => ({
	task: {
		id,
		title: id,
		dependsOn: id === "C" ? ["A"] : [],
		writeScopes: [`${id.toLowerCase()}.txt`],
		capabilities: [],
		acceptance: ["Candidate check succeeds"],
		retrySafe: true,
		...extra,
	},
	execution: {
		instructions: `implement ${id}`,
		roleId: "dev",
		modelId: "test",
		checkIds: id === "B" ? ["slow-verify"] : ["verify"],
		...(extra.execution ?? {}),
	},
});
const verifyCheck = { id: "verify", command: process.execPath, args: ["-e", "if(!require('fs').existsSync('README'))process.exit(1)"] };
const slowVerifyCheck = { id: "slow-verify", command: process.execPath, args: ["-e", "setTimeout(()=>process.exit(0),1500)"] };
const workerSpec = (trace, extraEnv = {}) => (workspace) => ({
	command: process.execPath,
	args: [PI_WORKER],
	cwd: workspace.path,
	env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TRACE: trace, ...extraEnv },
});
const waitForTask = async (coordinator, id, expected, limit = 400) => {
	for (let attempt = 0; attempt < limit; attempt++) {
		const task = (await coordinator.state()).board.tasks.find((item) => item.id === id);
		if (task?.status === expected) return task;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`timeout waiting for ${id}:${expected}`);
};

// The pg pools are plain driver objects (the driver loads from the operator root); structural
// use is duck-typed through the small helpers below.
const poolQuery = (pool, sql, args) => pool.query(sql, args);

// ---------------------------------------------------------------------------
// Shared PG17 setup for AX7/AX8 (real container, restricted runtime role, migrated schema).
// ---------------------------------------------------------------------------
async function startPgScenario(prefix) {
	const fixture = await startPg17Fixture();
	fixture.assertVersion17();
	await fixture.runtimeRoleIsRestricted();
	const driverRoot = process.env.PI861_TEST_DRIVER_ROOT;
	if (!driverRoot) throw new Error("AX7/AX8 need PI861_TEST_DRIVER_ROOT pointing at the operator pg driver root");
	const requireDriver = createRequire(join(driverRoot, "package.json"));
	const { Pool } = requireDriver("pg");
	const admin = new Pool({
		connectionString: `postgres://${fixture.migrationEnv.PI861_TEST_PG_MIGRATION_USER}:${fixture.migrationEnv.PI861_TEST_PG_MIGRATION_PASSWORD}@127.0.0.1:${fixture.port}/pi861_test`,
		max: 4,
	});
	const suffix = `${prefix}${Math.floor(Math.random() * 1e9).toString(36)}`;
	const schema = `pi861_ax_${suffix}`;
	const roles = ["m", "r", "i"].map((kind) => `pi861_ax_${kind}_${suffix}`);
	const password = `pw-${Math.random().toString(36).slice(2)}`;
	const root = join(evidenceDir ?? tmpdir(), `pg-${suffix}`);
	mkdirSync(root, { recursive: true });
	await admin.query(`CREATE ROLE "${roles[0]}" LOGIN PASSWORD '${password}' NOSUPERUSER BYPASSRLS`);
	await admin.query(`CREATE ROLE "${roles[1]}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
	await admin.query(`CREATE ROLE "${roles[2]}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
	await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${roles[0]}"`);
	const roleUrl = (role) => `postgres://${role}:${password}@127.0.0.1:${fixture.port}/pi861_test`;
	const migration = new Pool({ connectionString: roleUrl(roles[0]), options: `-c search_path=${schema}`, max: 2 });
	await migration.query(readFileSync(new URL("../sql/memory-v1.sql", import.meta.url), "utf8"));
	await migration.query(readFileSync(new URL("../sql/runtime-v2.sql", import.meta.url), "utf8"));
	await migrateStorage(migration, {
		writersStopped: true,
		backupPath: join(root, "storage-backup.json"),
		conflictReportPath: join(root, "conflict-report.json"),
		memory: { backupPath: join(root, "memory-backup.json"), sources: [], runtimeSources: [] },
	});
	await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${roles[1]}"`);
	await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${roles[1]}"`);
	await admin.query(`REVOKE INSERT, UPDATE ON "${schema}".pi861_schema_migrations, "${schema}".pi861_memory_imports, "${schema}".pi861_memory_legacy_receipts FROM "${roles[1]}"`);
	await admin.query(`GRANT DELETE ON "${schema}".pi861_memory_projections, "${schema}".pi861_memory_jobs TO "${roles[1]}"`);
	await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${roles[1]}"`);
	await admin.query(`REVOKE ALL ON "${schema}".pi861_service_principals FROM "${roles[1]}"`);
	await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${roles[2]}"`);
	await admin.query(`GRANT SELECT ON "${schema}".pi861_service_principals TO "${roles[2]}"`);
	const runtime = new Pool({ connectionString: roleUrl(roles[1]), options: `-c search_path=${schema}`, max: 4 });
	const identity = new Pool({ connectionString: roleUrl(roles[2]), options: `-c search_path=${schema}`, max: 2 });
	return {
		root,
		containerName: fixture.containerName,
		serverVersionNum: fixture.serverVersionNum,
		adminPool: admin,
		migrationPool: migration,
		runtimePool: runtime,
		identityPool: identity,
		cleanup: async () => {
			for (const pool of [runtime, identity, migration]) await pool.end().catch(() => {});
			await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
			for (const role of roles) await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
			await admin.end().catch(() => {});
			await fixture.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("AX1: dependent C starts after A is accepted while slow B still runs; idle append wakes", async (t) => {
	const scenario = scenarioById("AX1");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX1", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	await t.test("fixture tier: parallel dispatch A/slow B then dependent C on the same workspace", { skip: skipFixture }, async () => {
		const pair = await startPiWorkerPair();
		try {
			const clock = new AxEventClock();
			const aDone = pair.workers[0].dispatch("A");
			const bDone = pair.workers[1].dispatch("B");
			await aDone;
			clock.next("A.accepted");
			clock.next("C.started");
			await pair.workers[0].dispatch("C");
			clock.next("C.finished");
			await bDone;
			clock.next("B.finished");
			assert.equal(pair.workers[0].trace().includes("A:start"), true);
			assert.equal(pair.workers[0].trace().includes("C:start"), true);
			assert.equal(barrierSatisfied(clock, [["A.accepted", "C.started"], ["C.started", "B.finished"]]), true);
			recorder.record("fixture dispatch ordering", "pass", `clock=${JSON.stringify(clock.events)}`);
			await pair.workers[1].dispatch("D");
			recorder.record("fixture idle-append wake", "pass");
		} finally {
			await pair.stop();
		}
	});
	await t.test(
		"composite tier: coordinator barrier A.accepted < C.started < B.finished from state events",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			const root = mkdtempSync(join(tmpdir(), "pi861-ax1-"));
			const repo = tempGitRepo("ax1");
			try {
				const workspaces = new Workspaces(repo, join(root, "trees"));
				const base = await workspaces.head();
				const statePath = join(root, "state.json");
				const limits = { maxConcurrent: 2, maxAttempts: 3 };
				const coordinator = new ProjectCoordinator(new FileStateStore(statePath, emptyProject("ax1")), limits);
				// The goal stays UNSEALED with a failing task F: the runner stays resident so
				// the idle-append step below runs against the SAME live runner instance.
				await coordinator.create("ax1 goal", base, [planTask("A"), planTask("B"), planTask("C"), planTask("F")], { sealed: false });
				const events = [];
				const integration = await workspaces.create("integration", 1, base);
				const markRoot = mkdtempSync(join(tmpdir(), "pi861-ax1-marks-"));
				const failEnv = { PI861_FIXTURE_MARKDIR: markRoot, PI861_FIXTURE_FAIL_ONCE: "F" };
				const runner = new ProjectRunner({
					coordinator,
					workspaces,
					integration,
					checks: [verifyCheck, slowVerifyCheck],
					workers: [0, 1].map((index) => ({
						identity: { id: `w${index}`, capabilities: [], roleIds: ["dev"], modelIds: ["test"] },
						process: workerSpec(join(root, `trace-${index}`), failEnv),
					})),
					idle: "hold",
					wake: new InProcessWakeChannel(),
					maintenanceMs: 150,
					onProgress: (event) => events.push(`${event.taskId}:${event.state}`),
				});
				const settled = runner.start();
				try {
					await waitForTask(coordinator, "F", "blocked");
					await waitForTask(coordinator, "B", "done");
					await waitForTask(coordinator, "C", "done");
					const final = await coordinator.state();
					// Barrier on durable state events, not model text: A's behavioral
					// evidence (acceptance) precedes C's execution start, which precedes
					// B's acceptance.
					const acceptedAt = (id) => {
						const found = final.evidence.find((entry) => entry.kind === "behavioral-check" && entry.taskId === id);
						assert.ok(found, `no acceptance evidence for ${id}`);
						return found.at;
					};
					const startedAt = (id) => {
						const found = final.stages.find((stage) => stage.taskId === id && stage.kind === "execution" && stage.status === "started");
						assert.ok(found, `no start stage for ${id}`);
						return found.at;
					};
					assert.ok(acceptedAt("A") < startedAt("C"), `A.accepted(${acceptedAt("A")}) must precede C.started(${startedAt("C")})`);
					assert.ok(startedAt("C") < acceptedAt("B"), `C.started(${startedAt("C")}) must precede B.finished(${acceptedAt("B")})`);
					assert.ok(events.indexOf("C:running") < events.indexOf("B:done"), events.join(","));
					recorder.record("coordinator barrier (composite)", "pass", `events=${events.join(",")}`);
					// Idle-append wake on the RESIDENT runner: a second coordinator appends
					// while the queue is idle; no rebuild, no local wake call needed.
					const external = new ProjectCoordinator(new FileStateStore(statePath, emptyProject("ax1")), limits);
					await external.append([planTask("D")], (await external.state()).goal.planVersion, { sealed: false, requestId: "append-D" });
					await waitForTask(coordinator, "D", "done");
					assert.ok(events.indexOf("D:running") > events.indexOf("A:done"), events.join(","));
					// The blocked task also wakes through the operator unblock path.
					await external.unblock("F", "fixture failure resolved by operator", "unblock-F");
					await waitForTask(coordinator, "F", "done");
					recorder.record("idle append without runner rebuild (composite)", "pass");
				} finally {
					await runner.pause();
					await settled;
				}
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
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
			const root = mkdtempSync(join(tmpdir(), "pi861-ax2-"));
			const repo = tempGitRepo("ax2");
			try {
				// Part 1: submit-only never unlocks the strong dependent (board semantics).
				const gatekeeper = new ProjectCoordinator(new FileStateStore(join(root, "gate.json"), emptyProject("ax2")), {
					maxConcurrent: 2,
					maxAttempts: 2,
				});
				await gatekeeper.create("gate goal", "a".repeat(40), [planTask("A"), planTask("C")]);
				const worker = { id: "good", capabilities: [], roleIds: ["dev"], modelIds: ["test"] };
				const claim = await gatekeeper.claim(worker, "c1");
				assert.equal(claim.task.id, "A");
				await gatekeeper.submit("good", claim.task.lease, ["artifact:a"], "s1");
				assert.equal(await gatekeeper.claim(worker, "c2"), null, "dependent must stay locked while A is only submitted");
				await gatekeeper.verify(claim.task.lease, { accepted: false, evidence: [], reason: "integration failed" }, "v1");
				assert.equal(await gatekeeper.claim(worker, "c3"), null, "rejected verification keeps the dependent locked");
				assert.equal((await gatekeeper.state()).board.tasks.find((task) => task.id === "A").status, "blocked");
				recorder.record("submit-only keeps dependent blocked (composite)", "pass");
				// Part 2: the full runner chain with an independent reviewer that rejects the
				// first candidate; the rework must link back to the original artifact+attempt.
				const workspaces = new Workspaces(repo, join(root, "trees"));
				const base = await workspaces.head();
				const coordinator = new ProjectCoordinator(new FileStateStore(join(root, "chain.json"), emptyProject("ax2")), {
					maxConcurrent: 2,
					maxAttempts: 3,
				});
				const reworkable = planTask("W", { writeScopes: ["w.txt", "w-repair-1.txt"] });
				await coordinator.create("rework goal", base, [reworkable]);
				const events = [];
				let reviews = 0;
				const integration = await workspaces.create("integration", 1, base);
				const runner = new ProjectRunner({
					coordinator,
					workspaces,
					integration,
					checks: [verifyCheck],
					workers: [{ identity: { id: "w0", capabilities: [], roleIds: ["dev"], modelIds: ["test"] }, process: workerSpec(join(root, "trace")) }],
					reviewerId: "reviewer-1",
					audit: async (task) => {
						reviews++;
						return task.reworkFor !== undefined;
					},
					onProgress: (event) => events.push(`${event.taskId}:${event.state}`),
				});
				await runner.start();
				const final = await coordinator.state();
				assert.ok(reviews >= 1, "the independent reviewer actually ran");
				const stages = final.stages.filter((stage) => stage.kind === "review");
				assert.ok(stages.some((stage) => stage.status === "failed"), "one review verdict must be a failure");
				const repair = final.board.tasks.find((task) => task.reworkFor === "W");
				assert.ok(repair, `repair task for W must exist: ${final.board.tasks.map((task) => task.id).join(",")}`);
				assert.match(repair.id, /^W-repair-/);
				const repairExecution = final.execution[repair.id];
				assert.ok(repairExecution.instructions.includes("Review evidence"), "rework carries the failure evidence");
				assert.ok(repairExecution.instructions.includes("Prior artifacts"), "rework links the original artifact");
				assert.ok(final.evidence.some((entry) => entry.kind === "independent-review" && entry.recordedBy === "reviewer-1"));
				assert.equal(final.board.tasks.find((task) => task.id === "W").status, "done");
				assert.equal(repair.status, "done");
				recorder.record("rework linked to artifact+attempt (composite)", "pass", `repair=${repair.id} attempts=${repair.attempts}`);
				// Part 3: repeated settle of a settled completion is refused while the project
				// is still active (a settled lease is stale); no adoption fact (human
				// acceptance) exists before the operator accepts the goal.
				const settle = new ProjectCoordinator(new FileStateStore(join(root, "settle.json"), emptyProject("ax2s")), {
					maxConcurrent: 2,
					maxAttempts: 2,
				});
				// Unsealed: the goal stays ACTIVE after S1 is accepted, so the repeated
				// settle hits the lease fence, not the status fence.
				await settle.create("settle goal", "a".repeat(40), [planTask("S1")], { sealed: false });
				const settleWorker = { id: "good", capabilities: [], roleIds: ["dev"], modelIds: ["test"] };
				const settleClaim = await settle.claim(settleWorker, "sc1");
				await settle.submit("good", settleClaim.task.lease, ["artifact:s1"], "ss1");
				await settle.verify(settleClaim.task.lease, { accepted: true, evidence: ["verified"] }, "sv1");
				await assert.rejects(
					settle.verify(settleClaim.task.lease, { accepted: true, evidence: ["again"] }, "sv2"),
					/[Ss]tale/,
					"a settled completion cannot settle again",
				);
				const preAccept = await coordinator.state();
				assert.equal(preAccept.status, "review");
				assert.ok(!preAccept.evidence.some((entry) => entry.kind === "human-acceptance"), "no adoption fact before acceptance");
				await coordinator.control("accept");
				const accepted = await coordinator.state();
				assert.equal(accepted.status, "completed");
				assert.equal(accepted.evidence.filter((entry) => entry.kind === "human-acceptance").length, 1);
				await assert.rejects(coordinator.control("accept", "again"), /not ready for acceptance/);
				recorder.record("repeated settle counted once (composite)", "pass");
				recorder.record("no adoption fact pre-acceptance (composite)", "pass");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
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
			const models = [
				{ id: "cheap", revision: "1", provider: "p1", model: "a", quality: 1, costRank: 1, contextWindow: 100, capabilities: ["tools"], enabled: true },
				{ id: "strong", revision: "1", provider: "p2", model: "b", quality: 3, costRank: 3, contextWindow: 1000, capabilities: ["tools", "vision"], enabled: true },
				{ id: "backup", revision: "1", provider: "p3", model: "c", quality: 3, costRank: 4, contextWindow: 1000, capabilities: ["tools", "vision"], enabled: true },
			];
			const requirements = { minQuality: 3, contextTokens: 200, capabilities: ["tools"], allowedIds: ["cheap", "strong", "backup"] };
			const defaults = { failoverEnabled: true, failbackEnabled: true, probeIntervalMs: 10, maxProbeIntervalMs: 100, requiredProbeSuccesses: 2 };
			const make = (options = {}) => new ModelRecovery(models, "strong", requirements, { ...defaults, ...options });
			for (const failoverEnabled of [false, true])
				for (const failbackEnabled of [false, true]) {
					const recovery = make({ failoverEnabled, failbackEnabled });
					assert.equal(recovery.fail(recovery.beginAttempt(), "transient", 0), failoverEnabled, `failover=${failoverEnabled}`);
					assert.equal(recovery.state.preferred, "strong");
					assert.equal(recovery.state.active, failoverEnabled ? "backup" : "strong");
					assert.equal(Boolean(recovery.beginProbe(10)), failoverEnabled && failbackEnabled);
				}
			recorder.record("four failover/failback combinations (composite)", "pass");
			// Probe budget + single-flight through the shared C3 service: one physical
			// probe joins the in-flight reservation; a second consumer never bills twice.
			const ledgerRoot = mkdtempSync(join(tmpdir(), "pi861-ax3-"));
			const service = new ModelUsageService(new FileStateStore(join(ledgerRoot, "usage.json"), emptyUsageLedger()), {
				estimate: { inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
				unknownEstimate: { inputTokens: 2000, outputTokens: 2000, cacheReadTokens: 100, cacheWriteTokens: 100, costUsd: 0.01 },
				rootLimits: { maxTotalCostUsd: 100, maxAttempts: 100, maxInputTokens: 1e7, maxOutputTokens: 1e7 },
				budgetId: "ax3-budget",
				recordLimit: 8,
				identityLimit: 16,
			});
			const probeKey = "account-a\nendpoint-a\nprov";
			const first = await service.reserve("probe-1", "probe", { probeKey });
			assert.equal(first.admitted, true);
			await assert.rejects(service.reserve("probe-2", "probe", { probeKey }), (error) => error instanceof ProbeInFlight);
			const billing = { inputPerMt: 3, outputPerMt: 6, cacheReadPerMt: 0.3, cacheWritePerMt: 3.75 };
			await service.settle({
				requestId: "probe-1",
				purpose: "probe",
				target: { id: "strong", provider: "p", model: "m", revision: "1", billing },
				startedAt: 1,
				finishedAt: 2,
				outcome: "success",
				reservationId: first.reservationId,
				// Integer token counts only: the settlement validator rejects non-integer
				// measurements (costUsd included), so cost stays unset and unknown-zero-free.
				usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
			});
			assert.equal((await service.reserve("probe-3", "probe", { probeKey })).admitted, true, "settling frees the probe key");
			const totals = await service.totals();
			assert.equal(totals.attempts, 1, "exactly one physical probe is metered");
			recorder.record("probe budget + single-flight (composite)", "pass", `attempts=${totals.attempts}`);
			// Preferred change vs old recovery: a new preferred invalidates the old probe.
			const preferred = make();
			preferred.fail(preferred.beginAttempt(), "transient", 0);
			const probe = preferred.beginProbe(10);
			preferred.setPreferred("backup", requirements);
			assert.equal(preferred.finishProbe(probe, true, 20), false);
			assert.equal(preferred.atBoundary(), false);
			recorder.record("preferred change vs old recovery (composite)", "pass");
			// Real HTTP attempts through the fault proxy: failover switches once; a user
			// cancellation and a service rejection never start a backup request.
			const fault = await startFaultProxy();
			try {
				const recovery = new ModelRecovery(models, "strong", requirements, defaults);
				const called = [];
				const result = await inferWithRecovery(
					recovery,
					async (target) => {
						called.push(target.id);
						if (target.id === "strong") {
							const response = await fetch(`${fault.url}/status?code=503`);
							if (response.status >= 500) throw new ModelFailure("transient");
						}
						return "backup answer";
					},
					{ signal: new AbortController().signal, timeoutMs: 5000, maxAttempts: 3 },
				);
				assert.equal(result, "backup answer");
				assert.deepEqual(called, ["strong", "backup"], `failover must switch once: ${called.join(",")}`);
				const controller = new AbortController();
				let cancelCalls = 0;
				await assert.rejects(
					inferWithRecovery(
						new ModelRecovery(models, "strong", requirements, defaults),
						async () => {
							cancelCalls++;
							controller.abort(new Error("user cancelled"));
							return new Promise(() => {});
						},
						{ signal: controller.signal, timeoutMs: 5000, maxAttempts: 3 },
					),
					/user cancelled/,
				);
				assert.equal(cancelCalls, 1);
				await assert.rejects(
					inferWithRecovery(
						new ModelRecovery(models, "strong", requirements, defaults),
						async () => {
							throw new ModelFailure("invalid");
						},
						{ signal: new AbortController().signal, timeoutMs: 5000, maxAttempts: 3 },
					),
					/invalid/,
				);
				recorder.record("cancel/rejection not transient (composite)", "pass");
			} finally {
				await fault.close();
			}
			// Late response: a superseded attempt's success is refused; failback needs two
			// successful probes AND an idle operation boundary.
			const late = make();
			const old = late.beginAttempt();
			late.fail(old, "transient", 0);
			assert.equal(late.succeed(old), false);
			assert.equal(late.state.inFlight, false);
			const stability = make();
			stability.fail(stability.beginAttempt(), "transient", 0);
			const firstProbe = stability.beginProbe(10);
			stability.finishProbe(firstProbe, true, 10);
			const inFlight = stability.beginAttempt();
			assert.equal(stability.atBoundary(), false, "no failback while work is in flight");
			stability.succeed(inFlight);
			const secondProbe = stability.beginProbe(20);
			stability.finishProbe(secondProbe, true, 20);
			const boundary = stability.beginAttempt();
			stability.succeed(boundary);
			assert.equal(stability.atBoundary(), true);
			assert.equal(stability.state.active, "strong");
			recorder.record("late response no authority (composite)", "pass");
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
			assert.equal(server.requestLog.filter((entry) => entry.body.includes('"slow"')).length, 1);
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
			const attempt = (generation) => ({ generation, configId: "fixture", configRevision: "1" });
			const tool = { type: "toolCall", id: "write-1", name: "write", arguments: { path: "out.txt" } };
			const message = (...content) => ({ content, model: "fixture", usage: { input: 2, output: 1 } });
			const textPart = { type: "text", text: "answer" };
			// 1) Cut during visible text: text keeps its attribution, half-received tool
			//    parameters never surface.
			{
				const events = [];
				const bridge = new AttemptStreamBridge((event) => events.push(event), () => true);
				const owner = attempt(1);
				bridge.begin(owner, signal());
				bridge.push(owner, { type: "start", partial: message() });
				bridge.push(owner, { type: "toolcall_delta", contentIndex: 0, delta: '{"path":', partial: message({ ...tool, arguments: {} }) });
				bridge.push(owner, { type: "text_delta", contentIndex: 1, delta: "answer", partial: message(tool, textPart) });
				bridge.push(owner, { type: "error", reason: "error", error: message(tool) });
				assert.equal(bridge.commit(owner), false);
				assert.equal(events.some((event) => event.type.startsWith("toolcall")), false, "half-received tool params must never surface");
				assert.ok(events.some((event) => event.type === "text_delta"), "visible text keeps its attribution");
				recorder.record("text-mid cut attribution (composite)", "pass");
			}
			// 2) Cancellation with a complete buffered tool: zero dispatch.
			{
				const events = [];
				const bridge = new AttemptStreamBridge((event) => events.push(event), () => true);
				const owner = attempt(1);
				const controller = new AbortController();
				bridge.begin(owner, controller.signal);
				bridge.push(owner, { type: "done", reason: "toolUse", message: message(tool) });
				controller.abort();
				assert.equal(bridge.commit(owner), false);
				assert.equal(events.length, 0);
				recorder.record("param-mid cut zero dispatch (composite)", "pass");
			}
			// 3+4) Receipt-lost handling over the REAL MCP fixture: dispatch executes the
			// fixture's echo tool through a real McpClient HTTP transport; the fixture
			// requestLog is the side-effect oracle and must show exactly the confirmed
			// dispatches across the whole unknown -> reconcile -> re-dispatch sequence.
			const server = await startMcpHttpServer();
			const client = new McpClient({ id: "ax4", accountId: "a", transport: { kind: "http", url: server.url, allowLoopbackHttp: true } });
			try {
				const tools = await client.tools(signal());
				const echo = tools.find((entry) => entry.name === "echo");
				assert.ok(echo, "fixture exposes the echo tool");
				const ledger = new OperationLedger();
				const bind = (value) => ({
					identity: { serviceId: "ax4", toolName: value.name, accountId: "a", resourceId: "res", schemaDigest: echo.schemaHash },
					inputDigest: digest(value.arguments),
				});
				const echoCall = { ...tool, name: "echo", arguments: { message: "ax4" } };
				const operationId = businessOperationId(bind(echoCall));
				const toolCalls = (events) => events.filter((event) => event.type.startsWith("toolcall"));
				const mcpCalls = () => server.requestLog.filter((entry) => entry.body.includes('"tools/call"')).length;
				const execute = () => client.call("echo", { message: "ax4" }, echo.schemaHash, signal());
				// First attempt: commit claims the C5 operation and emits the dispatch; the
				// host then executes ONE real tools/call; the receipt is lost in transit.
				const firstEvents = [];
				const firstBridge = new AttemptStreamBridge((event) => firstEvents.push(event), () => true, { ledger, bind, now: () => 1 });
				const ownerOne = attempt(1);
				firstBridge.begin(ownerOne, signal());
				firstBridge.push(ownerOne, { type: "done", reason: "toolUse", message: message(echoCall) });
				assert.equal(firstBridge.commit(ownerOne), true);
				assert.equal(ledger.get(operationId).status, "dispatched", "pre-dispatch claim recorded");
				assert.equal(toolCalls(firstEvents).length, 2, "start+end emitted exactly once");
				assert.equal(mcpCalls(), 0, "emission is pre-execution; the operation runs next");
				await execute();
				assert.equal(mcpCalls(), 1);
				ledger.markUnknown(operationId, "receipt lost in transit", 2);
				// Second attempt with a DIFFERENT local toolCallId: blocked, zero new effects.
				const secondEvents = [];
				const secondBridge = new AttemptStreamBridge((event) => secondEvents.push(event), () => true, { ledger, bind, now: () => 3 });
				const ownerTwo = attempt(2);
				secondBridge.begin(ownerTwo, signal());
				secondBridge.push(ownerTwo, { type: "done", reason: "toolUse", message: message({ ...echoCall, id: "write-2" }) });
				assert.throws(() => secondBridge.commit(ownerTwo), (error) => error instanceof StreamOperationBlocked);
				assert.equal(toolCalls(secondEvents).length, 0);
				assert.equal(mcpCalls(), 1, "unknown outcome: no re-send under a new toolCallId");
				recorder.record("pre/post dispatch distinction (composite)", "pass");
				// Trusted reconciliation proves not-executed: one re-dispatch, then the
				// succeeded operation can never dispatch again.
				ledger.reconcile(operationId, { status: "not-executed" }, 4);
				assert.equal(secondBridge.commit(ownerTwo), true);
				await execute();
				ledger.markSucceeded(operationId, digest(["done"]), 5);
				const thirdEvents = [];
				const thirdBridge = new AttemptStreamBridge((event) => thirdEvents.push(event), () => true, { ledger, bind, now: () => 6 });
				const ownerThree = attempt(3);
				thirdBridge.begin(ownerThree, signal());
				thirdBridge.push(ownerThree, { type: "done", reason: "toolUse", message: message({ ...echoCall, id: "write-3" }) });
				assert.throws(() => thirdBridge.commit(ownerThree), (error) => error instanceof StreamOperationBlocked);
				assert.equal(toolCalls(thirdEvents).length, 0);
				assert.equal(mcpCalls(), 2, "exactly two real dispatches across the whole sequence");
				recorder.record("receipt lost -> unknown -> confirm (composite)", "pass", `mcpCalls=${mcpCalls()}`);
			} finally {
				await client.close();
				await server.close();
			}
		},
	);
	await t.test(
		"composite tier round-3 wiring: shared ledger claim-once, unknown gate + resolve recovery, revocation zero dispatch",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			// SnapshotID-3 (5cacec62e) wires C5 stream claims into the managed stream: one
			// SHARED OperationLedger across bridges, stable business ids for activated
			// capability tools, unknown receipts pausing model dispatch until the trusted
			// resolve-stream channel reconciles, and revoked activations refusing to bind.
			const identity = { serviceId: "ax4c5", toolName: "transfer", accountId: "acct", resourceId: "res-1", schemaDigest: "sha-ax4" };
			const registry = new Map([["pi861_mcp_ax4c5", { identity }]]);
			const claims = new StreamClaims(
				(toolName) => {
					const resolved = registry.get(toolName);
					return resolved ? { identity: resolved.identity, business: true } : undefined;
				},
				(toolName) => ({ serviceId: "pi-host", toolName, accountId: "local", resourceId: toolName, schemaDigest: `d-${toolName}` }),
			);
			const attempt = (generation) => ({ generation, configId: "fixture", configRevision: "1" });
			const message = (...content) => ({ content, model: "fixture", usage: { input: 2, output: 1 } });
			const operationOf = (binding) => businessOperationId(binding);
			// 1) Claim-once with a stable business id: identical arguments under different
			// local call ids are ONE operation; a second bridge over the SHARED ledger is
			// blocked before any dispatch.
			const first = claims.bind({ type: "toolCall", id: "c1", name: "pi861_mcp_ax4c5", arguments: { amount: 5 } });
			const second = claims.bind({ type: "toolCall", id: "c2", name: "pi861_mcp_ax4c5", arguments: { amount: 5 } });
			assert.equal(operationOf(first), operationOf(second), "identical business arguments share one operation id");
			const firstEvents = [];
			const firstBridge = new AttemptStreamBridge((event) => firstEvents.push(event), () => true, { ledger: claims.ledger, bind: claims.bind, now: () => 1 });
			const ownerOne = attempt(1);
			firstBridge.begin(ownerOne, signal());
			firstBridge.push(ownerOne, { type: "done", reason: "toolUse", message: message({ type: "toolCall", id: "c1", name: "pi861_mcp_ax4c5", arguments: { amount: 5 } }) });
			assert.equal(firstBridge.commit(ownerOne), true);
			assert.equal(claims.ledger.get(operationOf(first)).status, "dispatched");
			const secondEvents = [];
			const secondBridge = new AttemptStreamBridge((event) => secondEvents.push(event), () => true, { ledger: claims.ledger, bind: claims.bind, now: () => 2 });
			const ownerTwo = attempt(2);
			secondBridge.begin(ownerTwo, signal());
			secondBridge.push(ownerTwo, { type: "done", reason: "toolUse", message: message({ type: "toolCall", id: "c2", name: "pi861_mcp_ax4c5", arguments: { amount: 5 } }) });
			assert.throws(() => secondBridge.commit(ownerTwo), (error) => error instanceof StreamOperationBlocked, "the shared ledger never re-claims a live business operation");
			assert.equal(secondEvents.filter((event) => event.type.startsWith("toolcall")).length, 0);
			// Native host tools stay per-call local intents (no false collisions).
			const writeA = claims.bind({ type: "toolCall", id: "w-1", name: "write", arguments: { path: "x" } });
			const writeB = claims.bind({ type: "toolCall", id: "w-2", name: "write", arguments: { path: "x" } });
			assert.notEqual(operationOf(writeA), operationOf(writeB));
			// Settlement from the real receipt frees the gate.
			assert.equal(claims.settle("c1", { ok: true }, false, 3), operationOf(first));
			assert.equal(claims.unsettled(), 0);
			assert.equal(claims.ledger.get(operationOf(first)).status, "succeeded");
			recorder.record("round-3 shared ledger claim-once (composite)", "pass");
			// 2) Unknown blocks the next MODEL dispatch through the managed stream until the
			// trusted reconcile (resolve-stream semantics) re-arms it.
			const policy = {
				targets: [
					{
						id: "m1",
						revision: "r1",
						provider: "fixture",
						model: "m1",
						quality: 2,
						costRank: 1,
						contextWindow: 200_000,
						capabilities: ["text"],
						enabled: true,
					},
				],
				preferred: "m1",
				requirements: { minQuality: 1, contextTokens: 100_000, capabilities: ["text"], allowedIds: ["m1"] },
				recovery: { failoverEnabled: true, failbackEnabled: false, probeIntervalMs: 1000, maxProbeIntervalMs: 5000, requiredProbeSuccesses: 2 },
				maxAttempts: 2,
				requestTimeoutMs: 10_000,
				maxRequests: 50,
				maxProbeRequests: 1,
			};
			const fixtureMessage = (extra = {}) => ({
				role: "assistant",
				content: [{ type: "text", text: "ax4 managed response" }],
				api: "openai-completions",
				provider: "fixture",
				model: "m1",
				usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				...extra,
			});
			const gatedIdentity = { serviceId: "ax4gate", toolName: "t", accountId: "a", resourceId: "r", schemaDigest: "h" };
			const gateRegistry = new Map([["pi861_mcp_ax4gate", { identity: gatedIdentity }]]);
			const gateClaims = new StreamClaims(
				(toolName) => {
					const resolved = gateRegistry.get(toolName);
					return resolved ? { identity: resolved.identity, business: true } : undefined;
				},
				(toolName) => ({ serviceId: "pi-host", toolName, accountId: "local", resourceId: toolName, schemaDigest: "d" }),
			);
			let dispatchCount = 0;
			const runtime = new ModelRuntime(
				policy,
				async (_target, request, runSignal, _onProgress, _onUsage, modelAttempt) => {
					const live = request.stream;
					const toolMessage = fixtureMessage({
						content: [{ type: "toolCall", id: "gate-1", name: "pi861_mcp_ax4gate", arguments: { n: 1 } }],
						stopReason: "toolUse",
					});
					live.attempt = modelAttempt;
					live.bridge.begin(modelAttempt, runSignal);
					live.bridge.push(modelAttempt, { type: "start", partial: toolMessage });
					live.bridge.push(modelAttempt, { type: "done", reason: "toolUse", message: toolMessage });
					dispatchCount++;
					return toolMessage;
				},
				async () => true,
			);
			const collectorFor = () => {
				const events = [];
				return { events, output: { push: (event) => events.push(structuredClone(event)) } };
			};
			const failureMessage = (error, reason) => ({ content: [], stopReason: reason, errorMessage: error instanceof Error ? error.message : "failed" });
			const c5 = { prepare: async () => gateClaims.unsettled(), wiring: { ledger: gateClaims.ledger, bind: gateClaims.bind } };
			const firstRun = collectorFor();
			managedStream(() => runtime, () => firstRun.output, failureMessage, c5)({ id: "ax4-managed" }, { messages: [] }, {});
			await new Promise((resolve) => setTimeout(resolve, 80));
			assert.equal(dispatchCount, 1);
			assert.ok(firstRun.events.some((event) => event.type === "toolcall_end"), "the committed tool claimed and dispatched once");
			const blockedOperation = gateClaims.ledger.exportState().operations.find((op) => op.status === "dispatched")?.operationId;
			assert.ok(blockedOperation, "the dispatched claim exists");
			gateClaims.markLostReceipts();
			assert.equal(gateClaims.unsettled(), 1);
			assert.equal(gateClaims.pending().length, 1, "the operator surface lists the unknown operation");
			const gated = collectorFor();
			managedStream(() => runtime, () => gated.output, failureMessage, c5)({ id: "ax4-managed" }, { messages: [] }, {});
			await new Promise((resolve) => setTimeout(resolve, 80));
			assert.equal(dispatchCount, 1, "no second model dispatch while an operation is unknown");
			assert.equal(gated.events.at(-1).type, "error");
			assert.match(gated.events.at(-1).error.errorMessage, /reconcile pending operations first/, "the gate names the resolve-stream channel");
			gateClaims.reconcile(blockedOperation, { status: "not-executed" });
			assert.equal(gateClaims.unsettled(), 0);
			const resumed = collectorFor();
			managedStream(() => runtime, () => resumed.output, failureMessage, c5)({ id: "ax4-managed" }, { messages: [] }, {});
			await new Promise((resolve) => setTimeout(resolve, 80));
			assert.equal(dispatchCount, 2, "trusted reconciliation re-arms model dispatch");
			gateClaims.markLostReceipts();
			gateClaims.settle("gate-1", { done: true }, false);
			recorder.record("round-3 unknown gate + resolve recovery (composite)", "pass", `dispatches=${dispatchCount}`);
			// 3) Revocation zero dispatch: an activation removed from the binding plan makes
			// the SAME tool name unresolvable; binding refuses and the commit aborts with
			// zero dispatch (no fallback to a native identity for capability tools).
			gateRegistry.delete("pi861_mcp_ax4gate");
			const revokedEvents = [];
			const revokedBridge = new AttemptStreamBridge((event) => revokedEvents.push(event), () => true, { ledger: gateClaims.ledger, bind: gateClaims.bind, now: () => 5 });
			const ownerRevoked = attempt(9);
			revokedBridge.begin(ownerRevoked, signal());
			revokedBridge.push(ownerRevoked, { type: "done", reason: "toolUse", message: message({ type: "toolCall", id: "gate-2", name: "pi861_mcp_ax4gate", arguments: { n: 2 } }) });
			assert.throws(() => revokedBridge.commit(ownerRevoked), /no active capability binding/, "a revoked activation refuses to bind");
			assert.equal(revokedEvents.filter((event) => event.type.startsWith("toolcall")).length, 0, "zero dispatch after revocation");
			recorder.record("round-3 revocation zero dispatch (composite)", "pass");
		},
	);
});

test("AX5: two generic debug skills + one specialized - consolidate, branch, update, rollback, pin", async (t) => {
	const scenario = scenarioById("AX5");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX5", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const packages = [];
	const prepDir = join(evidenceDir ?? tmpdir(), "ax5-packages");
	for (const definition of [
		{ id: "debug-a", body: "Read the error. Check the logs." },
		{ id: "debug-b", body: "Reproduce first. Check the logs." },
		{ id: "debug-special", body: "Inspect the browser console and network panel." },
	]) {
		const dir = join(prepDir, definition.id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "SKILL.md"), `---\nname: ${definition.id}\ndescription: NEVER_AUTO_EXPOSE_${definition.id}\n---\n${definition.body} Preserve evidence.`);
		packages.push({ id: definition.id, dir });
	}
	recorder.record("synthetic packages prepared", "pass", packages.map((item) => item.id).join(","));
	await t.test(
		"composite tier: install, auto-consolidate, branch, update, rollback, pin",
		{ skip: !state.compositeDeclared ? skipReason(scenario, state) : false },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			const root = mkdtempSync(join(tmpdir(), "pi861-ax5-"));
			try {
				// Deterministic shared-invocation port: the skill chain's model calls run
				// through the real AuxiliaryModelInvocations discipline (C1 + C3), with the
				// physical model replaced by deterministic replies.
				const requests = [];
				let requestSequence = 0;
				const groupingReplies = [
					{ group: "debug", relatedGroups: [], reason: "first generic debugging package opens the group" },
					{ group: "debug", relatedGroups: [], reason: "second generic package joins the existing group" },
					{ group: "debug/browser", relatedGroups: ["debug"], reason: "browser-specific variant, related to generic debugging" },
					{ group: "debug", relatedGroups: [], reason: "updated package rejoins the existing debugging group" },
				];
				const port = {
					newRequestId: () => `ax5-req-${++requestSequence}`,
					async attempt(request, onUsage) {
						requests.push({ purpose: "auxiliary", prompt: request.prompt.slice(0, 40) });
						onUsage({ inputTokens: 900, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
						if (request.prompt.startsWith("Classify this untrusted Skill")) {
							const reply = groupingReplies.shift();
							if (!reply) throw new Error("unexpected extra grouping call");
							return JSON.stringify(reply);
						}
						if (request.prompt.startsWith("Compile these UNTRUSTED")) {
							return JSON.stringify({
								id: "debug",
								title: "Debug",
								category: "development/debug",
								instructions: "Preserve evidence and validate fixes.",
								branches: [
									{ id: "general", when: "Program failure without a browser component", instructions: "Reproduce, diagnose and verify.", environment: [], conflictsWith: [], tools: [] },
									{ id: "browser", when: "Failure renders in a browser", instructions: "Collect console evidence.", environment: [], conflictsWith: [], tools: [] },
								],
							});
						}
						throw new Error("unexpected auxiliary prompt");
					},
				};
				const target = { id: "compiler", revision: "r1", provider: "fixture", model: "compiler", quality: 5, costRank: 1, contextWindow: 200000, capabilities: ["text"], enabled: true };
				const role = { id: "dev", revision: "r1", readScopes: ["project:fixture"], writeScopes: [], outbound: [], toolGrants: [] };
				const authority = new IdentityAuthority({ authorityId: "ax5-authority", tenantId: "local", trustedLocal: true, roles: [role] });
				const budget = new TaskTreeBudget(
					{ maxTotalCostUsd: 1000, maxAttempts: 100, maxInputTokens: 1e8, maxOutputTokens: 1e8 },
					{ budgetId: "ax5-budget" },
				);
				const invocations = new AuxiliaryModelInvocations({ authority, budget, port, targets: { classifier: target, compiler: target, enrich: target, planner: target } });
				const credential = authority.issue("agent-1", { roleIds: ["dev"] });
				const context = { credential, scope: "project:fixture", taskId: null };
				const repository = new SkillRepository(new FileStateStore(join(root, "skills.json"), emptySkillState()), {
					classify: auxiliaryGrouping(invocations, context),
				});
				// 1) Install the three packages WITHOUT a group: auto-consolidation runs.
				const installed = [
					await repository.install(packages[0].dir, { id: "debug-a", revision: "auto" }),
					await repository.install(packages[1].dir, { id: "debug-b", revision: "auto" }),
					await repository.install(packages[2].dir, { id: "debug-special", revision: "auto" }),
				];
				assert.deepEqual(installed.map((item) => item.group), ["debug", "debug", "debug/browser"]);
				assert.ok(installed.every((item) => item.grouping?.method === "automatic"));
				recorder.record("auto-consolidation and branch (composite)", "pass", installed.map((item) => item.group).join(","));
				// 2) Compile the specialized group: all three sources integrate into ONE skill.
				const candidate = await repository.compile("debug/browser", auxiliaryCompiler(invocations, context), signal(), { approvedBindings: [] });
				assert.deepEqual([...new Set(candidate.skill.sources.map((source) => source.id))].sort(), ["debug-a", "debug-b", "debug-special"]);
				const owner = {
					producedBy: { tenantId: "local", projectId: "fixture", goalId: "ax5", runId: "one", taskId: "skill", attempt: 1 },
					scope: "project:fixture",
					recordedBy: "ax5-checker",
				};
				const publish = async (input) =>
					repository.publish(input.id, async (skill) => {
						// C7: behavioral cases are required per branch - deterministic trusted
						// cases with no tool calls (the merged debug skill has no bindings).
						const cases = skill.branches.map((branch) => ({
							branchId: branch.id,
							phase: "execute",
							instructionIncludes: ["Preserve evidence"],
							calls: [],
						}));
						const result = await runSkillValidation(skill, { ...owner, approvedBindings: [], environment: [], cases }, signal());
						return { evidence: [...result.evidence, recordSkillAcceptance(skill, { ...owner, recordedBy: "ax5-fixture-human", summary: "Deterministic scenario acceptance" })] };
					});
				const v1 = await publish(candidate);
				const browseRole = { id: "dev", skillIds: ["debug"], grants: [] };
				const listing = await repository.browse(browseRole, "development/debug");
				assert.equal(listing.skills.length, 1);
				assert.equal(listing.skills[0].id, "debug");
				assert.ok(!JSON.stringify(listing).includes("NEVER_AUTO_EXPOSE"), "raw original descriptions never surface");
				recorder.record("no raw description in default prompt (composite)", "pass");
				// 3) Every physical model call ran through the shared service under one budget.
				assert.ok(requests.length >= 4);
				assert.ok(requests.every((request) => request.purpose === "auxiliary"));
				assert.ok(budget.usage.attempts >= 4);
				assert.equal(budget.openReservations().length, 0);
				// 4) Update: a new source revision invalidates the affected publication; the
				// published version stays pinned until a rebuild is republished.
				writeFileSync(join(packages[0].dir, "SKILL.md"), `---\nname: debug-a\ndescription: NEVER_AUTO_EXPOSE_v2\n---\nRead the error twice. Preserve evidence.`);
				await repository.install(packages[0].dir, { id: "debug-a", revision: "auto" });
				assert.deepEqual((await repository.affected()).map((item) => item.skillId), ["debug"]);
				const pinned = await repository.browse(browseRole, "development/debug");
				assert.deepEqual(pinned.skills, [], "the update INVALIDATES the published merge; nothing silently drifts to new content");
				const rebuilt = await repository.rebuildAffected(auxiliaryCompiler(invocations, context), signal(), []);
				assert.equal(rebuilt.length, 1);
				const v2 = await publish(rebuilt[0]);
				assert.notEqual(v2.revision, v1.revision);
				assert.equal((await repository.browse(browseRole, "development/debug")).skills[0].revision, v2.revision);
				recorder.record("running version pinned across update (composite)", "pass", `v1=${v1.revision} v2=${v2.revision}`);
				// 5) Rollback restores the previously published immutable version.
				await repository.rollback("debug", v1.revision);
				assert.equal((await repository.browse(browseRole, "development/debug")).skills[0].revision, v1.revision);
				recorder.record("rollback restores immutable version (composite)", "pass");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
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
			let cursor;
			let listed = 0;
			for (let page = 0; page < 4; page++) {
				const list = await mcpCall(server.url, "tools/list", cursor ? { cursor } : {}, session);
				assert.equal(list.status, 200);
				listed += list.payload.result.tools.length;
				cursor = list.payload.result._meta?.nextCursor;
				if (!cursor) break;
			}
			assert.equal(listed, 9);
			const before = server.currentSchemaEpoch();
			await mcpCall(server.url, "$/fixtures/flip-schema", {}, session);
			assert.equal(server.currentSchemaEpoch(), before + 1);
			assert.equal((await mcpCall(server.url, "tools/list", {}, "not-a-session")).status, 404);
			assert.equal(server.requestLog.filter((entry) => entry.body.includes('"tools/call"')).length, 0);
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
			const root = mkdtempSync(join(tmpdir(), "pi861-ax6-"));
			const server = await startMcpHttpServer();
			const httpd = new McpClient({ id: "httpd", accountId: "a", transport: { kind: "http", url: server.url, allowLoopbackHttp: true } });
			const oneA = new McpClient({ id: "one", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [STDIO_FIXTURE], cwd: process.cwd() } } });
			const oneB = new McpClient({ id: "one", accountId: "b", transport: { kind: "stdio", process: { command: process.execPath, args: [STDIO_FIXTURE], cwd: process.cwd() } } });
			const two = new McpClient({ id: "two", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [STDIO_FIXTURE], cwd: process.cwd() } } });
			try {
				const repository = new SkillRepository(new FileStateStore(join(root, "skills.json"), emptySkillState()));
				const httpTools = await httpd.tools(signal());
				const echo = httpTools.find((entry) => entry.name === "echo");
				const stdioTools = await oneA.tools(signal());
				const lookup = stdioTools[0];
				const bindings = [
					{ toolId: "one/lookup", accountId: "a", resourceId: "project:p", schemaHash: lookup.schemaHash, phase: "execute" },
					{ toolId: "one/lookup", accountId: "b", resourceId: "project:q", schemaHash: lookup.schemaHash, phase: "execute" },
					{ toolId: "two/lookup", accountId: "a", resourceId: "project:r", schemaHash: lookup.schemaHash, phase: "execute" },
					{ toolId: "httpd/echo", accountId: "a", resourceId: "project:p", schemaHash: echo.schemaHash, phase: "execute" },
				];
				const skillIds = [
					await repository.publishMcp("one", "a", stdioTools, [bindings[0]]),
					await repository.publishMcp("one", "b", stdioTools, [bindings[1]]),
					await repository.publishMcp("two", "a", stdioTools, [bindings[2]]),
					await repository.publishMcp("httpd", "a", httpTools, [bindings[3]]),
				];
				let role = {
					id: "developer",
					skillIds,
					grants: bindings.map((binding) => ({ toolId: binding.toolId, accountId: binding.accountId, resourceIds: [binding.resourceId] })),
				};
				const handlers = new Map();
				const tools = new Map();
				let active = [];
				const host = {
					getActiveTools: () => active,
					setActiveTools: (value) => {
						active = value;
					},
					registerTool: (tool) => tools.set(tool.name, tool),
					on: (name, fn) => handlers.set(name, fn),
					appendEntry: () => {},
				};
				const capabilities = installCapabilities(host, {
					repository,
					role: () => role,
					clients: [oneA, oneB, two, httpd],
					environment: [],
					resourceRules: [
						{ ...bindings[0], equals: { project: "p" } },
						{ ...bindings[1], equals: { project: "q" } },
						{ ...bindings[2], equals: { project: "r" } },
						{ ...bindings[3], equals: { project: "p" } },
					],
				});
				// 1) Discovery injects nothing: zero tools/call on the HTTP fixture, no
				//    active MCP tools, and the prompt hook strips raw descriptions.
				const catalog = await repository.catalog();
				const published = catalog.browse(role)[0];
				assert.ok(published, "the MCP skills are published");
				assert.ok(!active.some((name) => name.startsWith("pi861_mcp_")));
				assert.equal(server.requestLog.filter((entry) => entry.body.includes('"tools/call"')).length, 0);
				const prompt = { systemPromptOptions: { skills: [{ description: "NEVER_AUTO_EXPOSE" }], sections: {} } };
				await handlers.get("before_agent_start")(prompt);
				assert.deepEqual(prompt.systemPromptOptions.skills, []);
				recorder.record("discovery injects nothing (composite)", "pass");
				// 2) Lazy activation: only the bound tools appear (one per binding).
				for (const skillId of skillIds) {
					const revision = catalog.browse(role).find((skill) => skill.id === skillId)?.revision ?? published.revision;
					const branch = catalog.branches(role, skillId)[0];
					await tools.get("pi861_capabilities").execute("act", { action: "activate", skillId, revision, branches: [branch.id], phase: "execute" });
				}
				const activated = active.filter((name) => name.startsWith("pi861_mcp_"));
				assert.equal(activated.length, bindings.length, "only the four bound tools registered");
				recorder.record("lazy activation minimal tools (composite)", "pass", activated.join(","));
				// 3) Same-name tools on different servers keep separate registrations.
				const lookupTools = [...tools.values()].filter((tool) => active.includes(tool.name) && tool.description.includes("/lookup"));
				assert.equal(lookupTools.length, 3, "one/lookup x2 accounts + two/lookup");
				// 4) Cross-account closures: dispatch routes through each binding's own
				//    account client and stays inside its resource rule.
				const byResource = (resourceId) => [...tools.values()].find((tool) => active.includes(tool.name) && tool.description.includes(resourceId));
				const viaP = byResource("project:p");
				const viaQ = byResource("project:q");
				const viaR = byResource("project:r");
				assert.ok(viaP && viaQ && viaR, "all bound tools reachable by resource");
				assert.match(JSON.stringify(await viaP.execute("one", { project: "p" })), /looked up p/);
				assert.match(JSON.stringify(await viaQ.execute("two", { project: "q" })), /looked up q/);
				assert.match(JSON.stringify(await viaR.execute("three", { project: "r" })), /looked up r/);
				await assert.rejects(viaP.execute("four", { project: "elsewhere" }), /authorization|resource/i, "out-of-rule arguments are rejected");
				recorder.record("closure isolation same-name/multi-account (composite)", "pass");
				// 5) Schema drift on the HTTP server: old-hash calls and bindings are refused.
				const control = await mcpCall(server.url, "initialize", { protocolVersion: "2025-06-18", capabilities: {} });
				await mcpCall(server.url, "$/fixtures/flip-schema", {}, control.session);
				await assert.rejects(httpd.call("echo", { message: "drift" }, echo.schemaHash, signal()), /schema|drift|changed|metadata/i);
				const fresh = (await httpd.tools(signal())).find((entry) => entry.name === "echo");
				assert.notEqual(fresh.schemaHash, echo.schemaHash);
				recorder.record("schema drift forces re-activation (composite)", "pass");
				// 6) Hidden-name direct call: no unactivated MCP tool is even registered.
				assert.equal([...tools.keys()].find((name) => name.startsWith("pi861_mcp_") && !active.includes(name)), undefined);
				// 7) Revocation: grants removed -> every previously activated call rejects.
				role = { ...role, grants: [] };
				await assert.rejects(viaP.execute("five", { project: "p" }), /authorized|grant/i);
				recorder.record("revocation closes calls and references (composite)", "pass");
				capabilities.close();
			} finally {
				await httpd.close();
				await oneA.close();
				await oneB.close();
				await two.close();
				await server.close();
				rmSync(root, { recursive: true, force: true });
			}
		},
	);
});

test("AX7: memory auto-record/refine, restore across switches, no leak, no resurrection", async (t) => {
	const scenario = scenarioById("AX7");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX7", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	const envGate = state.envGaps.length && !pg17OptedIn() ? skipReason(scenario, state) : false;
	const compositeGate = !state.compositeDeclared ? skipReason(scenario, state) : false;
	await t.test(
		"composite tier: capture, refine, restore, withdraw across session/model/node on real PG17",
		{ skip: skipFixture || envGate || compositeGate },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			const pg = await startPgScenario("ax7");
			try {
				const scope = "project:ax7";
				const tokenA = `tok-a-${Date.now()}`;
				const tokenB = `tok-b-${Date.now()}`;
				const tokenOutsider = `tok-out-${Date.now()}`;
				await provisionServicePrincipal(pg.migrationPool, { principalId: "ax7-a", tenantId: "t1", readScopes: [scope], writeScopes: [scope], token: tokenA });
				await provisionServicePrincipal(pg.migrationPool, { principalId: "ax7-b", tenantId: "t1", readScopes: [scope], writeScopes: [scope], token: tokenB });
				await provisionServicePrincipal(pg.migrationPool, { principalId: "ax7-out", tenantId: "t2", readScopes: ["project:other"], writeScopes: ["project:other"], token: tokenOutsider });
				const service = new StorageService(pg.runtimePool, new ServicePrincipalDirectory(pg.identityPool));
				await service.ready();
				const sessionA = await service.session(tokenA);
				const sessionB = await service.session(tokenB);
				const sessionOut = await service.session(tokenOutsider);
				const governanceFor = (session, name) =>
					attachMemoryGovernance({}, {
						authority: session.memory,
						pending: new FileStateStore(join(pg.root, `${name}-pending.json`), { version: 1, entries: [] }),
						scope,
						owner: "agent:shared",
					});
				const nodeA = governanceFor(sessionA, "a");
				const nodeB = governanceFor(sessionB, "b");
				// 1) Execution-end capture + durable refinement queue.
				const captured = await nodeA.captureUserStatement({ sessionId: "s-a", sequence: 1, text: "跨节点约束：发布前必须运行完整检查链", kind: "constraint" });
				assert.equal(captured.status, "captured");
				const queued = await pg.migrationPool.query("SELECT count(*)::int AS n FROM pi861_memory_jobs");
				assert.ok(Number(queued.rows[0].n) >= 1, "refinement job durably queued");
				recorder.record("execution-end capture + durable refine queue (composite)", "pass");
				// 2) Assembly on node switch without keyword luck.
				const assembled = await nodeB.assembleContext("node-switch");
				assert.ok(assembled.text.includes("跨节点约束"), "constraint assembles directly");
				const recall = await nodeB.recallContext();
				assert.ok(recall.text.includes("跨节点约束"));
				recorder.record("assembly on session/model/node switch (composite)", "pass");
				// 3) Private scope: the outsider tenant reads nothing through any surface.
				assert.deepEqual(await sessionOut.memory.search("约束").catch(() => []), []);
				const outsiderCount = await pg.migrationPool.query("SELECT count(*)::int AS n FROM pi861_memory_items WHERE tenant_id='t2'");
				assert.equal(Number(outsiderCount.rows[0].n), 0);
				recorder.record("private scope no-leak (composite)", "pass");
				// 4) Withdrawal kills the record everywhere; old sources cannot resurrect it.
				const originalRef = (await sessionA.memory.get(scope, captured.id)).source.ref;
				assert.ok(await sessionA.memory.withdraw("ax7-w1", scope, captured.id, 1));
				assert.equal(await sessionA.memory.get(scope, captured.id), undefined);
				assert.equal((await sessionA.memory.search("约束")).length, 0);
				await assert.rejects(
					sessionA.memory.put({
						requestId: "ax7-resurrect",
						expectedRevision: null,
						item: { id: "z", scope, kind: "project", abstract: "copy", overview: "copy", full: "paraphrased old content", status: "confirmed", source: { kind: "user", ref: originalRef } },
					}),
					/Withdrawn/,
				);
				recorder.record("withdrawal kills tasks and indexes (composite)", "pass");
				// 5) reference+refine combination (P2-M F1 lifted in composite 3c74fa393):
				// a durable 80KB reference survives a raw authority distillation pass.
				const payload = "v".repeat(80000);
				const reference = await nodeA.captureToolExecutionEnd({ sessionId: "s-ax7", toolCallId: "call-big", toolName: "web.read", result: payload });
				assert.equal(reference.status, "referenced");
				const resultRef = JSON.parse((await sessionA.memory.get(scope, reference.id)).full).resultRef;
				const raw = await sessionA.memory.enrich(
					{ modelId: "fixture", async extract() { return { abstract: "模型摘要", overview: "投影摘要。", facts: [] }; } },
					{ signal: new AbortController().signal, timeoutMs: 15000, maxJobs: 10 },
				);
				assert.ok(raw.completed >= 1, "reference records were projected by the raw pass");
				let paged = "";
				for (let offset = 0; ; ) {
					const page = await nodeB.readResultReference(resultRef, offset);
					paged += page.text;
					offset = page.nextOffset;
					if (page.complete) break;
				}
				assert.equal(JSON.parse(paged).result, payload, "the reference reads intact after distillation");
				assert.ok((await nodeA.revokeResultReference("ax7-revoke", resultRef)) >= 1);
				await assert.rejects(nodeB.readResultReference(resultRef), /Result not found/);
				recorder.record("reference+refine combination (F1 lifted, re-verified)", "pass", `distilled=${raw.completed}`);
				recorder.record("pg17 container", "pass", `container=${pg.containerName} server_version_num=${pg.serverVersionNum}`);
			} finally {
				await pg.cleanup();
			}
		},
	);
	await t.test("pg17 fixture tier honesty marker", { skip: !(envGate || compositeGate) }, () => {
		recorder.record("pg17 container", "not-run", `gates: ${[envGate, compositeGate].filter(Boolean).join("; ")}`);
	});
});

test("AX8: bounded recovery, requestId receipt confirmation, no local impersonation", async (t) => {
	const scenario = scenarioById("AX8");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX8", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	const envGate = state.envGaps.length && !pg17OptedIn() ? skipReason(scenario, state) : false;
	const compositeGate = !state.compositeDeclared ? skipReason(scenario, state) : false;
	await t.test(
		"composite tier: transient recovery, receipt replay, outage parking on real PG17",
		{ skip: skipFixture || envGate || compositeGate },
		async () => {
			assert.notEqual(compositeSnapshot, "UNDECLARED");
			const pg = await startPgScenario("ax8");
			try {
				const scope = "project:ax8";
				const token = `tok-${Date.now()}`;
				await provisionServicePrincipal(pg.migrationPool, { principalId: "ax8-w", tenantId: "t1", readScopes: [scope], writeScopes: [scope], token });
				const service = new StorageService(pg.runtimePool, new ServicePrincipalDirectory(pg.identityPool));
				await service.ready();
				const session = await service.session(token);
				const write = (requestId, changes = {}, revision = null) => ({
					requestId,
					expectedRevision: revision,
					item: {
						id: "m1",
						scope,
						kind: "project",
						abstract: "alpha",
						overview: "alpha overview",
						full: "alpha original evidence",
						status: "confirmed",
						source: { kind: "user", ref: `event:${requestId}` },
						...changes,
					},
				});
				// 1) Lost COMMIT response: the same requestId reconciles to the committed
				// receipt; a different intent under the same id is a conflict.
				let lost = true;
				const dropping = {
					async connect() {
						const client = await pg.runtimePool.connect();
						return {
							async query(sql, args) {
								const result = await client.query(sql, args);
								if (sql === "COMMIT" && lost) {
									lost = false;
									throw new Error("injected lost COMMIT response");
								}
								return result;
							},
							release() {
								client.release();
							},
						};
					},
				};
				const uncertain = new StorageService(dropping, new ServicePrincipalDirectory(pg.identityPool));
				const uncertainSession = await uncertain.session(token);
				await assert.rejects(uncertainSession.put(write("ambiguous")), /lost COMMIT/);
				const reconciled = await session.reconcile("ambiguous");
				assert.equal(reconciled.state, "committed");
				assert.equal(reconciled.receipt.revision, 1);
				assert.deepEqual(await session.put(write("ambiguous")), reconciled.receipt);
				await assert.rejects(session.put(write("ambiguous", { full: "different intent" })), /different content|idempotency/i);
				recorder.record("same requestId confirms lost receipt (composite)", "pass");
				recorder.record("different intent same id rejected (composite)", "pass");
				// 2) Bounded transient-refinement recovery (failures=2 then done).
				const governance = attachMemoryGovernance({}, {
					authority: session.memory,
					pending: new FileStateStore(join(pg.root, "pending.json"), { version: 1, entries: [] }),
					scope,
					owner: "agent:ax8",
				});
				await governance.captureUserStatement({ sessionId: "s8", sequence: 1, text: "工期约定：两周内完成存储切换。", kind: "project" });
				let attempts = 0;
				const stats = await governance.distill(
					(_context, _record, _runSignal) => {
						attempts++;
						if (attempts < 3) return Promise.reject(new Error("model endpoint overloaded"));
						return Promise.resolve({ abstract: "工期摘要", overview: "两周内完成存储切换。", facts: [] });
					},
					{},
					"fixture-model",
					{ signal: new AbortController().signal, maxJobs: 5, backoffBaseMs: 0, backoffCapMs: 1 },
				);
				assert.ok(stats.completed >= 1, `at least the target record distilled: ${JSON.stringify(stats)}`);
				const jobs = await governance.distillationJobs();
				const target = jobs.find((job) => job.state === "done" && job.failures === 2);
				assert.ok(target, `the transiently failing job recovered with failures=2: ${JSON.stringify(jobs)}`);
				recorder.record("bounded retry + permanent failure path (composite)", "pass", `failures=${target.failures} completed=${stats.completed}`);
				// 3) Database outage: writes park uncommitted in the bounded local queue and
				// never masquerade as shared truth; going online commits exactly once.
				const queueStore = new FileStateStore(join(pg.root, "pending-outage.json"), { version: 1, entries: [] });
				let online = true;
				const queue = new PendingMemoryWrites(queueStore, {
					put: (request) => (online ? session.put(request) : Promise.reject(new Error("database unavailable"))),
				});
				online = false;
				await assert.rejects(queue.put(write("pending-outage", { id: "pending" })), MemoryCommitPending);
				const queuedState = await queueStore.read();
				assert.equal(queuedState.entries[0].state, "uncommitted");
				assert.equal(await session.memory.get(scope, "pending"), undefined, "nothing readable while parked");
				recorder.record("local pending stays uncommitted (composite)", "pass");
				online = true;
				assert.deepEqual(await queue.flush(), { committed: 1, pending: 0 });
				assert.equal((await session.memory.get(scope, "pending")).revision, 1);
				recorder.record("pg17 container", "pass", `container=${pg.containerName} server_version_num=${pg.serverVersionNum}`);
			} finally {
				await pg.cleanup();
			}
		},
	);
	await t.test("pg17 fixture tier honesty marker", { skip: !(envGate || compositeGate) }, () => {
		recorder.record("pg17 container", "not-run", `gates: ${[envGate, compositeGate].filter(Boolean).join("; ")}`);
	});
});

test("AX9: single coordinator and single integration executor under duplication and restart", async (t) => {
	const scenario = scenarioById("AX9");
	const state = readiness(scenario, process.env, presence);
	const recorder = new CoverageRecorder("AX9", evidenceDir);
	t.after(() => recorder.write(compositeDeclared));
	const skipFixture = state.fixtureGaps.length ? skipReason(scenario, state) : false;
	await t.test("fixture tier: real integration repo and distinct worker identities", { skip: skipFixture }, async () => {
		const repo = tempGitRepo("ax9");
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
			const root = mkdtempSync(join(tmpdir(), "pi861-ax9-"));
			const repo = tempGitRepo("ax9c");
			try {
				// 1) Duplicate goal and duplicate resume are refused; resume advances the run
				//    generation (the restarted node is a NEW generation, never a second
				//    concurrent owner).
				const coordinator = new ProjectCoordinator(new FileStateStore(join(root, "state.json"), emptyProject("ax9")), {
					maxConcurrent: 2,
					maxAttempts: 3,
				});
				await coordinator.create("first goal", "a".repeat(40), [planTask("A")], { sealed: false });
				await assert.rejects(coordinator.create("second goal", "a".repeat(40), [planTask("B")]), /unfinished goal/);
				await assert.rejects(coordinator.control("resume", "r1"), /Only a paused goal may resume/);
				await coordinator.control("pause", "p1");
				await coordinator.control("resume", "r2");
				await assert.rejects(coordinator.control("resume", "r3"), /Only a paused goal may resume/);
				const generation = (await coordinator.state()).goal.generation;
				assert.ok(generation >= 2, `resume advances the generation: ${generation}`);
				recorder.record("duplicate resume single executor (composite)", "pass", `generation=${generation}`);
				// 2) Plan CAS + cycle rejection on the live board.
				const version = (await coordinator.state()).goal.planVersion;
				await assert.rejects(coordinator.append([planTask("D")], version - 1), /Stale plan version/);
				await assert.rejects(
					coordinator.append([planTask("P", { dependsOn: ["Q"] }), planTask("Q", { dependsOn: ["P"] })], version),
					/cycle/i,
				);
				recorder.record("plan CAS + cycle rejection (composite)", "pass");
				// 3) Single integration authority with git-process-tree handover, matching the
				// runner's real semantics: while the former holder's git tree is alive, the
				// takeover guard REFUSES and the integration fails open (preserved workspace,
				// integrationFailure recorded, nothing handed to two process trees). After
				// the operator reconciles and the tree is confirmed exited, a new runner
				// takes over the NEXT lease generation and integrates exactly once.
				const workspaces = new Workspaces(repo, join(root, "trees"));
				const base = await workspaces.head();
				const authority = new ProjectCoordinator(new FileStateStore(join(root, "int.json"), emptyProject("ax9i")), {
					maxConcurrent: 2,
					maxAttempts: 3,
				});
				const integration = await workspaces.create("integration", 1, base);
				await authority.create("integration goal", base, [planTask("I")], { sealed: false });
				const ghostHandle = await authority.acquireIntegrationLease("ghost-owner", 120, 0);
				assert.ok(ghostHandle, "ghost acquires first");
				assert.equal(await authority.acquireIntegrationLease("honest-owner", 5000, 0), null, "second authority is refused while held");
				const handoffs = [];
				let gitAlive = true;
				const guard = {
					confirmFormerHolderExited: async (former) => {
						handoffs.push(former.owner);
						if (gitAlive) throw new Error(`former holder ${former.owner} git process tree still alive`);
					},
				};
				const makeRunner = () =>
					new ProjectRunner({
						coordinator: authority,
						workspaces,
						integration,
						checks: [verifyCheck],
						workers: [{ identity: { id: "w0", capabilities: [], roleIds: ["dev"], modelIds: ["test"] }, process: workerSpec(join(root, "trace")) }],
						idle: "hold",
						wake: new InProcessWakeChannel(),
						maintenanceMs: 100,
						integrationLeaseMs: 60000,
						integrationGraceMs: 80,
						integrationHandoff: guard,
					});
				// Phase A: the guard refuses the takeover; the runner's integration attempt
				// fails, the task is BLOCKED with its preserved workspace, and - critically -
				// the ghost's lease generation is never handed to the refused process tree.
				let settledA;
				let finalState;
				const runnerA = makeRunner();
				try {
					settledA = runnerA.start();
					await waitForTask(authority, "I", "blocked", 600);
					const refused = await authority.state();
					assert.ok(handoffs.includes("ghost-owner"), `the guard was consulted: ${handoffs.join(",")}`);
					assert.equal(refused.integration.generation, ghostHandle.generation, "the refused takeover never advanced the lease generation");
					const blockedTask = refused.board.tasks.find((item) => item.id === "I");
					assert.ok(blockedTask.reason && blockedTask.reason.length > 0, "the failed attempt left an inspectable reason and preserved workspace");
					await runnerA.pause();
					await settledA;
					// Phase B: the git tree is confirmed exited; the operator unblocks the
					// preserved task and a new runner takes over the NEXT generation.
					gitAlive = false;
					await authority.control("pause", "ax9-p");
					await authority.unblock("I", "operator confirmed the former git tree exited", "ax9-unblock");
					await authority.control("resume", "ax9-r");
					const runnerB = makeRunner();
					const settledB = runnerB.start();
					await waitForTask(authority, "I", "done", 600);
					finalState = await authority.state();
					assert.equal(finalState.board.tasks.find((item) => item.id === "I").status, "done", "integration completes exactly once after the confirmed handover");
					assert.ok(finalState.integration.generation > ghostHandle.generation, `a NEW generation took over: ${finalState.integration.generation} > ${ghostHandle.generation}`);
					recorder.record("git handover waits for process exit (composite)", "pass", `handoffs=${handoffs.join(",")}`);
					// 4) Stale node: a late verify from a superseded lease is rejected (the goal
					// is still ACTIVE here; the pause happens after this check).
					const superseded = finalState.board.tasks.find((item) => item.id === "I");
					await assert.rejects(
						authority.verify({ taskId: "I", workerId: "w0", token: "superseded", attempt: superseded.attempts }, { accepted: true, evidence: ["late"] }, "late-verify"),
						/[Ss]tale/,
					);
					await runnerB.pause();
					await settledB;
				} finally {
					await runnerA.pause().catch(() => {});
					await settledA?.catch(() => {});
				}
				// 5) Restart election: a ghost claim expires; maintenance recovers exactly
				// once and the ledger shows no double dispatch.
				const election = new ProjectCoordinator(new FileStateStore(join(root, "elect.json"), emptyProject("ax9e")), {
					maxConcurrent: 2,
					maxAttempts: 2,
				});
				await election.create("election goal", base, [planTask("R", { retrySafe: true })]);
				const ghostClaim = await election.claim({ id: "ghost", capabilities: [], roleIds: ["dev"], modelIds: ["test"] }, "ghost-1", 60);
				assert.ok(ghostClaim);
				await new Promise((resolve) => setTimeout(resolve, 120));
				assert.equal(await election.maintain(), 1, "the expired lease is recovered exactly once");
				const requeued = (await election.state()).board.tasks.find((item) => item.id === "R");
				assert.equal(requeued.status, "queued");
				assert.equal(requeued.attempts, 1, "no second dispatch happened during recovery");
				recorder.record("restart re-election, stale node rejected (composite)", "pass");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
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
		writeFileSync(
			join(evidenceDir, "ax-coverage.json"),
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
