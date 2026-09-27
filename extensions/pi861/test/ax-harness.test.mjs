import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// P3-X harness self-tests. These run on ANY snapshot (base tree without P1-Q fixtures
// included): they pin the coverage-matrix semantics, the skip-by-dependency vocabulary, the
// barrier clock and the C7 outcome aggregation so the two integration files cannot silently
// drift into skip-to-pass. They are NOT AX pass records.
import {
	AX_SCENARIOS,
	AxEventClock,
	COMPOSITE_SNAPSHOT_ENV,
	CoverageRecorder,
	OUTCOMES,
	P1Q_FIXTURES,
	barrierSatisfied,
	coverageRow,
	fixturePresence,
	readiness,
	scenarioById,
	skipReason,
	validateScenarioRegistry,
} from "./fixtures/ax-harness.mjs";

const extensionRoot = fileURLToPath(new URL("..", import.meta.url));

test("AX registry covers AX1-AX10 with fixtures, criteria and boundaries", () => {
	const validation = validateScenarioRegistry();
	assert.deepEqual(validation, { ok: true, errors: [] });
	assert.equal(AX_SCENARIOS.length, 10);
	assert.deepEqual(
		AX_SCENARIOS.map((scenario) => scenario.id),
		Array.from({ length: 10 }, (_unused, index) => `AX${index + 1}`),
	);
	for (const scenario of AX_SCENARIOS) {
		assert.ok(scenario.title.length > 10, `${scenario.id} needs a descriptive title`);
		assert.ok(scenario.requirements.length >= 1);
		assert.ok(scenario.passCriteria.length >= 3, `${scenario.id} must state its pass criteria`);
		assert.ok(scenario.composite.probes.length >= 1, `${scenario.id} must probe composite files`);
		for (const fixture of scenario.fixtures) assert.ok(P1Q_FIXTURES[fixture], `${scenario.id} fixture ${fixture} must be a known P1-Q fixture`);
	}
});

test("known boundaries stay attached: PG17 gates and BLOCKED-BY-P2M-F1", () => {
	for (const id of ["AX7", "AX8", "AX10"]) {
		const scenario = scenarioById(id);
		assert.ok(
			scenario.boundaries.some((boundary) => boundary.includes("PostgreSQL 17") || boundary.includes("PI861_PG17_TESTS")),
			`${id} must keep its PG17 container boundary`,
		);
		assert.ok(
			scenario.boundaries.some((boundary) => boundary.includes("BLOCKED-BY-P2M-F1")),
			`${id} must keep the P2-M review-1 F1 block on the reference+refine combination`,
		);
	}
	const ax10 = scenarioById("AX10");
	assert.ok(ax10.envGates.some(([name]) => name === "PI861_TEST_PI_CLI"), "AX10 activation requires a real Pi CLI");
	assert.ok(ax10.boundaries.some((boundary) => boundary.includes("same-machine")), "AX10 must label same-machine execution as same-machine");
});

test("fixturePresence reports this tree honestly (no guessing)", () => {
	const presence = fixturePresence();
	for (const [name, relative] of Object.entries(P1Q_FIXTURES))
		assert.equal(presence[name], existsSync(join(extensionRoot, relative)), `presence probe for ${name} must match the filesystem`);
});

test("readiness and skipReason name every missing dependency explicitly", () => {
	const absent = Object.fromEntries(Object.keys(P1Q_FIXTURES).map((name) => [name, false]));
	const env = { PI861_PG17_TESTS: "1", PI861_TEST_PI_CLI: "x", PI861_AX_COMPOSITE_SNAPSHOT: "snap-test" };
	for (const scenario of AX_SCENARIOS) {
		const state = readiness(scenario, env, absent);
		assert.deepEqual(state.fixtureGaps, scenario.fixtures, `${scenario.id} reports exactly its missing fixtures`);
		// review-1 F2 fix: "not ready" is guaranteed only where an absent dependency forces it.
		// A fixture-less, env-gate-less scenario (AX5 builds synthetic packages only) is
		// legitimately ready on any tree once its probe files exist - readiness is NOT
		// snapshot-dependent there, so this test must not assert otherwise.
		if (scenario.fixtures.length > 0 || scenario.envGates.length > 0)
			assert.equal(state.ready, false, `${scenario.id} with absent fixtures/gates must not be ready`);
		else assert.deepEqual([state.fixtureGaps.length, state.envGaps.length], [0, 0], `${scenario.id} has no fixture/env dependencies to report`);
	}
	const ax1 = scenarioById("AX1");
	const reason = skipReason(ax1, readiness(ax1, {}, absent));
	assert.ok(reason.startsWith("skip-by-dependency AX1:"));
	assert.ok(reason.includes("test/fixtures/worker-pair.mjs"));
	const ax7env = readiness(scenarioById("AX7"), {}, { ...absent, pg17: true });
	assert.ok(ax7env.envGaps.includes("PI861_PG17_TESTS"), "AX7 without the opt-in reports the env gate");
});

test("a declared composite snapshot with missing probe files is reported, not hidden", () => {
	const present = Object.fromEntries(Object.keys(P1Q_FIXTURES).map((name) => [name, true]));
	const env = { [COMPOSITE_SNAPSHOT_ENV]: "declared-but-incomplete" };
	for (const scenario of AX_SCENARIOS) {
		const state = readiness(scenario, env, present);
		// Probes absent from THIS tree must be reported as missingProbes; the integration
		// files turn a declared snapshot with missing probes into a hard failure, never a skip.
		const expectedMissing = scenario.composite.probes.filter((relative) => !existsSync(join(extensionRoot, relative)));
		assert.deepEqual(state.missingProbes, expectedMissing, `${scenario.id} must report exactly the absent probe files`);
	}
	assert.equal(readiness(scenarioById("AX1"), env, present).compositeDeclared, true);
});

test("AxEventClock barrier order is strict and queryable", () => {
	const clock = new AxEventClock();
	const a = clock.next("A.accepted");
	const c = clock.next("C.started");
	const b = clock.next("B.finished");
	assert.ok(a < c && c < b);
	assert.equal(barrierSatisfied(clock, [["A.accepted", "C.started"], ["C.started", "B.finished"]]), true);
	assert.equal(barrierSatisfied(clock, [["B.finished", "A.accepted"]]), false);
	assert.throws(() => clock.order("never-recorded"), /no event labeled/);
});

test("CoverageRecorder never aggregates skip/not-run/blocked to pass (G7)", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi861-ax-harness-test-"));
	try {
		const recorder = new CoverageRecorder("AX1", dir);
		recorder.record("fixture step", "pass").record("composite step", "not-run");
		let snapshot = recorder.snapshot(false);
		assert.equal(snapshot.status, "incomplete");
		assert.equal(snapshot.outcomes.pass, 1);
		assert.equal(snapshot.outcomes["not-run"], 1);
		// Even with every recorded step passing, an undeclared composite snapshot cannot pass.
		const clean = new CoverageRecorder("AX1", dir);
		clean.record("only step", "pass");
		assert.equal(clean.snapshot(false).status, "incomplete");
		assert.equal(clean.snapshot(true).status, "passed");
		const failing = new CoverageRecorder("AX1", dir);
		failing.record("boom", "fail");
		assert.equal(failing.snapshot(true).status, "failed");
		const blocked = new CoverageRecorder("AX7", dir);
		blocked.record("reference+refine combination", "blocked");
		assert.equal(blocked.snapshot(true).status, "incomplete");
		// review-1 F1 regression: an EMPTY ledger must never aggregate to "passed", even with a
		// declared composite snapshot - [].every() is vacuously true, no recorded step = no
		// proof. This is the fake-green hole the reviewer reproduced on the pre-fix harness.
		const emptyDeclared = new CoverageRecorder("AX5", dir);
		assert.equal(emptyDeclared.snapshot(true).status, "incomplete");
		assert.equal(emptyDeclared.snapshot(false).status, "incomplete");
		assert.deepEqual(emptyDeclared.snapshot(true).requiredChecks, []);
		assert.throws(() => recorder.record("bad", "nope"), /unknown outcome/);
		const written = new CoverageRecorder("AX9", dir);
		written.record("step", "pass");
		const { path, payload } = written.write(true);
		assert.equal(existsSync(path), true);
		assert.equal(payload.suite, "ax");
		assert.equal(payload.version, 1);
		assert.deepEqual(
			payload.requiredChecks.map((check) => check.id),
			["step"],
		);
		assert.ok(OUTCOMES.every((outcome) => Object.hasOwn(payload.outcomes, outcome)));
		assert.ok(readFileSync(path, "utf8").endsWith("\n"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("coverageRow renders the matrix with dependency columns", () => {
	const absent = Object.fromEntries(Object.keys(P1Q_FIXTURES).map((name) => [name, false]));
	const row = coverageRow(scenarioById("AX7"), readiness(scenarioById("AX7"), {}, absent));
	assert.ok(row.startsWith("AX7\t"));
	assert.ok(row.includes("pg17"));
	assert.ok(row.includes("missing:pg17"));
	assert.ok(row.includes("env:PI861_PG17_TESTS"));
});
