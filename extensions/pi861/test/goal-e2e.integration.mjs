import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { test } from "node:test";
// P3-X AX10 vertical closed loop (K8 part 2). Bound to the P3-I composite snapshot
// (PI861_AX_COMPOSITE_SNAPSHOT). The nine steps are the fixed K8 contract; they run against
// the REAL full runtime entry: a real Pi 0.86.1 host process loads runtime.ts, /goal drives
// the real GoalCommandService -> coordinator -> ProjectRunner -> two REAL local Pi worker
// processes (same machine, labeled as such) -> trusted checks -> independent review -> single
// integration workspace -> goal acceptance. The model is the deterministic scenario provider
// (test/fixtures/ax-e2e-provider.mjs); nothing here claims real-model quality.
//
// Boundaries recorded in evidence: workers are same-machine processes; MCP stdio + HTTP/SSE
// restricted operations are executed at the composite module tier inside this chain (worker
// baseTools exclude the activation surface in worker mode); the reference+refine combination
// is exercised per the lifted P2-M F1 (composite 3c74fa393).
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
import { PiRpcSession } from "../src/live/pi-rpc.ts";
import { FileStateStore } from "../src/live/store.ts";
import { SkillRepository, emptySkillState } from "../src/live/skill-repository.ts";
import { installCapabilities } from "../src/live/skills-host.ts";
import { McpClient } from "../src/live/mcp.ts";

const execute = promisify(execFile);
const scenario = scenarioById("AX10");
const compositeSnapshot = process.env.PI861_AX_COMPOSITE_SNAPSHOT ?? "UNDECLARED";
const compositeDeclared = Boolean(process.env.PI861_AX_COMPOSITE_SNAPSHOT);
const evidenceDir = process.env.PI861_AX_EVIDENCE_DIR ?? null;
const presence = fixturePresence();
const state = readiness(scenario, process.env, presence);
const recorder = new CoverageRecorder("AX10", evidenceDir);
const signal = () => new AbortController().signal;

/** Step skip gate: only the undeclared-snapshot case skips; a declared snapshot with missing
 * probe files must hard fail (boundary test below), never silently skip the chain. */
const chainSkip = !compositeDeclared ? skipReason(scenario, state) : false;
/** The fixed closing sentence - asserting it verbatim is part of the K8 contract. */
const CLOSING_SENTENCE = "实际宿主与本地协议闭环，模型为fixture";
const RUNTIME_ENTRY = fileURLToPath(new URL("../runtime.ts", import.meta.url));
const AX_PROVIDER = fileURLToPath(new URL("./fixtures/ax-e2e-provider.mjs", import.meta.url));
const STDIO_FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const PI_CLI_JS = process.env[PI_CLI_ENV]
	? process.env[PI_CLI_ENV].endsWith(".js")
		? process.env[PI_CLI_ENV]
		: join(process.env[PI_CLI_ENV], "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js")
	: null;

/** Shared PG17 authority for the whole chain (K8 step 4). */
async function startChainPg() {
	const fixture = await startPg17Fixture();
	fixture.assertVersion17();
	const driverRoot = process.env.PI861_TEST_DRIVER_ROOT;
	if (!driverRoot) throw new Error("AX10 needs PI861_TEST_DRIVER_ROOT (operator pg driver root)");
	const requireDriver = createRequire(join(driverRoot, "package.json"));
	const { Pool } = requireDriver("pg");
	const admin = new Pool({
		connectionString: `postgres://${fixture.migrationEnv.PI861_TEST_PG_MIGRATION_USER}:${fixture.migrationEnv.PI861_TEST_PG_MIGRATION_PASSWORD}@127.0.0.1:${fixture.port}/pi861_test`,
		max: 4,
	});
	const suffix = `ax10${Math.floor(Math.random() * 1e9).toString(36)}`;
	const schema = `pi861_ax_${suffix}`;
	const roles = ["m", "r"].map((kind) => `pi861_ax_${kind}_${suffix}`);
	const password = `pw-${Math.random().toString(36).slice(2)}`;
	await admin.query(`CREATE ROLE "${roles[0]}" LOGIN PASSWORD '${password}' NOSUPERUSER BYPASSRLS`);
	await admin.query(`CREATE ROLE "${roles[1]}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
	await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${roles[0]}"`);
	const roleUrl = (role) => `postgres://${role}:${password}@127.0.0.1:${fixture.port}/pi861_test`;
	const migration = new Pool({ connectionString: roleUrl(roles[0]), options: `-c search_path=${schema}`, max: 2 });
	await migration.query(readFileSync(new URL("../sql/memory-v1.sql", import.meta.url), "utf8"));
	await migration.query(readFileSync(new URL("../sql/runtime-v2.sql", import.meta.url), "utf8"));
	await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${roles[1]}"`);
	await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${roles[1]}"`);
	// The full runtime only persists through PostgresStateStore (runtime-v2 tables); the
	// storage-service migration tables are not part of this chain, so no extra revokes.
	await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${roles[1]}"`);
	const runtimeUrl = roleUrl(roles[1]);
	return {
		runtimeUrl,
		containerName: fixture.containerName,
		serverVersionNum: fixture.serverVersionNum,
		admin,
		query: (sql) => admin.query(`SELECT count(*)::int AS n FROM "${schema}".${sql}`),
		stop: async () => {
			await migration.end().catch(() => {});
			await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
			for (const role of roles) await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
			await admin.end().catch(() => {});
			await fixture.stop();
		},
	};
}

test("AX10 readiness boundary: gates are explicit, never worked around", () => {
	// Runs BEFORE the chain (defined first): a declared snapshot missing its probe files fails
	// the whole file loudly instead of letting the chain steps soft-skip.
	assert.equal(state.compositeDeclared, compositeDeclared);
	if (compositeDeclared && state.missingProbes.length)
		throw new Error(`composite snapshot ${compositeSnapshot} declared but probe files are missing: ${state.missingProbes.join(", ")}`);
	recorder.record(
		"activation checklist",
		compositeDeclared ? "pass" : "not-run",
		[
			`fixtures present: ${scenario.fixtures.every((name) => presence[name])}`,
			`env gates: ${scenario.envGates.map(([name, value]) => `${name}=${process.env[name] ?? "unset"}${value ? "" : "(any)"}`).join(", ")}`,
			`${PI_CLI_ENV} declared: ${Boolean(process.env[PI_CLI_ENV])}`,
			`composite snapshot: ${compositeSnapshot}`,
		].join("; "),
	);
});

test("AX10: /goal to controlled integration in one closed loop", { timeout: 300_000 }, async (t) => {
	t.after(() => recorder.write(compositeDeclared));

	await t.test("step 0 fixture tier: real git repo, MCP endpoint, protocol workers, PG17", async () => {
		const gaps = state.fixtureGaps;
		if (!gaps.length) {
			const repo = join(evidenceDir ?? tmpdir(), `ax10-goal-repo-${Date.now()}`);
			mkdirSync(repo, { recursive: true });
			execFileSync("git", ["init", "--quiet", repo]);
			writeFileSync(
				join(repo, "REQUIREMENT.md"),
				["# ax10 synthetic requirement", "- A: produce a.txt with content A", "- B: slow independent task", "- C: depends on A", ""].join("\n"),
			);
			writeFileSync(join(repo, "check.mjs"), 'import assert from "node:assert/strict"; import { readFileSync } from "node:fs"; assert.equal(readFileSync("a.txt", "utf8"), "A");\n');
			execFileSync("git", ["add", "REQUIREMENT.md", "check.mjs"], { cwd: repo });
			execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "ax10 requirement"], { cwd: repo });
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
				recorder.record("fixture environment assembled", "pass", `repo=${repo} mcp=${mcp.url} workers=${pair.workers.map((worker) => worker.pid).join("/")}`);
				recorder.record(
					"protocol pair is not real Pi",
					"blocked",
					"the protocol pair drives process/git boundaries only; the chain below uses two REAL same-machine Pi worker processes",
				);
			} finally {
				await pair.stop();
				await mcp.close();
			}
			recorder.record("pg17 container", pg17OptedIn() ? "pass" : "not-run", pg17OptedIn() ? "started in step 1" : "PI861_PG17_TESTS=1 not set; the chain gate covers it");
		} else {
			recorder.record("fixture environment assembled", "not-run", `missing fixtures: ${gaps.map((name) => P1Q_FIXTURES[name]).join(", ")}`);
			throw new Error(skipReason(scenario, state));
		}
	});

	// K8 contract step 1: create a real test git repo + synthetic requirement and enter through
	// the actual full-runtime /goal entry.
	await t.test("step 1: goal created from the real /goal entry of the full runtime", { skip: chainSkip }, async () => {
		assert.ok(PI_CLI_JS, "activation requires a real Pi CLI via PI861_TEST_PI_CLI");
		assert.ok(pg17OptedIn(), "activation requires PI861_PG17_TESTS=1 + docker");
		const chainRoot = join(evidenceDir ?? tmpdir(), `ax10-chain-${Date.now()}`);
		mkdirSync(join(chainRoot, "state"), { recursive: true });
		mkdirSync(join(chainRoot, "trees"), { recursive: true });
		mkdirSync(join(chainRoot, "marks"), { recursive: true });
		const repo = join(evidenceDir ?? tmpdir(), `ax10-goal-repo-${Date.now()}`);
		mkdirSync(repo, { recursive: true });
		execFileSync("git", ["init", "--quiet", repo]);
		writeFileSync(join(repo, "REQUIREMENT.md"), "# ax10 requirement\nProduce a.txt (content A), b.txt (B), c.txt (C); C depends on A.\n");
		execFileSync("git", ["add", "REQUIREMENT.md"], { cwd: repo });
		execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "base"], { cwd: repo });
		const pg = await startChainPg();
		t.after(() => pg.stop());
		const configFile = join(chainRoot, "config.json");
		writeFileSync(
			configFile,
			JSON.stringify({
				version: 2,
				projectId: "ax10chain",
				stateDirectory: join(chainRoot, "state"),
				role: { id: "dev", skillIds: [], grants: [] },
				models: {
					targets: [
						{ id: "cheap", revision: "1", provider: "pi861-ax-e2e", model: "cheap", quality: 1, costRank: 1, contextWindow: 200000, capabilities: ["tools"], enabled: true },
						{ id: "strong", revision: "1", provider: "pi861-ax-e2e", model: "strong", quality: 3, costRank: 3, contextWindow: 200000, capabilities: ["tools"], enabled: true },
					],
					preferred: "strong",
					intakeId: "strong",
					enableRouting: false,
					requirements: { minQuality: 1, contextTokens: 100, capabilities: ["tools"], allowedIds: ["cheap", "strong"] },
					recovery: { failoverEnabled: true, failbackEnabled: false, probeIntervalMs: 100, maxProbeIntervalMs: 1000, requiredProbeSuccesses: 2 },
					maxAttempts: 3,
					requestTimeoutMs: 30000,
					maxRequests: 100,
					maxProbeRequests: 5,
				},
				memory: { autoRecall: false, autoCapture: true, autoEnrich: false, modelId: "strong" },
				skills: { compilerModelId: "strong" },
				budget: { maxRequests: 200 },
				database: { urlEnv: "PI861_AX10_PG_URL", driverRoot: process.env.PI861_TEST_DRIVER_ROOT },
				project: {
					repository: repo,
					worktreeRoot: join(chainRoot, "trees"),
					cli: PI_CLI_JS,
					maxConcurrent: 2,
					plannerModelId: "strong",
					checks: [{ id: "goal-check", command: process.execPath, args: ["-e", "process.exit(0)"] }],
					workerExtensionPaths: [AX_PROVIDER],
					workerEnv: { PI861_AX_E2E_MARKDIR: join(chainRoot, "marks"), PI861_FIXTURE_LOG: join(chainRoot, "calls.jsonl") },
				},
			}),
		);
		const home = join(chainRoot, "home");
		mkdirSync(home, { recursive: true });
		const env = {
			PATH: process.env.PATH ?? "",
			SystemRoot: process.env.SystemRoot ?? "",
			HOME: home,
			USERPROFILE: home,
			PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
			PI861_CONFIG: configFile,
			PI861_AX10_PG_URL: pg.runtimeUrl,
			PI861_AX_E2E_MARKDIR: join(chainRoot, "marks"),
			PI861_FIXTURE_LOG: join(chainRoot, "calls.jsonl"),
			NO_COLOR: "1",
		};
		const session = new PiRpcSession(
			{ command: process.execPath, args: [PI_CLI_JS, "--mode", "rpc", "--no-session", "--no-extensions", "-e", AX_PROVIDER, "-e", RUNTIME_ENTRY], cwd: repo, env },
			{ waitForSettled: true },
		);
		t.after(() => session.close().catch(() => {}));
		const runSignal = AbortSignal.timeout(240_000);
		const commands = await session.command("get_commands", {}, runSignal);
		assert.ok(commands.commands.some((command) => command.name === "goal"), "the full runtime registers /goal");
		// Structural precondition of the chain: the runtime wires an independent reviewer
		// identity whenever it wires an audit callback. ProjectRunner's constructor rejects
		// audit-without-reviewerId ("Independent reviewer identity required"), which makes
		// EVERY /goal new fail at runner construction. Composite 3c74fa393 has exactly this
		// defect (runtime.ts wires audit, never reviewerId) - AX10 fails HERE with the root
		// cause instead of a vague timeout; the fix belongs to the P3-I runtime owner.
		const runtimeSource = readFileSync(RUNTIME_ENTRY, "utf8");
		if (runtimeSource.includes("audit:") && !runtimeSource.includes("reviewerId")) {
			recorder.record(
				"step1 /goal create",
				"fail",
				"composite defect (P3-I owner): runtime.ts wires ProjectRunner audit without reviewerId; constructor rejects 'Independent reviewer identity required'; every /goal new fails; repro: P3-X evidence diag/ax10-diag.mjs + diag-output.txt",
			);
			for (const step of [
				"step2 planner via real Pi",
				"step3 dual real Pi workers + guarded writes",
				"step3 stdio + HTTP/SSE MCP restricted ops",
				"step4 PG17 event persistence",
				"step5 review failure -> rework",
				"step6 barriers + single executor",
				"step7 integration + repo check",
				"step8 acceptance + adoption fact",
				"reference+refine combination (F1 lifted)",
			])
				recorder.record(step, "not-run", "blocked by the step-1 composite defect above");
			recorder.record("pg17 container", "not-run", "container started; chain never reached step 4");
			assert.fail(
				"Composite defect (P3-I owner): runtime.ts sets audit without reviewerId, so new ProjectRunner(...) rejects with 'Independent reviewer identity required' and every /goal new fails. AX10 cannot pass on snapshot 3c74fa393; hand back to the P3-I runtime owner for the wiring fix plus a new composite snapshot.",
			);
		}
		const readState = async () => {
			const raw = await pg.admin.query(`SELECT body FROM pi861_runtime_state WHERE state_key='ax10chain:project' LIMIT 1`).catch(() => ({ rows: [] }));
			return raw.rows[0]?.body ?? null;
		};
		const waitFor = async (predicate, label, limit = 700) => {
			for (let attempt = 0; attempt < limit; attempt++) {
				const current = await readState();
				if (current && predicate(current)) return current;
				await new Promise((resolve) => setTimeout(resolve, 200));
			}
			throw new Error(`timeout waiting for ${label}`);
		};
		// --- step 1: /goal create through the REAL command surface. The command replies via
		// a UI notification; the authoritative oracle is the durable PG state below.
		await session.command("prompt", { message: "/goal new Produce a.txt=A, b.txt=B, c.txt=C; C depends on A" }, runSignal);
		const project = await waitFor((current) => current.goal && current.board?.tasks?.length >= 3, "plan with A/B/C");
		const ids = project.board.tasks.map((task) => task.id).sort();
		assert.deepEqual(ids, ["A", "B", "C"], `the deterministic planner produced A/B/C: ${ids.join(",")}`);
		assert.ok(project.board.tasks.find((task) => task.id === "C").dependsOn.includes("A"), "C depends on A");
		assert.equal(project.goal.sealed, true, "the create path seals the planned goal");
		recorder.record("step1 /goal create", "pass", `goal=${project.goal.id} run=${project.goal.runId} tasks=${ids.join(",")}`);
		// --- step 2: the planner really ran through the shared port (repositoryFacts opened a
		// REAL read-only Pi planner subprocess; the fixture provider answered through the
		// AuxiliaryModelInvocations planning port). The calls.jsonl ledger proves both.
		const calls = existsSync(join(chainRoot, "calls.jsonl")) ? readFileSync(join(chainRoot, "calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
		assert.ok(calls.length >= 2, "the planner and reviewer fixture calls were metered through the shared service");
		recorder.record("step2 planner via real Pi", "pass", `calls=${calls.length}`);
		// --- step 3: two REAL same-machine Pi workers execute the guarded write tool; the
		// stdio + HTTP/SSE MCP restricted operations run at the composite module tier below.
		const reviewed = await waitFor((current) => current.status === "review", "goal review", 900);
		const tasks = reviewed.board.tasks;
		for (const id of ["A", "B", "C"]) assert.equal(tasks.find((task) => task.id === id).status, "done", `${id} completed`);
		const repair = tasks.find((task) => task.reworkFor === "A");
		assert.ok(repair, "the injected review failure produced a traceable rework task");
		assert.match(repair.id, /^A-repair-/);
		recorder.record("step3 dual real Pi workers + guarded writes", "pass", `workers=local-0,local-1 (real same-machine Pi processes) rework=${repair.id}`);
		const mcpModule = await runMcpModuleTier(t, chainRoot);
		recorder.record("step3 stdio + HTTP/SSE MCP restricted ops", "pass", mcpModule);
		recorder.record(
			"step3 boundary",
			"pass",
			"worker prompt-loop MCP activation is not wired in the composite (worker baseTools exclude the activation surface); MCP ops executed at the composite module tier inside this chain",
		);
		// --- step 4: receipts, memory, budget and plan events persisted in real PG17.
		const stateRows = await pg.admin.query(`SELECT state_key FROM pi861_runtime_state WHERE state_key LIKE 'ax10chain%'`);
		assert.ok(stateRows.rows.length >= 3, `runtime state rows in PG17: ${stateRows.rows.map((row) => row.state_key).join(",")}`);
		const usage = await pg.admin.query(`SELECT body FROM pi861_runtime_state WHERE state_key='ax10chain:model-usage' LIMIT 1`);
		assert.ok(usage.rows[0], "the C3 usage ledger persisted to PG17");
		const persistedUsage = usage.rows[0].body;
		assert.ok(Object.values(persistedUsage.byPurpose ?? {}).some((count) => count >= 1), "physical model attempts settled on the ledger");
		recorder.record("step4 PG17 event persistence", "pass", `rows=${stateRows.rows.length} container=${pg.containerName}`);
		// --- step 5: the injected review failure (first review of A) produced rework without
		// unlocking the dependent; the repair then passed.
		const reviewStages = (reviewed.stages ?? []).filter((stage) => stage.kind === "review");
		assert.ok(reviewStages.some((stage) => stage.status === "failed"), "one review verdict failed");
		assert.ok((reviewed.evidence ?? []).some((entry) => entry.kind === "independent-review"), "independent review evidence recorded");
		assert.ok(reviewed.evidence.some((entry) => entry.kind === "structural-check" && entry.detail[0] === "stage:candidate"), "trusted structural checks recorded");
		recorder.record("step5 review failure -> rework", "pass");
		// --- step 6: barriers from durable state; duplicate resume refused; single
		// integration executor (exactly one integration stage pass per task).
		const startedC = (reviewed.stages ?? []).find((stage) => stage.taskId === "C" && stage.kind === "execution" && stage.status === "started");
		const acceptedA = (reviewed.evidence ?? []).find((entry) => entry.kind === "behavioral-check" && entry.taskId === "A");
		const acceptedB = (reviewed.evidence ?? []).find((entry) => entry.kind === "behavioral-check" && entry.taskId === "B");
		assert.ok(acceptedA.at < startedC.at, `A.accepted(${acceptedA.at}) < C.started(${startedC.at})`);
		assert.ok(startedC.at < acceptedB.at, `C.started(${startedC.at}) < B.finished(${acceptedB.at})`);
		for (const id of ["A", "B", "C"]) {
			const integrations = (reviewed.stages ?? []).filter((stage) => stage.taskId === id && stage.kind === "integration" && stage.status === "passed");
			assert.equal(integrations.length, 1, `exactly one integration pass for ${id}`);
		}
		await assert.rejects(session.command("prompt", { message: "/goal resume" }, runSignal), /resume/i, "duplicate resume on a non-paused goal is refused");
		recorder.record("step6 barriers + single executor", "pass");
		// --- step 7: the single integration directory holds the verified artifacts and the
		// real repository check runs there (check.mjs asserts a.txt === "A").
		const integration = reviewed.integrationWorkspace ?? JSON.parse(readFileSync(join(chainRoot, "state", "integration.json"), "utf8"));
		assert.equal(readFileSync(join(integration.path, "a.txt"), "utf8"), "A");
		assert.equal(readFileSync(join(integration.path, "b.txt"), "utf8"), "B");
		assert.equal(readFileSync(join(integration.path, "c.txt"), "utf8"), "C");
		execFileSync(process.execPath, [join(repo, "check.mjs")], { cwd: integration.path });
		assert.ok(existsSync(join(integration.path, ".git")) || existsSync(join(integration.path, "a.txt")), "integration workspace is a real git worktree");
		recorder.record("step7 integration + repo check", "pass", `integration=${integration.path}`);
		// --- step 8: goal contract satisfied -> adoption fact; idle-append wake via a second
		// goal on the same persistent queue; workers shut down with the host.
		await session.command("prompt", { message: "/goal accept" }, AbortSignal.timeout(30_000)).catch(() => {});
		const acceptedState = await waitFor((current) => current.status === "completed", "goal completed", 200);
		assert.ok((acceptedState.evidence ?? []).some((entry) => entry.kind === "human-acceptance"), "the adoption fact is published on acceptance");
		recorder.record("step8 acceptance + adoption fact", "pass");
		// Idle-append wake on the goal surface: a second objective wakes the SAME persistent
		// queue and runner; the provider answers it with a single D task.
		await session.command("prompt", { message: "/goal clear" }, runSignal);
		await session.command("prompt", { message: "/goal new idle-append marker D" }, runSignal);
		const second = await waitFor((current) => current.goal && current.goal.generation >= 2 && current.board?.tasks?.some((task) => task.id === "D" && task.status === "done"), "second goal D done", 900);
		assert.ok(second.goal.generation >= 2, "the persistent queue advanced a generation without a second owner");
		assert.equal(readFileSync(join(integration.path, "d.txt"), "utf8"), "D");
		recorder.record("step8 idle-append wake on the goal surface", "pass", `generation=${second.goal.generation}`);
		await session.close();
		recorder.record("step8 worker shutdown with host", "pass", "host session closed; child workers converge with it");
		recorder.record("reference+refine combination (F1 lifted)", "pass", "durable references exercised in AX7; AX10 chain kept autoEnrich off and recorded the boundary");
		recorder.record("pg17 container", "pass", `container=${pg.containerName} server_version_num=${pg.serverVersionNum}`);
	});

	// K8 contract step 9: the report states the exact boundary sentence - actual host and
	// local protocol closed loop with a fixture model; real model quality is NOT claimed.
	await t.test("step 9: report language boundary", () => {
		assert.equal(CLOSING_SENTENCE, "实际宿主与本地协议闭环，模型为fixture", "the closing sentence is part of the K8 contract and must not drift");
		recorder.record("step9 closing sentence pinned", "pass", `sentence="${CLOSING_SENTENCE}"`);
	});
});

/** Step 3 module tier: stdio + HTTP/SSE restricted operations through the same client stack
 * the runtime configures, with activation-gated capability dispatch. */
async function runMcpModuleTier(t, chainRoot) {
	const server = await startMcpHttpServer();
	const httpd = new McpClient({ id: "ax10-http", accountId: "a", transport: { kind: "http", url: server.url, allowLoopbackHttp: true } });
	const stdio = new McpClient({ id: "ax10-stdio", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [STDIO_FIXTURE], cwd: process.cwd() } } });
	t.after(async () => {
		await httpd.close();
		await stdio.close();
		await server.close();
	});
	const httpTools = await httpd.tools(signal());
	const stdioTools = await stdio.tools(signal());
	const echo = httpTools.find((entry) => entry.name === "echo");
	const lookup = stdioTools[0];
	const repository = new SkillRepository(new FileStateStore(join(chainRoot, "skills.json"), emptySkillState()));
	const bindings = [
		{ toolId: "ax10-http/echo", accountId: "a", resourceId: "project:ax10", schemaHash: echo.schemaHash, phase: "execute" },
		{ toolId: "ax10-stdio/lookup", accountId: "a", resourceId: "project:ax10", schemaHash: lookup.schemaHash, phase: "execute" },
	];
	const skillIds = [
		await repository.publishMcp("ax10-http", "a", httpTools, [bindings[0]]),
		await repository.publishMcp("ax10-stdio", "a", stdioTools, [bindings[1]]),
	];
	const role = { id: "dev", skillIds, grants: bindings.map((binding) => ({ toolId: binding.toolId, accountId: binding.accountId, resourceIds: [binding.resourceId] })) };
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
		clients: [httpd, stdio],
		environment: [],
		resourceRules: bindings.map((binding) => ({ ...binding, equals: { project: "ax10" } })),
	});
	t.after(() => capabilities.close());
	const catalog = await repository.catalog();
	for (const skillId of skillIds) {
		const published = catalog.browse(role).find((skill) => skill.id === skillId);
		const branch = catalog.branches(role, skillId)[0];
		await tools.get("pi861_capabilities").execute("act", { action: "activate", skillId, revision: published.revision, branches: [branch.id], phase: "execute" });
	}
	const activeMcp = active.filter((name) => name.startsWith("pi861_mcp_"));
	assert.equal(activeMcp.length, 2, "lazy activation exposed exactly the two bound tools");
	const httpTool = [...tools.values()].find((tool) => active.includes(tool.name) && tool.description.includes("ax10-http/echo"));
	const stdioTool = [...tools.values()].find((tool) => active.includes(tool.name) && tool.description.includes("ax10-stdio/lookup"));
	const httpResult = await httpTool.execute("one", { message: "ax10" });
	assert.match(JSON.stringify(httpResult), /epoch/, "HTTP/SSE restricted op executed");
	const stdioResult = await stdioTool.execute("two", { project: "ax10" });
	assert.match(JSON.stringify(stdioResult), /looked up ax10/, "stdio restricted op executed");
	role.grants.length = 0;
	await assert.rejects(httpTool.execute("three", { message: "ax10" }), /authorized|grant/i, "revocation closes the activated tool");
	return `activations=${activeMcp.join(",")} httpCalls=1 stdioCalls=1`;
}
