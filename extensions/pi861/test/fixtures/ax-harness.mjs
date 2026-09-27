import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

// P3-X scenario assembly harness (AX1-AX10). Pure composition layer over the P1-Q fixtures
// (p1-fixtures @ a46de4a96): it never reimplements a fixture, never starts a server or process
// itself, and imports no fixture module - the two integration files own those imports so the
// dependency chain stays visible and reviewable. Everything here works on ANY snapshot:
//   - AX_SCENARIOS      : the declarative coverage matrix (one entry per AX1-AX10)
//   - fixturePresence() : honest probe of which P1-Q fixture files exist in THIS tree
//   - readiness()       : fixture + environment + composite-snapshot gating for one scenario
//   - AxEventClock      : monotonic logical clock for barrier order assertions (AX1)
//   - CoverageRecorder  : per-scenario C7 outcome ledger; skip/not-run/blocked never aggregate
//                         to pass; evidence JSON follows the P1-Q runner's suite-mode shape
//                         (version/suite/requiredChecks/status/outcomes).
// Composite dependency contract: scenario parts that need the P3-I integrated runtime are
// activated by PI861_AX_COMPOSITE_SNAPSHOT=<SnapshotID> (plan section 7 evidence rule). When
// the variable is unset those parts skip-by-dependency and are recorded as "not-run"; when it
// IS set, a missing probe file is a hard failure (a declared snapshot must satisfy its own
// contract), never a silent skip.

export const OUTCOMES = ["pass", "fail", "skip", "not-run", "blocked"];
export const COMPOSITE_SNAPSHOT_ENV = "PI861_AX_COMPOSITE_SNAPSHOT";
export const EVIDENCE_DIR_ENV = "PI861_AX_EVIDENCE_DIR";
export const PG17_OPT_IN_ENV = "PI861_PG17_TESTS";
export const PI_CLI_ENV = "PI861_TEST_PI_CLI";

/** P1-Q fixture files this harness composes (paths relative to extensions/pi861). */
export const P1Q_FIXTURES = {
	mcpHttpServer: "test/fixtures/mcp-http-server.mjs",
	pg17: "test/fixtures/pg17.mjs",
	workerPair: "test/fixtures/worker-pair.mjs",
	faultProxy: "test/fixtures/fault-proxy.mjs",
	httpFixtures: "test/fixtures/http-fixtures.mjs",
	piWorker: "test/fixtures/pi-worker.mjs",
	nativeProvider: "test/fixtures/native-provider.mjs",
	/** worker-pair imports validateWorkerPairEvidence from here; probe it alongside the fixture. */
	acceptanceSource: "src/live/acceptance.ts",
};

const extensionRoot = fileURLToPath(new URL("../..", import.meta.url));

/** Which P1-Q fixture files exist in the current tree. Absence is reported, never guessed. */
export function fixturePresence(rootUrl = new URL("../..", import.meta.url)) {
	const root = fileURLToPath(rootUrl);
	const present = {};
	for (const [name, relative] of Object.entries(P1Q_FIXTURES)) present[name] = existsSync(join(root, relative));
	return present;
}

/**
 * Composite probe files per scenario: module paths that must exist once the named owner's work
 * is merged into the P3-I composite. Paths are the plan-fixed contract names (CONTINUATION_PLAN
 * section 5/7); files that exist in the base tree already (scheduler, coordinator, ...) are not
 * probes - only NEW module files prove the merged entry is present.
 */
const COMPOSITE_PROBES = {
	"P2-A/P2-B": ["src/live/model-service.ts", "src/live/health-service.ts", "src/live/stream-bridge.ts"],
	"P2-S": ["src/live/skill-services.ts", "src/live/skill-validation.ts"],
	"P2-G": ["src/live/goal-command.ts", "src/live/goal-recovery.ts"],
	"P2-W": ["scripts/worker-service.mjs"],
	"P2-D": ["src/live/storage-service.ts"],
	"P3-I": ["src/live/runtime-configuration.ts", "src/live/auxiliary-models.ts"],
};

/** Environment gates beyond fixture presence. Each entry: [envName, requiredValue|null]. */
const ENV_GATES = {
	pg17: [[PG17_OPT_IN_ENV, "1"]],
	realPi: [[PI_CLI_ENV, null]],
};

/**
 * The AX1-AX10 coverage matrix. Sources: HANDOFF_PROMPT_2026-09-22.md section 9 items 1-10,
 * CONTINUATION_PLAN_2026-09-23.md section 3 AX table and section 7 K8 contract.
 * boundaries[] are fixed known limits that stay attached to the scenario in every report.
 */
export const AX_SCENARIOS = [
	{
		id: "AX1",
		title: "A accepted before dependent C starts before slow B finishes; idle append still wakes",
		requirements: ["R3.2", "R3.3", "G4"],
		fixtures: ["workerPair"],
		composite: { owners: ["P2-G", "P3-I"], probes: COMPOSITE_PROBES["P2-G"] },
		envGates: [],
		passCriteria: [
			"event clock records A.accepted < C.started < B.finished from coordinator state events, not task text",
			"C does not start before A is accepted even while B still runs",
			"a task appended after the queue went idle is dispatched without rebuilding the runner",
		],
		boundaries: [
			"worker pair fixture = real OS processes speaking the pi-worker protocol, deterministic model; NOT real Pi - real-Pi variant is AX10",
		],
	},
	{
		id: "AX2",
		title: "Submission alone unlocks nothing; review failure produces traceable rework, never fake completion",
		requirements: ["R8.2", "R8.8", "G7"],
		fixtures: ["workerPair"],
		composite: { owners: ["P2-G", "P2-M", "P3-I"], probes: [...COMPOSITE_PROBES["P2-G"], ...COMPOSITE_PROBES["P2-D"]] },
		envGates: [],
		passCriteria: [
			"delivered artifact in review state does not unlock a strong dependent task",
			"a failed independent review links rework to the original artifact and attempt id",
			"no project-adoption fact is published before goal-contract acceptance",
			"repeated settle of the same completion request does not count twice",
		],
		boundaries: ["adoption-fact publication is memory-tiered; the reference+refine cross-check is BLOCKED-BY-P2M-F1"],
	},
	{
		id: "AX3",
		title: "failover/failback four combinations; probe budget, stability gate, preferred change, cancel, late response",
		requirements: ["R1.7", "R2.1", "R2.2", "R2.6"],
		fixtures: ["faultProxy"],
		composite: { owners: ["P2-A", "P3-I"], probes: COMPOSITE_PROBES["P2-A/P2-B"] },
		envGates: [],
		passCriteria: [
			"all four failoverEnabled x failbackEnabled combinations behave as specified",
			"consecutive probes respect probe budget and single-flight; one physical probe is metered once",
			"failback only after stability confirmation, and never when failback is disabled for the task",
			"a new preferred model is not overwritten by an old model's recovery",
			"user cancel and explicit service rejection are not treated as transient faults to route around",
			"a late response from a superseded attempt has no tool-execution authority",
		],
		boundaries: ["model tier is the deterministic fixture provider registered through the composite model service; no paid model"],
	},
	{
		id: "AX4",
		title: "stream cut at text-mid, param-mid, pre/post dispatch, receipt lost; side effects never duplicated",
		requirements: ["R2.4", "R2.10", "G4"],
		fixtures: ["mcpHttpServer", "faultProxy"],
		composite: { owners: ["P2-B", "P2-S", "P3-I"], probes: [...COMPOSITE_PROBES["P2-A/P2-B"], ...COMPOSITE_PROBES["P2-S"]] },
		envGates: [],
		passCriteria: [
			"interruption during visible text keeps attempt attribution without splicing attempts",
			"half-received tool parameters cause zero dispatch",
			"cut before dispatch vs after dispatch are distinguishable in evidence",
			"tool succeeded but receipt lost resolves via stable business operation id: unknown, then confirm - never blind re-send",
			"the MCP fixture requestLog proves the write tool executed exactly once across the whole sequence",
		],
		boundaries: [],
	},
	{
		id: "AX5",
		title: "two generic debug skills plus one specialized: consolidate, branch, update, rollback, version pin",
		requirements: ["R4.2", "R4.10", "R4.5"],
		fixtures: [],
		composite: { owners: ["P2-S", "P3-I"], probes: COMPOSITE_PROBES["P2-S"] },
		envGates: [],
		passCriteria: [
			"installing two overlapping generic debug packages auto-consolidates them; the specialized package stays a distinct branch",
			"default prompts contain no raw original skill description",
			"updating a package does not replace the version pinned to a running task",
			"rollback restores the previously published immutable version",
			"synthetic packages carry real files/resources; identity and version manifest stay stable across the sequence",
		],
		boundaries: ["skill packages are harness-built synthetic archives (deterministic), which exercises the real install path, not model quality"],
	},
	{
		id: "AX6",
		title: "inactive MCP exposes no full toolset; lazy activation, revocation, cross-account, same-name, schema drift, hidden-name direct call",
		requirements: ["R5.3", "R5.4", "R5.5", "R5.7"],
		fixtures: ["mcpHttpServer"],
		composite: { owners: ["P2-S", "P3-I"], probes: COMPOSITE_PROBES["P2-S"] },
		envGates: [],
		passCriteria: [
			"discovery/browse issues zero tools/call requests (requestLog) and injects no full toolset into context",
			"activation exposes only the branch-required tools",
			"revocation rejects both further calls and previously issued result references",
			"same tool name from two accounts or two skills never crosses authorization closures",
			"schema drift (fixture flip-schema) invalidates the old binding; re-activation required",
			"calling a hidden tool by literal name is rejected",
		],
		boundaries: [],
	},
	{
		id: "AX7",
		title: "auto record + refine; restore across session/model/node; no leak via summaries; withdrawal never resurrects",
		requirements: ["R6.3", "R6.11", "R6.2"],
		fixtures: ["pg17", "workerPair"],
		composite: { owners: ["P2-M", "P2-D", "P3-I"], probes: [...COMPOSITE_PROBES["P2-D"]] },
		envGates: ENV_GATES.pg17,
		passCriteria: [
			"tool execution is recorded at execution end (not session end) and refinement tasks queue durably",
			"fixed constraints assemble on task takeover / model switch / node switch without keyword luck",
			"private information never reaches an unauthorized reader through summaries, retrieval, counts or graph edges",
			"withdrawal propagates to old tasks, indexes and derived records; reprocessing a withdrawn source is rejected",
		],
		boundaries: [
			"requires a real PostgreSQL 17 container (docker + PI861_PG17_TESTS=1); no container = explicit block, never skip-to-pass",
			"any step combining persistent controlled references WITH refinement is BLOCKED-BY-P2M-F1 (P2-M review-1 F1) until the fix is re-verified",
		],
	},
	{
		id: "AX8",
		title: "transient refinement failure recovers boundedly; same requestId confirms a lost receipt; local mirror never impersonates shared commit",
		requirements: ["R6.9", "R6.13", "G2"],
		fixtures: ["pg17"],
		composite: { owners: ["P2-M", "P2-D", "P3-I"], probes: [...COMPOSITE_PROBES["P2-D"]] },
		envGates: ENV_GATES.pg17,
		passCriteria: [
			"a transient refinement failure retries with backoff and bounded attempts (default 3), then surfaces a permanent, actionable failure",
			"a commit whose receipt was lost after COMMIT is confirmed idempotently by replaying the same requestId",
			"a different intent under the same requestId is rejected as a conflict",
			"while the shared store is unreachable, local pending records stay explicitly uncommitted - never presented as shared truth",
		],
		boundaries: [
			"requires a real PostgreSQL 17 container (docker + PI861_PG17_TESTS=1)",
			"P1-Q provides no DB-level fault proxy; connection loss is injected by stopping/restarting the fixture container or by the storage service's own failure hooks - recorded in evidence",
			"reference+refine combined steps are BLOCKED-BY-P2M-F1",
		],
	},
	{
		id: "AX9",
		title: "duplicate goal commands, restart, plan CAS conflict, stale node: exactly one coordinator and one integration executor",
		requirements: ["R3.9", "R8.4", "R8.5", "G3"],
		fixtures: ["workerPair"],
		composite: { owners: ["P2-G", "P2-W", "P3-I"], probes: [...COMPOSITE_PROBES["P2-G"], ...COMPOSITE_PROBES["P2-W"]] },
		envGates: [],
		passCriteria: [
			"a repeated /goal resume does not create a second coordinator or a second integration executor for the same goal",
			"coordinator process restart re-elects exactly one owner; the stale node cannot overwrite current state",
			"concurrent plan appends with a stale version are rejected by CAS; cycles are rejected",
			"the integration directory is not handed over while the previous git process tree is still alive",
			"no task is dispatched twice across the whole sequence (worker task ids unique per attempt)",
		],
		boundaries: ["integration workspace uses a harness-created temporary real git repository"],
	},
	{
		id: "AX10",
		title: "/goal vertical loop: plan, real Pi workers, skill/MCP, memory, verification, controlled integration (model = fixture)",
		requirements: ["R8.6", "AX10", "G6"],
		fixtures: ["pg17", "workerPair", "mcpHttpServer", "faultProxy", "httpFixtures", "piWorker", "nativeProvider"],
		composite: {
			owners: ["P3-I", "P2-G", "P2-W", "P2-S", "P2-M", "P2-D"],
			probes: [
				...COMPOSITE_PROBES["P3-I"],
				...COMPOSITE_PROBES["P2-G"],
				...COMPOSITE_PROBES["P2-W"],
				...COMPOSITE_PROBES["P2-S"],
				...COMPOSITE_PROBES["P2-D"],
			],
		},
		envGates: [...ENV_GATES.pg17, ...ENV_GATES.realPi],
		passCriteria: [
			"the nine K8 contract steps run in order from the real /goal entry of the full runtime (plan section 7, K8)",
			"workers are two real Pi processes; the model is the deterministic fixture provider and the report says so",
			"receipts, memory, sources, budget and plan events land in the real temporary PG17",
			"at least one injected review failure produces rework without unlocking the strong dependent",
			"A accepted then C starts before slow B finishes; idle append wakes; repeated resume does not double-integrate",
			"verified artifacts apply in the single integration directory and the real repository check runs there",
			"final report language: actual host + local protocol closed loop, model is fixture - real model quality NOT claimed",
		],
		boundaries: [
			"requires docker + PI861_PG17_TESTS=1 and a real Pi CLI via PI861_TEST_PI_CLI",
			"reference+refine combination inside the loop is BLOCKED-BY-P2M-F1 until re-verified",
			"same-machine multi-process is labeled same-machine; never reported as cross-host",
		],
	},
];

export function scenarioById(id) {
	return AX_SCENARIOS.find((scenario) => scenario.id === id);
}

/** Registry integrity: the coverage matrix itself is under test (harness self-test). */
export function validateScenarioRegistry() {
	const errors = [];
	const ids = AX_SCENARIOS.map((scenario) => scenario.id);
	const expected = Array.from({ length: 10 }, (_unused, index) => `AX${index + 1}`);
	for (const id of expected) if (!ids.includes(id)) errors.push(`missing scenario ${id}`);
	if (new Set(ids).size !== ids.length) errors.push("duplicate scenario ids");
	for (const scenario of AX_SCENARIOS) {
		if (!scenario.title) errors.push(`${scenario.id}: missing title`);
		if (!scenario.requirements.length) errors.push(`${scenario.id}: missing requirement refs`);
		if (!scenario.passCriteria.length) errors.push(`${scenario.id}: missing pass criteria`);
		if (!scenario.composite?.probes) errors.push(`${scenario.id}: missing composite probes`);
		for (const fixture of scenario.fixtures)
			if (!Object.keys(P1Q_FIXTURES).includes(fixture)) errors.push(`${scenario.id}: unknown fixture ${fixture}`);
		for (const [envName] of scenario.envGates)
			if (!/^[A-Z][A-Z0-9_]*$/.test(envName)) errors.push(`${scenario.id}: bad env gate ${envName}`);
	}
	return { ok: errors.length === 0, errors };
}

/**
 * Readiness of one scenario in the CURRENT tree + environment.
 * Returns { ready, fixtureGaps, envGaps, compositeDeclared, missingProbes, blockers }.
 * - fixtureGaps: P1-Q fixture files this scenario composes that are absent here.
 * - envGaps: environment gates (and their human reason) not satisfied.
 * - compositeDeclared: whether PI861_AX_COMPOSITE_SNAPSHOT names a composite snapshot.
 * - missingProbes: composite module files absent although a snapshot WAS declared (hard fail).
 * - blockers: fixed known boundaries that currently hold (BLOCKED-BY-P2M-F1).
 */
export function readiness(scenario, env = process.env, presence = fixturePresence()) {
	const fixtureGaps = scenario.fixtures.filter((name) => !presence[name]);
	const envGaps = scenario.envGates
		.filter(([name, required]) => env[name] === undefined || (required !== null && env[name] !== required))
		.map(([name]) => name);
	const compositeDeclared = Boolean(env[COMPOSITE_SNAPSHOT_ENV]);
	const missingProbes = compositeDeclared
		? scenario.composite.probes.filter((relative) => !existsSync(join(extensionRoot, relative)))
		: [];
	return { ready: fixtureGaps.length === 0 && envGaps.length === 0 && missingProbes.length === 0, fixtureGaps, envGaps, compositeDeclared, missingProbes };
}

/** node:test skip descriptor for a not-ready scenario; the reason names every dependency. */
export function skipReason(scenario, state) {
	const parts = [];
	if (state.fixtureGaps.length)
		parts.push(`missing P1-Q fixture files: ${state.fixtureGaps.map((name) => P1Q_FIXTURES[name]).join(", ")}`);
	if (state.envGaps.length) parts.push(`environment gates not set: ${state.envGaps.join(", ")}`);
	if (!state.compositeDeclared)
		parts.push(`composite runtime not activated: ${COMPOSITE_SNAPSHOT_ENV} does not name a P3-I composite SnapshotID (owners ${scenario.composite.owners.join("/")})`);
	if (state.missingProbes.length) parts.push(`declared composite snapshot is missing probe files: ${state.missingProbes.join(", ")}`);
	return `skip-by-dependency ${scenario.id}: ${parts.join("; ")}`;
}

/**
 * Monotonic logical clock for barrier order assertions. Ticks are strictly increasing integers;
 * events recorded from different sources keep their arrival order unambiguous.
 */
export class AxEventClock {
	constructor() {
		this.tick = 0;
		this.events = [];
	}
	next(label) {
		this.tick += 1;
		this.events.push({ label, tick: this.tick });
		return this.tick;
	}
	order(label) {
		const event = this.events.find((candidate) => candidate.label === label);
		if (!event) throw new Error(`AxEventClock: no event labeled ${label}`);
		return event.tick;
	}
}

/** True when the recorded order satisfies every listed a-before-b pair. */
export function barrierSatisfied(clock, pairs) {
	return pairs.every(([before, after]) => clock.order(before) < clock.order(after));
}

/**
 * Per-scenario C7 outcome ledger. The aggregate is pass only when at least one step was
 * recorded, every recorded step passed, AND the composite snapshot was declared;
 * skip/not-run/blocked never promote, and an empty ledger never passes (G7, review-1 F1).
 */
export class CoverageRecorder {
	constructor(scenarioId, evidenceDir) {
		this.scenarioId = scenarioId;
		this.evidenceDir = evidenceDir;
		this.startedAt = new Date().toISOString();
		this.steps = [];
	}
	record(step, outcome, detail = "") {
		if (!OUTCOMES.includes(outcome)) throw new Error(`unknown outcome ${outcome}`);
		this.steps.push({ step, outcome, detail });
		return this;
	}
	snapshot(compositeDeclared) {
		const outcomes = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
		for (const step of this.steps) outcomes[step.outcome] += 1;
		// review-1 F1 fix: an EMPTY ledger is never "passed" - [].every() is vacuously true, so a
		// scenario that recorded no step at all must stay "incomplete" even with a declared
		// composite snapshot. No recorded step = no proof (G7).
		const allPassed = this.steps.length > 0 && this.steps.every((step) => step.outcome === "pass");
		const status = this.steps.some((step) => step.outcome === "fail")
			? "failed"
			: allPassed && compositeDeclared
				? "passed"
				: "incomplete";
		return {
			version: 1,
			suite: "ax",
			scenario: this.scenarioId,
			startedAt: this.startedAt,
			requiredChecks: this.steps.map((step) => ({ id: step.step, status: step.outcome === "pass" ? "passed" : step.outcome })),
			outcomes,
			status,
			steps: this.steps,
			compositeSnapshotDeclared: compositeDeclared,
		};
	}
	/** Writes evidence in the P1-Q suite-mode evidence shape; returns the file path. */
	write(compositeDeclared) {
		const payload = this.snapshot(compositeDeclared);
		const dir = this.evidenceDir ?? mkdtempSync(join(tmpdir(), "pi861-ax-evidence-"));
		if (!isAbsolute(dir)) throw new Error("evidence dir must be absolute");
		mkdirSync(dir, { recursive: true });
		const path = join(dir, `${this.scenarioId.toLowerCase()}-evidence.json`);
		writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
		return { path, payload };
	}
}

/** One-line matrix row per scenario for console + report rendering. */
export function coverageRow(scenario, state) {
	const fixture = scenario.fixtures.length ? scenario.fixtures.join("+") : "(synthetic)";
	const runnable = state.ready && state.compositeDeclared ? "activatable" : state.ready ? "fixture-only" : "gated";
	const gaps = [
		...state.fixtureGaps.map((name) => `missing:${name}`),
		...state.envGaps.map((name) => `env:${name}`),
		...(state.missingProbes.length ? [`probe-miss:${state.missingProbes.length}`] : []),
	].join(",");
	return `${scenario.id}\t${fixture}\t${scenario.composite.owners.join("/")}\t${runnable}${gaps ? `\t${gaps}` : ""}`;
}

/** SHA256 of a file's bytes; used to bind evidence to the exact fixture/composite versions. */
export function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Directory path helper for scenario workspaces (mkdtemp under the OS temp root). */
export function scenarioWorkspace(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}
