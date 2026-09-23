/**
 * P2-D PostgreSQL recovery integration (K4): ambiguous commits, database outages,
 * pending local writes and backup restoration into a second temporary schema.
 * Same consent rules as storage-service.integration.mjs: loopback pi861_test only.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { FileStateStore } from "../src/live/store.ts";
import { MemoryCommitPending, PendingMemoryWrites } from "../src/live/memory-pending.ts";
import { migrateMemory, restoreMemoryBackup } from "../src/live/memory-migration.ts";
import { migrateStorage, provisionServicePrincipal, ServicePrincipalDirectory, StorageService } from "../src/live/storage-service.ts";

const configured = Boolean(process.env.PI861_TEST_POSTGRES_URL);

function driverRequire() {
	const driverRoot = process.env.PI861_TEST_DRIVER_ROOT;
	return createRequire(driverRoot ? join(driverRoot, "package.json") : import.meta.url);
}

test("storage recovery: ambiguous commits, outages, pending writes and backup restore", { skip: !configured }, async (t) => {
	if (process.env.PI861_ALLOW_TEST_DATABASE !== "1") throw new Error("Explicit test database consent is required");
	const url = new URL(process.env.PI861_TEST_POSTGRES_URL);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/pi861_test")
		throw new Error("Only a loopback pi861_test database is permitted");
	const { Pool } = driverRequire()("pg");
	const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
	const schema = `pi861_rec_${suffix}`;
	const restoreSchema = `${schema}_restore`;
	const migrationRole = `pi861_rec_m_${suffix}`;
	const runtimeRole = `pi861_rec_r_${suffix}`;
	const identityRole = `pi861_rec_i_${suffix}`;
	const password = randomUUID();
	const admin = new Pool({ connectionString: url.toString(), max: 4 });
	const backupDir = await mkdtemp(join(tmpdir(), "pi861-p2d-recovery-"));
	const pools = [];
	t.after(async () => {
		for (const pool of pools) await pool.end().catch(() => {});
		await admin
			.query("DELETE FROM pi861_service_principals WHERE principal_id LIKE $1", [`rec-${suffix}%`])
			.catch(() => {});
		await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
		await admin.query(`DROP SCHEMA IF EXISTS "${restoreSchema}" CASCADE`).catch(() => {});
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
	const migration = new Pool({ connectionString: roleUrl(migrationRole), options: `-c search_path=${schema}`, max: 2 });
	pools.push(migration);
	await migration.query(await readFile(new URL("../sql/memory-v1.sql", import.meta.url), "utf8"));
	await migration.query(await readFile(new URL("../sql/runtime-v2.sql", import.meta.url), "utf8"));
	await migrateStorage(migration, {
		writersStopped: true,
		backupPath: join(backupDir, "storage-initial.json"),
		conflictReportPath: join(backupDir, "conflicts-initial.json"),
		memory: { backupPath: join(backupDir, "memory-initial.json"), sources: [], runtimeSources: [] },
	});
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
	await provisionServicePrincipal(migration, {
		principalId: `rec-${suffix}-worker`,
		tenantId: "t1",
		readScopes: ["project:p1"],
		writeScopes: ["project:p1"],
		token: workerToken,
	});
	const runtime = new Pool({ connectionString: roleUrl(runtimeRole), options: `-c search_path=${schema}`, max: 4 });
	pools.push(runtime);
	const identity = new Pool({ connectionString: roleUrl(identityRole), options: `-c search_path=${schema}`, max: 2 });
	pools.push(identity);
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

	await t.test("lost COMMIT response reconciles by requestId with a complete snapshot", async () => {
		let lost = true;
		const dropping = {
			async connect() {
				const client = await runtime.connect();
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
		const uncertain = new StorageService(dropping, new ServicePrincipalDirectory(identity));
		const uncertainSession = await uncertain.session(workerToken);
		const request = write("ambiguous");
		await assert.rejects(uncertainSession.put(request), /lost COMMIT/);
		// The database is the single truth: a stored receipt means committed, and the
		// current record travels with it as the complete recovery snapshot.
		const reconciled = await session.reconcile(request.requestId);
		assert.equal(reconciled.state, "committed");
		assert.equal(reconciled.receipt.revision, 1);
		assert.equal(reconciled.record.full, "alpha original evidence");
		assert.deepEqual(await session.put(request), reconciled.receipt);
		for (const table of ["pi861_memory_items", "pi861_memory_versions", "pi861_memory_events", "pi861_memory_receipts"]) {
			const count = await admin.query(`SELECT count(*) AS n FROM "${schema}".${table} WHERE tenant_id='t1'`);
			assert.equal(Number(count.rows[0].n), 1, `${table} must not be duplicated by the replay`);
		}
		const missing = await session.reconcile("never-seen");
		assert.equal(missing.state, "notCommitted");
	});

	await t.test("database outage fails closed; local pending writes stay uncommitted", async () => {
		// A pool pointed at a closed port: the service must fail loudly, never fall
		// back to a local second authority.
		const deadUrl = new URL(roleUrl(runtimeRole));
		deadUrl.port = "1";
		const dead = new Pool({ connectionString: deadUrl.toString(), max: 1, connectionTimeoutMillis: 2000 });
		dead.on("error", () => {});
		pools.push(dead);
		const offline = new StorageService(dead, new ServicePrincipalDirectory(identity));
		const offlineSession = await offline.session(workerToken);
		await assert.rejects(offlineSession.put(write("offline-put", { id: "offline" })));
		// The bounded local delivery queue keeps the entry uncommitted; nothing is
		// readable through any authority until the database accepts it.
		let online = false;
		const queueStore = new FileStateStore(join(backupDir, "pending.json"), { version: 1, entries: [] });
		const queue = new PendingMemoryWrites(queueStore, {
			put: (request) => (online ? session.put(request) : Promise.reject(new Error("database unavailable"))),
		});
		const pending = write("pending-put", { id: "pending", full: "pending evidence" });
		await assert.rejects(queue.put(pending), MemoryCommitPending);
		const queued = await queueStore.read();
		assert.equal(queued.entries[0].state, "uncommitted");
		assert.equal(await session.get("project:p1", "pending"), undefined);
		online = true;
		assert.deepEqual(await queue.flush(), { committed: 1, pending: 0 });
		assert.equal((await session.get("project:p1", "pending")).revision, 1);
		const afterFlush = await queueStore.read();
		assert.ok(afterFlush.entries.every((entry) => entry.state === "committed"));
	});

	await t.test("withdrawal tombstones block old-source revival", async () => {
		await session.put(write("doomed", { id: "doomed", full: "soon withdrawn evidence" }));
		await session.withdraw("doomed-withdraw", "project:p1", "doomed", 1);
		await assert.rejects(
			session.put(write("revive", { id: "revived", full: "paraphrased", source: { kind: "user", ref: "event:doomed" } })),
			/Withdrawn/,
		);
	});

	await t.test("backup restores into a second temporary schema and keeps serving", async () => {
		// Replay the memory migration to take a post-write backup of every table.
		const replayed = await migrateMemory(migration, {
			writersStopped: true,
			backupPath: join(backupDir, "memory-post.json"),
			sources: [],
		});
		assert.equal(replayed.replayed, true);
		await admin.query(`CREATE SCHEMA "${restoreSchema}" AUTHORIZATION "${migrationRole}"`);
		const target = new Pool({ connectionString: roleUrl(migrationRole), options: `-c search_path=${restoreSchema}`, max: 2 });
		pools.push(target);
		await target.query(await readFile(new URL("../sql/memory-v1.sql", import.meta.url), "utf8"));
		await target.query(await readFile(new URL("../sql/runtime-v2.sql", import.meta.url), "utf8"));
		await target.query(await readFile(new URL("../sql/memory-v3.sql", import.meta.url), "utf8"));
		const sources = await restoreMemoryBackup(target, join(backupDir, "memory-post.json"));
		assert.deepEqual(sources, []);
		// The restored ledger still claims storage-v4, but this schema has no v4 tables;
		// the migration must report that conflict instead of trusting the ledger.
		await assert.rejects(
			migrateStorage(target, {
				writersStopped: true,
				backupPath: join(backupDir, "storage-stale.json"),
				conflictReportPath: join(backupDir, "conflicts-stale.json"),
			}),
			/Storage ledger does not match the schema/,
		);
		await target.query("DELETE FROM pi861_schema_migrations WHERE version='storage-v4'");
		const tables = ["pi861_memory_items", "pi861_memory_versions", "pi861_memory_receipts", "pi861_memory_tombstones", "pi861_memory_events"];
		for (const table of tables) {
			const original = await admin.query(`SELECT count(*) AS n FROM "${schema}".${table}`);
			const restored = await target.query(`SELECT count(*) AS n FROM "${restoreSchema}".${table}`);
			assert.equal(Number(restored.rows[0].n), Number(original.rows[0].n), `${table} count must match after restore`);
		}
		const restoredBodies = await target.query(
			`SELECT memory_id, body FROM "${restoreSchema}".pi861_memory_items WHERE tenant_id='t1' ORDER BY memory_id`,
		);
		const originalBodies = await admin.query(
			`SELECT memory_id, body FROM "${schema}".pi861_memory_items WHERE tenant_id='t1' ORDER BY memory_id`,
		);
		assert.deepEqual(restoredBodies.rows, originalBodies.rows);
		// The restored tombstone still blocks revival, and the restored receipt still
		// replays identically once the service ledger is completed with storage-v4.
		await migrateStorage(target, {
			writersStopped: true,
			backupPath: join(backupDir, "storage-restore.json"),
			conflictReportPath: join(backupDir, "conflicts-restore.json"),
		});
		await admin.query(`GRANT USAGE ON SCHEMA "${restoreSchema}" TO "${runtimeRole}"`);
		await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${restoreSchema}" TO "${runtimeRole}"`);
		await admin.query(
			`REVOKE INSERT, UPDATE ON "${restoreSchema}".pi861_schema_migrations, "${restoreSchema}".pi861_memory_imports, "${restoreSchema}".pi861_memory_legacy_receipts FROM "${runtimeRole}"`,
		);
		await admin.query(
			`GRANT DELETE ON "${restoreSchema}".pi861_memory_projections, "${restoreSchema}".pi861_memory_jobs TO "${runtimeRole}"`,
		);
		await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${restoreSchema}" TO "${runtimeRole}"`);
		await admin.query(`REVOKE ALL ON "${restoreSchema}".pi861_service_principals FROM "${runtimeRole}"`);
		const restoredRuntime = new Pool({
			connectionString: roleUrl(runtimeRole),
			options: `-c search_path=${restoreSchema}`,
			max: 2,
		});
		pools.push(restoredRuntime);
		const restoredService = new StorageService(restoredRuntime, new ServicePrincipalDirectory(identity));
		await restoredService.ready();
		const restoredSession = await restoredService.session(workerToken);
		assert.equal((await restoredSession.get("project:p1", "m1")).full, "alpha original evidence");
		assert.equal(await restoredSession.get("project:p1", "doomed"), undefined);
		const receipt = await restoredSession.reconcile("ambiguous");
		assert.equal(receipt.state, "committed");
		assert.equal(receipt.receipt.revision, 1);
		await assert.rejects(
			restoredSession.put(write("restore-revive", { id: "again", full: "again paraphrased", source: { kind: "user", ref: "event:doomed" } })),
			/Withdrawn/,
		);
	});

	const versionNum = await admin.query("SHOW server_version_num");
	const major = Math.floor(Number(versionNum.rows[0].server_version_num) / 10000);
	const expected = process.env.PI861_TEST_EXPECT_PG_MAJOR;
	if (expected !== undefined) assert.equal(major, Number(expected), "unexpected PostgreSQL major version");
	t.diagnostic(`server_version_num ${String(versionNum.rows[0].server_version_num)} (major ${major})`);
});
