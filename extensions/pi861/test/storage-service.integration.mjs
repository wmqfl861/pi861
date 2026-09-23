/**
 * P2-D storage service integration (K4). Creates only uniquely named schemas and
 * roles in a loopback database named pi861_test; never point this at a real
 * database. Requires:
 *   PI861_TEST_POSTGRES_URL          loopback URL with database /pi861_test
 *   PI861_ALLOW_TEST_DATABASE=1      explicit consent
 *   PI861_TEST_DRIVER_ROOT           operator-owned pg driver root (optional for fixtures)
 *   PI861_TEST_TLS_URL / _URL_IP / PI861_TEST_TLS_CA / PI861_TEST_TLS_WRONG_CA
 *                                    TLS paths against a TLS-enabled test server (optional
 *                                    block; the K4 run provides them)
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import { digest } from "../src/contracts/hash.ts";
import { formatScope } from "../src/contracts/identity.ts";
import { BudgetExhausted, ProbeInFlight } from "../src/contracts/budget.ts";
import { IdempotencyConflict } from "../src/contracts/storage.ts";
import { postgresPoolOptions } from "../src/live/postgres-configuration.ts";
import {
	LeaseNotHeld,
	ServiceAuthenticationError,
	ServicePrincipalDirectory,
	StorageService,
	migrateStorage,
	provisionServicePrincipal,
} from "../src/live/storage-service.ts";
import { recordFingerprints } from "../src/memory-records.ts";

const configured = Boolean(process.env.PI861_TEST_POSTGRES_URL);

function driverRequire() {
	const driverRoot = process.env.PI861_TEST_DRIVER_ROOT;
	return createRequire(driverRoot ? join(driverRoot, "package.json") : import.meta.url);
}

test("storage service: identity, scopes, budgets, leases, withdrawal and the HTTP entry", { skip: !configured }, async (t) => {
	if (process.env.PI861_ALLOW_TEST_DATABASE !== "1") throw new Error("Explicit test database consent is required");
	const url = new URL(process.env.PI861_TEST_POSTGRES_URL);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/pi861_test")
		throw new Error("Only a loopback pi861_test database is permitted");
	const { Pool } = driverRequire()("pg");
	const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
	const schema = `pi861_p2d_${suffix}`;
	const migrationRole = `pi861_p2d_m_${suffix}`;
	const runtimeRole = `pi861_p2d_r_${suffix}`;
	const identityRole = `pi861_p2d_i_${suffix}`;
	const password = randomUUID();
	const admin = new Pool({ connectionString: url.toString(), max: 4 });
	const backupDir = await mkdtemp(join(tmpdir(), "pi861-p2d-backup-"));
	let runtime;
	let identity;
	let migration;
	t.after(async () => {
		if (runtime) await runtime.end().catch(() => {});
		if (identity) await identity.end().catch(() => {});
		if (migration) await migration.end().catch(() => {});
		await admin
			.query("DELETE FROM pi861_service_principals WHERE principal_id LIKE $1", [`p2d-${suffix}%`])
			.catch(() => {});
		await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
		for (const role of [identityRole, runtimeRole, migrationRole])
			await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
		await admin.end().catch(() => {});
		await rm(backupDir, { recursive: true, force: true });
	});
	await admin.query(`CREATE ROLE "${migrationRole}" LOGIN PASSWORD '${password}' NOSUPERUSER BYPASSRLS`);
	await admin.query(`CREATE ROLE "${runtimeRole}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
	await admin.query(`CREATE ROLE "${identityRole}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
	await admin.query(`CREATE SCHEMA "${schema}" AUTHORIZATION "${migrationRole}"`);
	const roleUrl = (role) => {
		const copy = new URL(url);
		copy.username = role;
		copy.password = password;
		return copy.toString();
	};
	migration = new Pool({ connectionString: roleUrl(migrationRole), options: `-c search_path=${schema}`, max: 2 });
	await migration.query(await readFile(new URL("../sql/memory-v1.sql", import.meta.url), "utf8"));
	await migration.query(await readFile(new URL("../sql/runtime-v2.sql", import.meta.url), "utf8"));

	await t.test("versioned migration applies memory-v3 + storage-v4, writes backup and conflict report", async () => {
		const result = await migrateStorage(migration, {
			writersStopped: true,
			backupPath: join(backupDir, "storage-backup.json"),
			conflictReportPath: join(backupDir, "conflict-report.json"),
			memory: { backupPath: join(backupDir, "memory-backup.json"), sources: [], runtimeSources: [] },
		});
		assert.deepEqual(result.applied.sort(), ["memory-v3", "storage-v4"]);
		assert.equal(result.replayed, false);
		const report = JSON.parse(await readFile(join(backupDir, "conflict-report.json"), "utf8"));
		assert.deepEqual(report.conflicts, []);
		const envelope = JSON.parse(await readFile(join(backupDir, "storage-backup.json"), "utf8"));
		assert.equal(typeof envelope.digest, "string");
		const replay = await migrateStorage(migration, {
			writersStopped: true,
			backupPath: join(backupDir, "storage-backup-2.json"),
			conflictReportPath: join(backupDir, "conflict-report-2.json"),
		});
		assert.equal(replay.replayed, true);
		assert.deepEqual(replay.skipped.sort(), ["memory-v3", "storage-v4"]);
	});

	// Provisioning + grants: migration role owns the schema, runtime role gets scoped
	// table grants, identity role can only read the directory.
	await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}"`);
	await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${runtimeRole}"`);
	await admin.query(
		`REVOKE INSERT, UPDATE ON "${schema}".pi861_schema_migrations, "${schema}".pi861_memory_imports, "${schema}".pi861_memory_legacy_receipts FROM "${runtimeRole}"`,
	);
	await admin.query(`GRANT DELETE ON "${schema}".pi861_memory_projections, "${schema}".pi861_memory_jobs TO "${runtimeRole}"`);
	await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${runtimeRole}"`);
	// The identity directory must stay unreachable for the runtime role.
	await admin.query(`REVOKE ALL ON "${schema}".pi861_service_principals FROM "${runtimeRole}"`);
	await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${identityRole}"`);
	await admin.query(`GRANT SELECT ON "${schema}".pi861_service_principals TO "${identityRole}"`);
	const workerToken = randomUUID();
	const narrowToken = randomUUID();
	await provisionServicePrincipal(migration, {
		principalId: `p2d-${suffix}-worker`,
		tenantId: "t1",
		readScopes: ["project:p1", "project:p2"],
		writeScopes: ["project:p1", "project:p2"],
		token: workerToken,
	});
	await provisionServicePrincipal(migration, {
		principalId: `p2d-${suffix}-narrow`,
		tenantId: "t1",
		readScopes: ["project:p1"],
		writeScopes: ["project:p1"],
		token: narrowToken,
	});
	runtime = new Pool({ connectionString: roleUrl(runtimeRole), options: `-c search_path=${schema}`, max: 4 });
	identity = new Pool({ connectionString: roleUrl(identityRole), options: `-c search_path=${schema}`, max: 2 });
	const service = new StorageService(runtime, new ServicePrincipalDirectory(identity));
	await service.ready();
	const session = await service.session(workerToken);
	const write = (requestId, changes = {}, revision = null) => ({
		requestId,
		expectedRevision: revision,
		item: {
			id: "m1",
			scope: "project:p1",
			kind: "project",
			abstract: "alpha",
			overview: "alpha overview",
			full: "alpha original evidence",
			status: "confirmed",
			source: { kind: "user", ref: `event:${requestId}` },
			...changes,
		},
	});

	await t.test("authentication resolves server-side; unknown tokens are rejected", async () => {
		await assert.rejects(service.session("not-a-token"), ServiceAuthenticationError);
		assert.equal(session.identity.principalId, `p2d-${suffix}-worker`);
	});

	await t.test("self-asserted scopes cannot widen authorization (cross-scope deny)", async () => {
		// The wire format has no scope field at all; the identity decides. A principal
		// whose directory entry lacks project:p3 cannot write there, and one without
		// project:p2 sees nothing from it: no items, no search hits, no listings.
		await assert.rejects(session.put(write("x-scope", { scope: "project:p3" })), /Memory scope not authorized/);
		const narrow = await service.session(narrowToken);
		assert.equal(await narrow.get("project:p2", "anything"), undefined);
		assert.equal((await narrow.search("marker")).length, 0);
		assert.deepEqual((await narrow.list("project:p2")).items, []);
	});

	await t.test("requestId idempotency: identical content replays, different intent conflicts", async () => {
		const first = await session.put(write("r1"));
		assert.deepEqual(await session.put(write("r1")), first);
		await assert.rejects(session.put(write("r1", { full: "different intent" })), IdempotencyConflict);
	});

	await t.test("concurrent compare-and-set leaves exactly one winner", async () => {
		const outcomes = await Promise.allSettled([
			session.put(write("r2", { full: "second A" }, 1)),
			session.put(write("r3", { full: "second B" }, 1)),
		]);
		assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
		assert.equal((await session.get("project:p1", "m1")).revision, 2);
	});

	await t.test("withdrawal propagates recursively through the derivation chain", async () => {
		// A dedicated source with a fixed provenance ref, so revival assertions are
		// deterministic regardless of which CAS writer won the previous subtest.
		await session.put(write("w-src", { id: "src", full: "source evidence" }));
		const direct = {
			id: "derived-direct",
			scope: { kind: "project", key: "p2" },
			purpose: "experience",
			abstract: "summary of source",
			overview: "summary of source overview",
			full: "derived from the source record",
			provenance: [{ sourceKind: "tool", ref: "event:w-src", at: Date.now() }],
			derivedFrom: [{ scope: "project:p1", id: "src", revision: 1 }],
			revision: 1,
			status: "candidate",
			updatedAt: Date.now(),
		};
		const transitive = {
			...direct,
			id: "derived-transitive",
			abstract: "summary of the summary",
			full: "derived from the derived record",
			derivedFrom: [{ scope: "project:p2", id: "derived-direct", revision: 1 }],
		};
		for (const record of [direct, transitive]) {
			const scopeKey = formatScope(record.scope);
			await migration.query(
				"INSERT INTO pi861_memory_items(tenant_id,scope_key,memory_id,revision,body,fingerprint) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
				["t1", scopeKey, record.id, record.revision, JSON.stringify(record), recordFingerprints(record)[0]],
			);
			await migration.query(
				"INSERT INTO pi861_memory_versions(tenant_id,scope_key,memory_id,revision,body) VALUES($1,$2,$3,$4,$5::jsonb)",
				["t1", scopeKey, record.id, record.revision, JSON.stringify(record)],
			);
		}
		await session.withdraw("w1", "project:p1", "src", 1);
		assert.equal(await session.get("project:p1", "src"), undefined);
		assert.equal(await session.get("project:p2", "derived-direct"), undefined);
		assert.equal(await session.get("project:p2", "derived-transitive"), undefined);
		const events = await session.claimEvents(100);
		const withdrawals = events.filter((event) => event.action === "withdraw");
		assert.deepEqual(
			withdrawals.map((event) => `${event.scope}/${event.id}`).sort(),
			["project:p1/src", "project:p2/derived-direct", "project:p2/derived-transitive"],
		);
		for (const event of withdrawals) await session.completeEvent(event.sequence, "dispatched");
		// Completed events leave the pending feed; earlier put events stay pending.
		const remaining = await session.claimEvents(100);
		assert.equal(remaining.filter((event) => event.action === "withdraw").length, 0);
		// Old sources cannot revive withdrawn content through a new put: the source
		// fingerprint is tombstoned even when the text is paraphrased.
		await assert.rejects(
			session.put(write("revive", { id: "revived", full: "paraphrased old event", source: { kind: "user", ref: "event:w-src" } })),
			/Withdrawn/,
		);
	});

	await t.test("budget transactions: reserve, settle, unknown usage, exhaustion, probe single-flight", async () => {
		const limits = { maxTotalCostUsd: 1, maxAttempts: 100, maxInputTokens: 1000, maxOutputTokens: 1000 };
		const { budgetId } = await session.createBudget(limits, `budget-${suffix}`);
		await session.registerBudgetTask(budgetId, "task-a", null);
		const reservation = await session.reserveBudget(budgetId, "task-a", "execution", {
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.1,
		});
		await session.settleBudget(budgetId, reservation.reservationId, {
			inputTokens: 90,
			outputTokens: 40,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.08,
		});
		const unknown = await session.reserveBudget(
			budgetId,
			"task-a",
			"probe",
			{ inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
			{ probeKey: `probe-${suffix}` },
		);
		await assert.rejects(
			session.reserveBudget(
				budgetId,
				null,
				"probe",
				{ inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
				{ probeKey: `probe-${suffix}` },
			),
			ProbeInFlight,
		);
		await session.settleBudgetUnknown(budgetId, unknown.reservationId, {
			inputTokens: 5,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			costUsd: 0.01,
		});
		const usage = await session.budgetUsage(budgetId);
		assert.equal(usage.attempts, 2);
		assert.equal(usage.unknownSettlements, 1);
		assert.ok(usage.usage.costUsd > 0);
		assert.equal(usage.openReservations.length, 0);
		await assert.rejects(
			session.reserveBudget(budgetId, null, "execution", {
				inputTokens: 5000,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				costUsd: 0,
			}),
			BudgetExhausted,
		);
	});

	await t.test("leases: acquisition excludes, generations are monotonic, expiry recovers, commits fence", async () => {
		const purpose = `integration-${suffix}`;
		const first = await session.acquireLease(purpose, "worker-1", 60_000);
		assert.equal(first.generation, 1);
		await assert.rejects(session.acquireLease(purpose, "worker-2", 60_000), LeaseNotHeld);
		await session.renewLease(purpose, first.token, 60_000);
		await session.releaseLease(purpose, first.token);
		await assert.rejects(session.releaseLease(purpose, first.token), LeaseNotHeld);
		const second = await session.acquireLease(purpose, "worker-2", 60_000);
		assert.equal(second.generation, 2);
		assert.equal(await session.leaseValidAt(purpose, second.generation), true);
		assert.equal(await session.leaseValidAt(purpose, first.generation), false);
		// Backdate the expiry to simulate a lost holder; a new owner must recover.
		await admin.query(`UPDATE "${schema}".pi861_leases SET expires_at=0 WHERE purpose=$1`, [purpose]);
		const third = await session.acquireLease(purpose, "worker-3", 60_000);
		assert.equal(third.generation, 3);
		assert.equal(await session.leaseValidAt(purpose, second.generation), false);
	});

	await t.test("runtime and identity roles are separated accounts with separated grants", async () => {
		await assert.rejects(
			migrateStorage(runtime, {
				writersStopped: true,
				backupPath: join(backupDir, "runtime-backup.json"),
				conflictReportPath: join(backupDir, "runtime-report.json"),
			}),
			/BYPASSRLS/,
		);
		await assert.rejects(runtime.query("SELECT * FROM pi861_service_principals"), /permission denied/);
		await assert.rejects(identity.query(`SELECT * FROM "${schema}".pi861_memory_items`), /permission denied/);
		await assert.rejects(runtime.query(`CREATE TABLE "${schema}".pi861_forbidden(id text)`), /permission denied/);
	});

	await t.test("digest mismatch and orphan tables are reported conflicts, never overwritten", async () => {
		await admin.query(`UPDATE "${schema}".pi861_schema_migrations SET digest='tampered' WHERE version='storage-v4'`);
		await assert.rejects(
			migrateStorage(migration, {
				writersStopped: true,
				backupPath: join(backupDir, "digest-backup.json"),
				conflictReportPath: join(backupDir, "digest-report.json"),
			}),
			/digest mismatch/,
		);
		const report = JSON.parse(await readFile(join(backupDir, "digest-report.json"), "utf8"));
		assert.ok(report.conflicts.some((entry) => entry.includes("digest mismatch")));
		// Remove the ledger row: the tenant tables now exist without it, which is a
		// conflict; nothing is overwritten. Restore the ledger afterwards so later
		// subtests (the HTTP entry calls service.ready()) still pass.
		await admin.query(`DELETE FROM "${schema}".pi861_schema_migrations WHERE version='storage-v4'`);
		await assert.rejects(
			migrateStorage(migration, {
				writersStopped: true,
				backupPath: join(backupDir, "orphan-backup.json"),
				conflictReportPath: join(backupDir, "orphan-report.json"),
			}),
			/Orphan storage service tables/,
		);
		const sql = await readFile(new URL("../sql/storage-v4.sql", import.meta.url), "utf8");
		await admin.query(
			`INSERT INTO "${schema}".pi861_schema_migrations(version,name,digest) VALUES('storage-v4','restored',$1)`,
			[digest(sql)],
		);
	});

	await t.test("scripts/storage-service.mjs serves authenticated scoped operations", async () => {
		const driverRoot = process.env.PI861_TEST_DRIVER_ROOT;
		const childEnv = { ...process.env };
		delete childEnv.PI861_TEST_POSTGRES_URL;
		childEnv.PI861_STORAGE_DATA_URL = roleUrl(runtimeRole);
		childEnv.PI861_STORAGE_IDENTITY_URL = roleUrl(identityRole);
		childEnv.PI861_STORAGE_PORT = "0";
		childEnv.PI861_STORAGE_ALLOW_LOCAL_PLAINTEXT = "1";
		childEnv.PI861_STORAGE_SCHEMA = schema;
		if (driverRoot) childEnv.PI861_STORAGE_DRIVER_ROOT = driverRoot;
		else delete childEnv.PI861_STORAGE_DRIVER_ROOT;
		const child = spawn(process.execPath, ["--experimental-strip-types", join(import.meta.dirname, "../scripts/storage-service.mjs")], {
			env: childEnv,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const port = await new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(`storage service did not start: ${stderr}`)), 30_000);
			child.stdout.on("data", (chunk) => {
				const match = /pi861-storage-service listening 127\.0\.0\.1:(\d+)/.exec(String(chunk));
				if (match) {
					clearTimeout(timer);
					resolve(Number(match[1]));
				}
			});
			child.on("exit", (code) => reject(new Error(`storage service exited early (${code}): ${stderr}`)));
		});
		try {
			const base = `http://127.0.0.1:${port}`;
			const call = (token, body) =>
				fetch(base, {
					method: "POST",
					headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
					body: JSON.stringify(body),
				});
			const put = await call(workerToken, { op: "put", args: write("http-put", { id: "http-item" }) });
			assert.equal(put.status, 200);
			const { ok, result } = await put.json();
			assert.equal(ok, true);
			assert.equal(result.revision, 1);
			const replay = await (await call(workerToken, { op: "put", args: write("http-put", { id: "http-item" }) })).json();
			assert.deepEqual(replay.result, result);
			const conflict = await call(workerToken, { op: "put", args: write("http-put", { id: "http-item", full: "other" }) });
			assert.equal(conflict.status, 409);
			const unauthorized = await call("wrong-token", { op: "get", args: { scope: "project:p1", id: "http-item" } });
			assert.equal(unauthorized.status, 401);
			const crossScope = await call(workerToken, { op: "put", args: write("http-x", { scope: "project:p3" }) });
			assert.equal(crossScope.status, 400);
			assert.match((await crossScope.json()).error.message, /scope not authorized/);
			const recovered = await (
				await call(workerToken, { op: "get", args: { scope: "project:p1", id: "http-item" } })
			).json();
			assert.equal(recovered.result.full, "alpha original evidence");
		} finally {
			child.kill("SIGTERM");
			await new Promise((resolve) => child.on("exit", resolve));
		}
	});

	await t.test("database TLS: trusted CA connects, wrong CA and hostname mismatch fail", { skip: !process.env.PI861_TEST_TLS_URL }, async () => {
		const connect = async (urlEnv, options) => {
			const pool = new Pool(postgresPoolOptions({ urlEnv, ...options }, process.env));
			pool.on("error", () => {});
			try {
				return await pool.query("SELECT 1 AS one");
			} finally {
				await pool.end().catch(() => {});
			}
		};
		assert.equal((await connect("PI861_TEST_TLS_URL", { caFile: process.env.PI861_TEST_TLS_CA })).rows[0].one, 1);
		await assert.rejects(connect("PI861_TEST_TLS_URL", { caFile: process.env.PI861_TEST_TLS_WRONG_CA }));
		// Hostname verification follows the connect host for DNS names (pg pins
		// servername to it); a loopback name the certificate does not cover must fail.
		await assert.rejects(connect("PI861_TEST_TLS_MISMATCH_URL", { caFile: process.env.PI861_TEST_TLS_CA }));
	});

	const version = await admin.query("SHOW server_version");
	const versionNum = await admin.query("SHOW server_version_num");
	t.diagnostic(
		`server ${String(version.rows[0].server_version)} (server_version_num ${String(versionNum.rows[0].server_version_num)}); roles: runtime NOBYPASSRLS, identity directory-only, migration BYPASSRLS`,
	);
});
