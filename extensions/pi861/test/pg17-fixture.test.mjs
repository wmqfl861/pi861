import assert from "node:assert/strict";
import { test } from "node:test";
import { pg17OptedIn, pg17VersionGate, requirePg17, startPg17Fixture } from "./fixtures/pg17.mjs";

// P1-Q PG17 fixture coverage (K4 gate logic). The version gate is what makes a wrong-version
// database an EXPLICIT FAILURE for dependent tests - never a skip and never a pass. The real
// container only starts with the explicit PI861_PG17_TESTS=1 opt-in (default off); when opted
// in but the environment cannot provide a container or a 17.x server, this file fails.

test("version gate accepts PostgreSQL 17 only", () => {
	assert.deepEqual(pg17VersionGate(170000), { ok: true, reason: "PostgreSQL 17" });
	assert.deepEqual(pg17VersionGate(179999), { ok: true, reason: "PostgreSQL 17" });
	for (const wrong of [160005, 180000, 180004, 200000])
		assert.equal(pg17VersionGate(wrong).ok, false, `server_version_num ${wrong} must not pass the gate`);
	assert.equal(pg17VersionGate(Number.NaN).ok, false);
	assert.equal(requirePg17(170004), true);
	assert.equal(requirePg17(170000), true);
});

test("wrong PostgreSQL versions fail explicitly instead of skipping (K4 counterexample)", () => {
	// A dependent test calls requirePg17 with the probed server_version_num; anything outside
	// [170000, 180000) must throw so the test reports a failure, not a pass or skip.
	assert.throws(() => requirePg17(180004), /server_version_num 180004 is outside \[170000, 180000\); PG17 acceptance fails instead of skipping/);
	assert.throws(() => requirePg17(160005), /server_version_num 160005 is outside \[170000, 180000\); PG17 acceptance fails instead of skipping/);
	assert.throws(() => requirePg17(undefined), /not an integer/);
	assert.throws(() => requirePg17("170004"), /not an integer/);
});

test("the container fixture stays default-off without the explicit opt-in", async () => {
	if (pg17OptedIn()) return; // opted-in environments exercise the real container in the test below
	await assert.rejects(startPg17Fixture(), /default-off; set PI861_PG17_TESTS=1/);
});

test("opted-in environments get a real restricted PostgreSQL 17 container", { skip: false }, async (t) => {
	if (!pg17OptedIn()) {
		// Default environment: the real-container assertions are not silently skipped as passes;
		// the gate coverage above already ran. Nothing here reports a pass of the real database.
		return;
	}
	const fixture = await startPg17Fixture();
	t.after(async () => {
		await fixture.stop();
	});
	assert.ok(fixture.serverVersionNum >= 170000 && fixture.serverVersionNum < 180000, `server_version_num ${fixture.serverVersionNum}`);
	assert.equal(fixture.assertVersion17(), true);
	assert.equal(await fixture.runtimeRoleIsRestricted(), true);
	assert.ok(fixture.containerName.startsWith("pi861-pg17-"));
	assert.deepEqual(Object.keys(fixture.connectionEnv).sort(), ["PI861_TEST_PG_DATABASE", "PI861_TEST_PG_HOST", "PI861_TEST_PG_PASSWORD", "PI861_TEST_PG_PORT", "PI861_TEST_PG_USER"]);
	assert.deepEqual(Object.keys(fixture.migrationEnv).sort(), ["PI861_TEST_PG_DATABASE", "PI861_TEST_PG_HOST", "PI861_TEST_PG_MIGRATION_PASSWORD", "PI861_TEST_PG_MIGRATION_USER", "PI861_TEST_PG_PORT"]);
	assert.notEqual(fixture.connectionEnv.PI861_TEST_PG_USER, fixture.migrationEnv.PI861_TEST_PG_MIGRATION_USER);
});

test("five consecutive real-container fixture startups all pass (p1q review-2 N1 race regression)", { skip: false }, async () => {
	if (!pg17OptedIn()) {
		// Default environment: the race regression needs fresh containers; nothing here
		// reports a pass of the real database when the opt-in is absent.
		return;
	}
	// The readiness race (review-2 N1) fired at fixture STARTUP - waitForReady mistook the
	// image's temporary initdb server for ready and CREATE ROLE failed in the restart gap.
	// Five fresh-volume startups (each with its own initdb window) must all come up clean.
	for (let attempt = 1; attempt <= 5; attempt++) {
		const fixture = await startPg17Fixture();
		try {
			assert.ok(fixture.serverVersionNum >= 170000 && fixture.serverVersionNum < 180000, `attempt ${attempt}: server_version_num ${fixture.serverVersionNum}`);
			assert.equal(fixture.assertVersion17(), true, `attempt ${attempt}: version gate`);
			assert.equal(await fixture.runtimeRoleIsRestricted(), true, `attempt ${attempt}: restricted runtime role`);
		} finally {
			await fixture.stop();
		}
	}
});
