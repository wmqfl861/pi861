/**
 * P2-M memory governance integration (K4-related). Runs automatic memory
 * governance against a real PostgreSQL authority through the P2-D storage
 * service: cross-session lifecycle assembly, durable controlled references
 * with cross-node revocation, withdrawal during distillation, and requestId
 * receipt recovery. Creates only uniquely named schemas and roles in a
 * loopback database named pi861_test; never point this at a real database.
 * Requires:
 *   PI861_TEST_POSTGRES_URL        loopback URL with database /pi861_test
 *   PI861_ALLOW_TEST_DATABASE=1    explicit consent
 *   PI861_TEST_DRIVER_ROOT         operator-owned pg driver root (optional)
 *   PI861_TEST_EXPECT_PG_MAJOR     when set, the server major version must match
 *                                  (K4 requires 17; 18.x runs record honestly as
 *                                  a blocked-17 substitute, never as PG17 proof)
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { test } from "node:test";
import { IdempotencyConflict } from "../src/contracts/storage.ts";
import { digest } from "../src/memory.ts";
import { attachMemoryGovernance } from "../src/live/memory-service.ts";
import { FileStateStore } from "../src/live/store.ts";
import {
	ServicePrincipalDirectory,
	StorageService,
	migrateStorage,
	provisionServicePrincipal,
} from "../src/live/storage-service.ts";

const configured = Boolean(process.env.PI861_TEST_POSTGRES_URL);
const scope = "project:p1";

function driverRequire() {
	const driverRoot = process.env.PI861_TEST_DRIVER_ROOT;
	return createRequire(driverRoot ? join(driverRoot, "package.json") : import.meta.url);
}

test("governance over real PostgreSQL: assembly, references, withdrawal, receipts", { skip: !configured }, async (t) => {
	if (process.env.PI861_ALLOW_TEST_DATABASE !== "1") throw new Error("Explicit test database consent is required");
	const url = new URL(process.env.PI861_TEST_POSTGRES_URL);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/pi861_test")
		throw new Error("Only a loopback pi861_test database is permitted");
	const { Pool } = driverRequire()("pg");
	const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
	const schema = `pi861_p2m_${suffix}`;
	const migrationRole = `pi861_p2m_m_${suffix}`;
	const runtimeRole = `pi861_p2m_r_${suffix}`;
	const identityRole = `pi861_p2m_i_${suffix}`;
	const password = randomUUID();
	const admin = new Pool({ connectionString: url.toString(), max: 4 });
	const backupDir = await mkdtemp(join(tmpdir(), "pi861-p2m-backup-"));
	const pendingDir = await mkdtemp(join(tmpdir(), "pi861-p2m-pending-"));
	let runtime;
	let identity;
	let migration;
	t.after(async () => {
		if (runtime) await runtime.end().catch(() => {});
		if (identity) await identity.end().catch(() => {});
		if (migration) await migration.end().catch(() => {});
		await admin
			.query("DELETE FROM pi861_service_principals WHERE principal_id LIKE $1", [`p2m-${suffix}%`])
			.catch(() => {});
		await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
		for (const role of [identityRole, runtimeRole, migrationRole])
			await admin.query(`DROP ROLE IF EXISTS "${role}"`).catch(() => {});
		await admin.end().catch(() => {});
		await rm(backupDir, { recursive: true, force: true });
		await rm(pendingDir, { recursive: true, force: true });
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
	await migrateStorage(migration, {
		writersStopped: true,
		backupPath: join(backupDir, "storage-backup.json"),
		conflictReportPath: join(backupDir, "conflict-report.json"),
		memory: { backupPath: join(backupDir, "memory-backup.json"), sources: [], runtimeSources: [] },
	});
	await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${runtimeRole}"`);
	await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${runtimeRole}"`);
	await admin.query(
		`REVOKE INSERT, UPDATE ON "${schema}".pi861_schema_migrations, "${schema}".pi861_memory_imports, "${schema}".pi861_memory_legacy_receipts FROM "${runtimeRole}"`,
	);
	await admin.query(`GRANT DELETE ON "${schema}".pi861_memory_projections, "${schema}".pi861_memory_jobs TO "${runtimeRole}"`);
	await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${runtimeRole}"`);
	await admin.query(`REVOKE ALL ON "${schema}".pi861_service_principals FROM "${runtimeRole}"`);
	await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${identityRole}"`);
	await admin.query(`GRANT SELECT ON "${schema}".pi861_service_principals TO "${identityRole}"`);

	const nodeAToken = randomUUID();
	const nodeBToken = randomUUID();
	await provisionServicePrincipal(migration, {
		principalId: `p2m-${suffix}-a`,
		tenantId: "t1",
		readScopes: [scope],
		writeScopes: [scope],
		token: nodeAToken,
	});
	await provisionServicePrincipal(migration, {
		principalId: `p2m-${suffix}-b`,
		tenantId: "t1",
		readScopes: [scope],
		writeScopes: [scope],
		token: nodeBToken,
	});
	runtime = new Pool({ connectionString: roleUrl(runtimeRole), options: `-c search_path=${schema}`, max: 4 });
	identity = new Pool({ connectionString: roleUrl(identityRole), options: `-c search_path=${schema}`, max: 2 });
	const service = new StorageService(runtime, new ServicePrincipalDirectory(identity));
	await service.ready();

	const version = await runtime.query("SHOW server_version_num");
	const serverVersionNum = Number(version.rows[0].server_version_num);
	t.diagnostic(`server_version_num=${serverVersionNum}`);
	const expectedMajor = Number(process.env.PI861_TEST_EXPECT_PG_MAJOR ?? 0);
	if (expectedMajor > 0) assert.equal(Math.floor(serverVersionNum / 10000), expectedMajor, "PI861_TEST_EXPECT_PG_MAJOR mismatch");
	else if (serverVersionNum < 170000 || serverVersionNum >= 180000)
		t.diagnostic(`NOTE: K4 requires PG17 [170000,180000); running on ${serverVersionNum} is evidence for that version only`);

	// Two sessions model two nodes; each gets its own single-collector governance.
	const sessionA = await service.session(nodeAToken);
	const sessionB = await service.session(nodeBToken);
	const governanceFor = (session, name) =>
		attachMemoryGovernance({}, {
			authority: session.memory,
			pending: new FileStateStore(join(pendingDir, `${name}-pending.json`), { version: 1, entries: [] }),
			scope,
			// The reference owner is the entitled reader identity shared by every
			// node of the agent, not a per-node value.
			owner: "agent:shared",
		});
	const nodeA = governanceFor(sessionA, "a");
	const nodeB = governanceFor(sessionB, "b");

	await t.test("cross-node lifecycle assembly (AX7): node B assembles what node A captured", async () => {
		const outcome = await nodeA.captureUserStatement({
			sessionId: "s-node-a",
			sequence: 1,
			text: "跨节点约束：发布前必须运行完整检查链",
			kind: "constraint",
		});
		assert.equal(outcome.status, "captured");
		const assembled = await nodeB.assembleContext("node-switch");
		assert.ok(assembled.text.includes("跨节点约束"), "constraint is installed directly, without a keyword query");
		assert.ok(assembled.included.some((entry) => entry.kind === "constraint" && entry.level === 2));
		const recall = await nodeB.recallContext();
		assert.ok(recall.text.includes("跨节点约束"));
	});

	await t.test("durable references cross nodes and revocation is immediate on both", async () => {
		const payload = "w".repeat(80_000);
		const outcome = await nodeA.captureToolExecutionEnd({
			sessionId: "s-node-a",
			toolCallId: "call-big",
			toolName: "web.read",
			result: payload,
		});
		assert.equal(outcome.status, "referenced");
		const record = await sessionA.get(scope, outcome.id);
		const resultRef = JSON.parse(record.full).resultRef;
		// Node B pages the same reference through its own session.
		let text = "";
		let offset = 0;
		for (;;) {
			const page = await nodeB.readResultReference(resultRef, offset);
			text += page.text;
			offset = page.nextOffset;
			if (page.complete) break;
		}
		assert.equal(JSON.parse(text).result, payload);
		// Revocation on node A withdraws the manifest and chunks; node B fails uniformly at once.
		assert.equal(await nodeA.revokeResultReference("revoke-big", resultRef), 2);
		await assert.rejects(nodeB.readResultReference(resultRef), /Result not found/);
	});

	await t.test("durable references survive a raw authority distillation pass (review-1 F1)", async () => {
		const payload = "v".repeat(80_000);
		const outcome = await nodeA.captureToolExecutionEnd({
			sessionId: "s-raw",
			toolCallId: "call-raw",
			toolName: "web.read",
			result: payload,
		});
		assert.equal(outcome.status, "referenced");
		const resultRef = JSON.parse((await sessionA.get(scope, outcome.id)).full).resultRef;
		// Raw PostgresMemory.enrich bypasses the governance wrapper and really
		// projects the chunk/manifest records of the reference. maxJobs covers the
		// jobs still queued from earlier subtests so the new reference's records
		// are guaranteed to be projected in this pass.
		const raw = await sessionA.memory.enrich(
			{
				modelId: "fixture",
				async extract() {
					return { abstract: "模型摘要", overview: "投影覆盖了原字段。", facts: [] };
				},
			},
			{ signal: new AbortController().signal, timeoutMs: 15_000, maxJobs: 10 },
		);
		assert.ok(raw.completed >= 2, `reference records were projected: ${JSON.stringify(raw)}`);
		// Reads and revocation keep working: the descriptor lives in the manifest
		// record's full body, which projections never replace.
		let text = "";
		for (let offset = 0; ; ) {
			const page = await nodeB.readResultReference(resultRef, offset);
			text += page.text;
			offset = page.nextOffset;
			if (page.complete) break;
		}
		assert.equal(JSON.parse(text).result, payload);
		assert.equal(await nodeA.revokeResultReference("revoke-raw", resultRef), 2);
		await assert.rejects(nodeB.readResultReference(resultRef), /Result not found/);
	});

	await t.test("withdrawal during distillation cannot resurrect content or commit projections", async () => {
		await nodeA.captureUserStatement({
			sessionId: "s-node-a",
			sequence: 2,
			text: "临时工作状态：正在验证撤回边界",
			kind: "working",
		});
		const recordId = digest(["pi861.user", "s-node-a", 2]);
		const stats = await nodeA.distill(
			async (_context, record) => {
				// The model call runs outside the storage lock; withdraw through the
				// other node while the extractor is in flight. Each withdrawal uses
				// its own requestId: reusing one would be an intent conflict.
				const current = await sessionB.get(scope, record.id);
				await sessionB.withdraw(`mid-flight-${record.id}`, scope, record.id, current.revision);
				return { abstract: "迟到摘要", overview: "这个摘要不得发布", facts: [] };
			},
			{ scope, taskId: null },
			"fixture-model",
			{ signal: new AbortController().signal, timeoutMs: 15_000 },
		);
		assert.equal(stats.obsolete >= 1, true, `expected at least one obsolete commit, got ${JSON.stringify(stats)}`);
		assert.equal(stats.completed, 0);
		assert.equal(await sessionA.get(scope, recordId), undefined);
		const jobs = await sessionA.listJobs();
		assert.ok(jobs.every((job) => job.state !== "running"));
	});

	await t.test("requestId receipts: idempotent replay, reconcile, and intent conflicts (AX8)", async () => {
		const observation = { sessionId: "s-node-a", toolCallId: "call-receipt", toolName: "fs.stat", result: { size: 7 } };
		const first = await nodeA.captureToolExecutionEnd(observation);
		assert.equal(first.status, "captured");
		const requestId = digest(["s-node-a", "call-receipt"]);
		// An ambiguous retry of the same intent replays the same receipt.
		const replay = await sessionA.put({
			requestId,
			expectedRevision: null,
			item: {
				id: requestId,
				scope,
				kind: "evidence",
				status: "candidate",
				abstract: `Tool result: fs.stat`,
				overview: JSON.stringify({ tool: "fs.stat", result: { size: 7 }, isError: false }).slice(0, 1000),
				full: JSON.stringify({ tool: "fs.stat", result: { size: 7 }, isError: false }),
				source: { kind: "tool", ref: "pi-session:s-node-a/tool:call-receipt" },
			},
		});
		assert.equal(replay.revision, 1, "same requestId and intent replays the original receipt");
		// Reconcile by requestId: committed with the same receipt; unknown ids are notCommitted.
		const outcome = await nodeA.reconcile(requestId);
		assert.equal(outcome.state, "committed");
		assert.equal(outcome.receipt.requestId, requestId);
		assert.equal((await nodeA.reconcile("never-issued")).state, "notCommitted");
		// A different intent under the same requestId is a conflict, never a second commit.
		await assert.rejects(
			sessionA.put({
				requestId,
				expectedRevision: null,
				item: {
					id: requestId,
					scope,
					kind: "evidence",
					status: "candidate",
					abstract: "divergent",
					overview: "divergent",
					full: "different content entirely",
					source: { kind: "tool", ref: "pi-session:s-node-a/tool:call-receipt" },
				},
			}),
			IdempotencyConflict,
		);
		await assert.rejects(nodeA.reconcile(requestId, `${"0".repeat(64)}`), IdempotencyConflict);
	});

	await t.test("authority outage parks writes locally and flush replays to the real database", async () => {
		let down = false;
		const gated = {
			get: (s, id) => sessionA.get(s, id),
			put: (input) => (down ? Promise.reject(new Error("connection lost")) : sessionA.put(input)),
			withdraw: (requestId, s, id, revision) => sessionA.withdraw(requestId, s, id, revision),
			assemble: (options) => sessionA.memory.assemble(options),
			delta: (...args) => sessionA.memory.delta(...args),
			listJobs: () => sessionA.listJobs(),
			requeueJob: (jobId) => sessionA.memory.requeueJob(jobId),
			enrich: (extractor, options) => sessionA.memory.enrich(extractor, options),
		};
		const pending = new FileStateStore(join(pendingDir, "outage-pending.json"), { version: 1, entries: [] });
		// Same entitled-reader owner as nodeA/nodeB: the reference this writer
		// mints must resolve through nodeB after recovery.
		const governance = attachMemoryGovernance({}, {
			authority: gated,
			pending,
			scope,
			owner: "agent:shared",
			resultPageSize: 128_000,
		});
		down = true;
		const failed = await governance.captureUserStatement({
			sessionId: "s-outage",
			sequence: 1,
			text: "断库期间的用户约束",
			kind: "constraint",
		});
		assert.equal(failed.status, "failed");
		assert.equal(await sessionA.get(scope, digest(["pi861.user", "s-outage", 1])), undefined);
		// Oversized captures share the same pause boundary: the chunk write parks
		// as checkpoint-uncommitted instead of surfacing the raw connection error.
		const bigPayload = "o".repeat(80_000);
		const bigFailed = await governance.captureToolExecutionEnd({
			sessionId: "s-outage",
			toolCallId: "call-outage-big",
			toolName: "web.read",
			result: bigPayload,
		});
		assert.equal(bigFailed.status, "failed");
		assert.match(bigFailed.error, /checkpoint uncommitted/);
		const parked = JSON.parse(await readFile(join(pendingDir, "outage-pending.json"), "utf8"));
		assert.ok(parked.entries.length >= 2, "both the statement and the chunk parked uncommitted");
		assert.ok(parked.entries.every((entry) => entry.state === "uncommitted"));
		down = false;
		const flushed = await governance.flushPending();
		assert.equal(flushed.pending, 0);
		const stored = await sessionB.get(scope, digest(["pi861.user", "s-outage", 1]));
		assert.equal(stored.full, "断库期间的用户约束");
		// Retrying the oversized capture after recovery completes the manifest and
		// descriptor idempotently; the payload reads back through node B.
		const retried = await governance.captureToolExecutionEnd({
			sessionId: "s-outage",
			toolCallId: "call-outage-big",
			toolName: "web.read",
			result: bigPayload,
		});
		assert.equal(retried.status, "referenced");
		const resultRef = JSON.parse((await sessionA.get(scope, retried.id)).full).resultRef;
		let text = "";
		for (let offset = 0; ; ) {
			const page = await nodeB.readResultReference(resultRef, offset);
			text += page.text;
			offset = page.nextOffset;
			if (page.complete) break;
		}
		assert.equal(JSON.parse(text).result, bigPayload);
	});
});
