import { FileStateStore, PostgresStateStore } from "../src/live/store.ts";
import { PendingMemoryWrites, MemoryCommitPending } from "../src/live/memory-pending.ts";
import { LayeredMemory, emptyLayeredMemory } from "../src/live/layered-memory.ts";
/**
 * Explicit integration test. Creates only a unique test schema and role in
 * a loopback database named pi861_test. Never point this at a real brain.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { migrateMemory, restoreMemoryBackup } from "../src/live/memory-migration.ts";
import { LocalMemory, digest } from "../src/memory.ts";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { PostgresMemory } from "../src/postgres.ts";
const configured = Boolean(process.env.PI861_TEST_POSTGRES_URL);
test("real PostgreSQL: atomic memory, CAS, RLS and withdrawal", { skip: !configured }, async (t) => {
	if (process.env.PI861_ALLOW_TEST_DATABASE !== "1") throw new Error("Explicit test database consent is required");
	const url = new URL(process.env.PI861_TEST_POSTGRES_URL);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/pi861_test") throw new Error("Only a loopback pi861_test database is permitted");
	const driverRoot = process.env.PI861_TEST_DRIVER_ROOT;
	const require = createRequire(driverRoot ? join(driverRoot, "package.json") : import.meta.url);
	const { Pool } = require("pg");
	const suffix = randomUUID().replaceAll("-", ""), schema = `pi861_test_${suffix}`, role = `pi861_test_${suffix}`, password = randomUUID();
	const admin = new Pool({ connectionString: url.toString(), max: 2 });
	let runtime, schemaCreated = false, roleCreated = false;
	try {
		await admin.query(`CREATE SCHEMA "${schema}"`); schemaCreated = true;
		await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`); roleCreated = true;
		const client = await admin.connect();
		try {
			await client.query(`SET search_path TO "${schema}"`);
			await client.query(await readFile(new URL("../sql/memory-v1.sql", import.meta.url), "utf8"));
			await client.query(await readFile(new URL("../sql/runtime-v2.sql", import.meta.url), "utf8"));
		} finally { client.release(); }
		const migration = new Pool({ connectionString: url.toString(), options: `-c search_path=${schema}`, max: 2 });
		const backupDir = await mkdtemp(join(tmpdir(), "pi861-m3-backup-"));
		t.after(async () => { await migration.end(); await rm(backupDir, { recursive: true, force: true }); });
		const legacyItem = { id: "legacy", scope: "project:legacy", kind: "project", abstract: "legacy", overview: "legacy", full: "legacy durable evidence", source: { kind: "user", ref: "legacy:event" }, status: "confirmed" };
		const legacyBody = { ...legacyItem, revision: 1, updatedAt: 100 };
		const legacyReceipt = { requestId: "legacy-put", state: "committed", id: "legacy", scope: "project:legacy", revision: 1 };
		await migration.query("INSERT INTO pi861_memory_items(tenant_id,scope_key,memory_id,revision,body,fingerprint) VALUES('legacy','project:legacy','legacy',1,$1::jsonb,'legacy')", [JSON.stringify(legacyBody)]);
		await migration.query("INSERT INTO pi861_memory_versions(tenant_id,scope_key,memory_id,revision,body) VALUES('legacy','project:legacy','legacy',1,$1::jsonb)", [JSON.stringify(legacyBody)]);
		await migration.query("INSERT INTO pi861_memory_receipts(tenant_id,principal_id,request_id,scope_key,intent_hash,receipt) VALUES('legacy','agent1','legacy-put','project:legacy',$1,$2::jsonb)", [digest({ requestId: "legacy-put", scope: "project:legacy", id: "legacy", expectedRevision: null, item: legacyItem }), JSON.stringify(legacyReceipt)]);
		const localPrincipal = { tenantId: "local-source", principalId: "agent1", readScopes: ["project:local"], writeScopes: ["project:local"] };
		const legacyLocal = new LocalMemory(localPrincipal);
		const localRequest = { requestId: "local-put", expectedRevision: null, item: { ...legacyItem, id: "local", scope: "project:local" } };
		await legacyLocal.put(localRequest);
		const layeredSource = new LayeredMemory(new FileStateStore(join(backupDir, "source.json"), emptyLayeredMemory("file-source")), { tenantId: "file-source", principalId: "agent1", readScopes: ["project:file"], writeScopes: ["project:file"] });
		await layeredSource.put({ requestId: "file-put", expectedRevision: null, item: { ...legacyItem, id: "file", scope: "project:file" } });
		await layeredSource.enrich({ modelId: "fixture", extract: async () => ({ abstract: "file summary", overview: "file overview", facts: [] }) }, { signal: AbortSignal.timeout(5000) });
		const fileState = JSON.parse(await readFile(join(backupDir, "source.json"), "utf8"));
		const runtimeState = emptyLayeredMemory("runtime-source");
		const runtimeLocal = new LocalMemory({ tenantId: "runtime-source", principalId: "agent1", readScopes: ["project:runtime"], writeScopes: ["project:runtime"] });
		await runtimeLocal.put({ requestId: "runtime-put", expectedRevision: null, item: { ...legacyItem, id: "runtime", scope: "project:runtime" } });
		runtimeState.memory = runtimeLocal.snapshot;
		await migration.query("INSERT INTO pi861_runtime_state(tenant_id,state_key,body) VALUES('runtime-source','project:memory',$1::jsonb)", [JSON.stringify(runtimeState)]);
		const migrated = await migrateMemory(migration, { writersStopped: true, backupPath: join(backupDir, "before.json"), sources: [{ id: "session:fixture", state: legacyLocal.snapshot }, { id: "file:fixture", state: fileState }], runtimeSources: [{ id: "runtime:fixture", tenantId: "runtime-source", stateKey: "project:memory" }] });
		assert.equal(migrated.records, 4);
		t.diagnostic(`Server ${String((await migration.query("SHOW server_version")).rows[0].server_version)}; real SQL and NOSUPERUSER NOBYPASSRLS runtime; deterministic extractors`);
		await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
		await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
		await admin.query(`REVOKE INSERT, UPDATE ON "${schema}".pi861_schema_migrations, "${schema}".pi861_memory_imports, "${schema}".pi861_memory_legacy_receipts FROM "${role}"`);
		await admin.query(`GRANT DELETE ON "${schema}".pi861_memory_projections, "${schema}".pi861_memory_jobs TO "${role}"`);
		await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${role}"`);
		const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = password;
		runtime = new Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${schema}`, max: 4 });
		const principal = { tenantId: "t1", principalId: "agent1", readScopes: ["project:p1"], writeScopes: ["project:p1"] };
		const store = new PostgresMemory(runtime, principal);
		await store.ready();
		const write = (requestId, changes = {}, revision = null) => ({ requestId, expectedRevision: revision,
			item: { id: "m1", scope: "project:p1", kind: "project", abstract: "alpha", overview: "alpha overview", full: "alpha original evidence", status: "confirmed", source: { kind: "user", ref: "event:1" }, ...changes } });
		await t.test("migration imports v1, session, file and runtime sources and preserves receipts", async () => {
			const old = new PostgresMemory(runtime, { tenantId: "legacy", principalId: "agent1", readScopes: ["project:legacy"], writeScopes: ["project:legacy"] });
			assert.deepEqual(await old.put({ requestId: "legacy-put", expectedRevision: null, item: legacyItem }), legacyReceipt);
			const local = new PostgresMemory(runtime, localPrincipal);
			assert.deepEqual(await local.put(localRequest), legacyLocal.snapshot.receipts[0].receipt);
			const file = new PostgresMemory(runtime, { tenantId: "file-source", principalId: "agent1", readScopes: ["project:file"], writeScopes: ["project:file"] });
			assert.equal((await file.get("project:file", "file")).abstract, "file summary");
			assert.equal((await file.listJobs())[0].state, "done");
			assert.equal((await migration.query("SELECT count(*) FROM pi861_memory_imports")).rows[0].count, "3");
			const again = await migrateMemory(migration, { writersStopped: true, backupPath: join(backupDir, "v3.json"), sources: [{ id: "session:fixture", state: legacyLocal.snapshot }] });
			assert.equal(again.replayed, true);
			assert.equal(again.digest, migrated.digest);
			const conflict = structuredClone(legacyLocal.snapshot); conflict.items[0].full = "conflicting source";
			await assert.rejects(migrateMemory(migration, { writersStopped: true, backupPath: join(backupDir, "conflict.json"), sources: [{ id: "other-source", state: conflict }] }), /Migration identity conflict/);
			assert.equal((await local.get("project:local", "local")).full, legacyItem.full);
		});
		await t.test("verified backups restore into empty v1 and v3 schemas including projections and sequence", async () => {
			for (const version of ["v1", "v3"]) {
				const restoreSchema = `${schema}_${version}`;
				await admin.query(`CREATE SCHEMA "${restoreSchema}"`);
				const target = new Pool({ connectionString: url.toString(), options: `-c search_path=${restoreSchema}`, max: 2 });
				try {
					await target.query(await readFile(new URL("../sql/memory-v1.sql", import.meta.url), "utf8"));
					await target.query(await readFile(new URL("../sql/runtime-v2.sql", import.meta.url), "utf8"));
					if (version === "v3") await target.query(await readFile(new URL("../sql/memory-v3.sql", import.meta.url), "utf8"));
					const sources = await restoreMemoryBackup(target, join(backupDir, version === "v1" ? "before.json" : "v3.json"));
					assert.ok(sources.some(source => source.id === "session:fixture"));
					assert.equal(Number((await target.query("SELECT count(*) FROM pi861_memory_items")).rows[0].count), version === "v1" ? 1 : 4);
					if (version === "v3") {
						assert.equal((await target.query("SELECT count(*) FROM pi861_memory_projections")).rows[0].count, "1");
						assert.equal((await target.query("SELECT count(*) FROM pi861_memory_jobs")).rows[0].count, "1");
						await target.query("INSERT INTO pi861_memory_events(tenant_id,scope_key,memory_id,revision,action,event_digest) VALUES('restored','project:p','new',1,'put','new')");
					} else assert.equal((await target.query("SELECT count(*) FROM pi861_runtime_state")).rows[0].count, "1");
					await assert.rejects(restoreMemoryBackup(target, join(backupDir, version === "v1" ? "before.json" : "v3.json")), /empty schema/);
				} finally { await target.end(); await admin.query(`DROP SCHEMA "${restoreSchema}" CASCADE`); }
			}
		});
		await t.test("write and replay produce one canonical revision", async () => {
			const first = await store.put(write("r1")); assert.deepEqual(await store.put(write("r1")), first);
			assert.equal((await store.get("project:p1", "m1")).revision, 1); assert.equal((await store.search("alpha")).length, 1);
		});
		await t.test("concurrent stale readers cannot both overwrite", async () => {
			const outcomes = await Promise.allSettled([store.put(write("r2", { full: "alpha second A" }, 1)), store.put(write("r3", { full: "alpha second B" }, 1))]);
			assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1); assert.equal((await store.get("project:p1", "m1")).revision, 2);
		});
		await t.test("tenant and scope filters prevent unauthorized reads", async () => {
			const other = new PostgresMemory(runtime, { ...principal, tenantId: "other" });
			assert.equal(await other.get("project:p1", "m1"), undefined); assert.equal(await store.get("project:other", "m1"), undefined);
		});
		await t.test("RLS denies a connection with no transaction-local scope", async () => { assert.equal((await runtime.query("SELECT body FROM pi861_memory_items")).rows.length, 0); });
		await t.test("withdrawal invalidates search and rejects reprocessed old sources", async () => {
			const withdrawn = await store.withdraw("f1", "project:p1", "m1", 2);
			assert.deepEqual(await store.withdraw("f1", "project:p1", "m1", 2), withdrawn);
			assert.equal(await store.get("project:p1", "m1"), undefined); assert.equal((await store.search("alpha")).length, 0);
			await assert.rejects(store.put(write("reimport", { id: "m2", full: "paraphrased old event" })), /Withdrawn/);
		});
		await t.test("versions, invalidation events and receipts exist in matching counts", async () => {
			const connection = await admin.connect();
			try { await connection.query(`SET search_path TO "${schema}"`);
				for (const table of ["pi861_memory_versions", "pi861_memory_events", "pi861_memory_receipts"]) assert.equal(Number((await connection.query(`SELECT count(*) AS n FROM ${table} WHERE tenant_id='t1'`)).rows[0].n), 3);
			} finally { connection.release(); }
		});
		await t.test("record SQL extraction retries, exhausts, requeues and never holds model calls under a transaction", async () => {
			const jobs = new PostgresMemory(runtime, { ...principal, tenantId: "jobs" });
			await jobs.put(write("source"));
			let calls = 0;
			const extractor = { modelId: "fixture", async extract() {
				assert.equal((await migration.query("SELECT count(*) FROM pg_stat_activity WHERE usename=$1 AND state='idle in transaction'", [role])).rows[0].count, "0");
				if (++calls === 1) throw new Error("503 transient");
				return { abstract: "derived", overview: "derived overview", facts: [{ text: "observation", quote: "alpha" }] };
			} };
			assert.equal((await jobs.enrich(extractor, { signal: AbortSignal.timeout(5000), maxJobs: 1, backoffBaseMs: 30_000 })).failed, 1);
			const parked = (await jobs.listJobs())[0]; assert.equal(parked.state, "queued"); assert.ok(parked.nextAttemptAt > Date.now());
			assert.equal((await jobs.enrich(extractor, { signal: AbortSignal.timeout(5000) })).completed, 0);
			await migration.query("UPDATE pi861_memory_jobs SET next_attempt_at=clock_timestamp()-interval '1 second' WHERE tenant_id='jobs'");
			assert.equal((await jobs.enrich(extractor, { signal: AbortSignal.timeout(5000) })).completed, 1);
			assert.equal((await jobs.get("project:p1", "m1")).full, "alpha original evidence");
			await jobs.put(write("failure-source", { id: "failure", source: { kind: "user", ref: "failure" } }));
			const failure = await jobs.enrich({ modelId: "fixture", extract: async () => { throw new Error("503"); } }, { signal: AbortSignal.timeout(5000), backoffBaseMs: 0, maxJobs: 10 });
			assert.equal(failure.failed, 3);
			const failed = (await jobs.listJobs()).find(job => job.memoryId === "failure"); assert.equal(failed.state, "failed");
			await jobs.requeueJob(failed.id);
			assert.equal((await jobs.enrich(extractor, { signal: AbortSignal.timeout(5000) })).completed, 1);
			assert.equal((await jobs.listJobs()).find(job => job.id === failed.id).requeues, 1);
		});
		await t.test("concurrent extraction claim, withdrawal fencing and expired lease recovery", async () => {
			const jobs = new PostgresMemory(runtime, { ...principal, tenantId: "leases" });
			await jobs.put(write("source"));
			let started, release;
			const ready = new Promise(resolve => { started = resolve; });
			const pending = jobs.enrich({ modelId: "fixture", extract: () => { started(); return new Promise(resolve => { release = resolve; }); } }, { signal: AbortSignal.timeout(5000) });
			await ready;
			assert.equal((await jobs.enrich({ modelId: "fixture", extract: async () => { throw new Error("must not claim"); } }, { signal: AbortSignal.timeout(5000) })).failed, 0);
			await jobs.withdraw("withdraw", "project:p1", "m1", 1);
			release({ abstract: "late", overview: "late", facts: [] }); assert.equal((await pending).obsolete, 1);
			assert.equal((await migration.query("SELECT count(*) FROM pi861_memory_projections WHERE tenant_id='leases'")).rows[0].count, "0");
			await jobs.put(write("new", { id: "new", source: { kind: "user", ref: "new" }, full: "new evidence" }));
			await migration.query("UPDATE pi861_memory_jobs SET state='running', lease_token='stale',lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id='leases' AND memory_id='new'");
			assert.equal((await jobs.enrich({ modelId: "fixture", extract: async () => ({ abstract: "recovered", overview: "recovered", facts: [] }) }, { signal: AbortSignal.timeout(5000) })).completed, 1);
		});
		await t.test("SQL assembly, multilingual retrieval, paged delta and RLS metadata isolation", async () => {
			const principal = { tenantId: "views", principalId: "agent1", readScopes: ["project:p1", "agent:private"], writeScopes: ["project:p1", "agent:private"] };
			const views = new PostgresMemory(runtime, principal);
			for (const [id, changes] of [["constraint", {kind:"constraint"}], ["working",{kind:"working"}], ["experience",{kind:"experience"}], ["private",{scope:"agent:private", full:"private-only-marker"}]]) await views.put(write(id, { id, ...changes }));
			const recovered = new PostgresMemory(runtime, principal);
			for (const mode of ["startup","takeover","model-switch","compaction","node-switch"]) assert.deepEqual((await recovered.assemble({mode})).included.map(row => row.kind), ["constraint","working","project"]);
			assert.ok((await recovered.assemble({mode:"event-recall"})).included.some(row => row.kind === "experience"));
			await views.put(write("terms", { id:"terms", full:"中文无空格长句 LayeredMemory.enrich pi861_memory_outbox C:\\Code\\Memory.ts extensions/pi861/src/live/store.ts" }));
			for (const query of ["无空格长句","LayeredMemory.enrich","pi861_memory_outbox","c:\\code\\memory.ts","extensions/pi861/src/live/store.ts"]) assert.equal((await views.search(query))[0].id,"terms");
			const restricted = new PostgresMemory(runtime, {...principal, readScopes:["project:p1"],writeScopes:[]});
			assert.equal((await restricted.search("private-only-marker")).length,0);
			assert.equal(await restricted.getRecord("agent:private","private"),undefined);
			assert.equal((await restricted.list("agent:private")).items.length,0);
			assert.ok(!(await restricted.assemble()).text.includes("private-only-marker"));
			assert.ok((await restricted.listJobs()).every(row => row.scope === "project:p1"));
			let cursor = 0, more = true, changes = [];
			while(more) { const page = await restricted.delta(cursor,2); changes.push(...page.changes); cursor=page.cursor; more=page.hasMore; }
			assert.equal(changes.length,4); assert.ok(changes.every(row=>row.scope==="project:p1"));
			const client = await runtime.connect();
			try {
				await client.query("BEGIN"); await client.query("SELECT set_config('pi861.tenant_id','views',true),set_config('pi861.read_scopes','[\"project:p1\"]',true),set_config('pi861.write_scopes','[]',true)");
				assert.equal((await client.query("DELETE FROM pi861_memory_jobs RETURNING job_id")).rows.length,0);
				assert.equal((await client.query("SELECT count(*) FROM pi861_memory_items")).rows[0].count,"4");
				await client.query("COMMIT");
			} finally { client.release(); }
			assert.equal((await views.listJobs()).length,5);
		});
		await t.test("lost commit response reconciles without duplicate writes; disconnected pending queue stays uncommitted", async () => {
			let lost = true;
			const pool = { async connect() { const client = await runtime.connect(); return { async query(sql, args) { const result = await client.query(sql,args); if(sql==="COMMIT" && lost) { lost=false; throw new Error("injected lost COMMIT response"); } return result; }, release() { client.release(); } }; } };
			const uncertain = new PostgresMemory(pool,{...principal,tenantId:"faults"});
			const request = write("ambiguous");
			await assert.rejects(uncertain.put(request),/lost COMMIT/);
			const receipt = (await uncertain.reconcile(request.requestId)).receipt;
			assert.deepEqual(await uncertain.put(request), receipt);
			for(const table of ["pi861_memory_items","pi861_memory_versions","pi861_memory_events","pi861_memory_receipts"]) assert.equal((await migration.query(`SELECT count(*) FROM ${table} WHERE tenant_id='faults'`)).rows[0].count,"1");
			let online = false;
			const queueStore = new FileStateStore(join(backupDir,"pending.json"),{version:1,entries:[]});
			const queue = new PendingMemoryWrites(queueStore,{put: request => { if(!online) throw new Error("disconnected"); return uncertain.put(request); }});
			const pending = write("pending",{id:"pending",source:{kind:"user",ref:"pending"}});
			await assert.rejects(queue.put(pending),MemoryCommitPending);
			assert.equal((await queueStore.read()).entries[0].state,"uncommitted");
			assert.equal(await uncertain.get("project:p1","pending"),undefined);
			online=true; assert.deepEqual(await queue.flush(),{committed:1,pending:0});
			assert.equal((await uncertain.get("project:p1","pending")).revision,1);
		});
		await t.test("runtime state commits canonical records and enrichment atomically across clients", async () => {
			const initial = emptyLayeredMemory("t1"), make = () => new LayeredMemory(new PostgresStateStore(runtime, "t1", "layered", initial), principal);
			const left = make(), right = make(); await left.put(write("layered-1"));
			assert.equal((await right.get("project:p1", "m1")).revision, 1);
			const results = await Promise.allSettled([left.put(write("layered-2", {full:"updated A"},1)),right.put(write("layered-3",{full:"updated B"},1))]);
			assert.equal(results.filter(x=>x.status==="fulfilled").length,1);
			await left.enrich({modelId:"fixture",extract:async input=>({abstract:"derived",overview:"derived overview",facts:[{text:input.text,quote:input.text}]})},{signal:new AbortController().signal,maxJobs:3});
			assert.equal((await right.get("project:p1","m1")).abstract,"derived");
			await right.withdraw("layered-forget","project:p1","m1",2); assert.equal(await left.get("project:p1","m1"),undefined);
			assert.equal((await runtime.query("SELECT body FROM pi861_runtime_state")).rows.length,0);
			assert.equal((await right.delta(0,100)).changes.at(-1).withdrawn,true);
		});
	} finally {
		if (runtime) await runtime.end(); if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
		if (roleCreated) await admin.query(`DROP ROLE "${role}"`); await admin.end();
	}
});
