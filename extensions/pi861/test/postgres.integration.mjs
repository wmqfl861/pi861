/**
 * Explicit integration test. Creates only a unique test schema and role in
 * a loopback database named pi861_test. Never point this at a real brain.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { PostgresMemory } from "../src/postgres.ts";

const configured = Boolean(process.env.PI861_TEST_POSTGRES_URL);
test("real PostgreSQL: atomic memory, CAS, RLS and withdrawal", { skip: !configured }, async (t) => {
	if (process.env.PI861_ALLOW_TEST_DATABASE !== "1") throw new Error("Explicit test database consent is required");
	const url = new URL(process.env.PI861_TEST_POSTGRES_URL);
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/pi861_test") {
		throw new Error("Only a loopback pi861_test database is permitted");
	}
	const driverRoot = process.env.PI861_TEST_DRIVER_ROOT;
	const require = createRequire(driverRoot ? join(driverRoot, "package.json") : import.meta.url);
	const { Pool } = require("pg");
	const suffix = randomUUID().replaceAll("-", "");
	const schema = `pi861_test_${suffix}`;
	const role = `pi861_test_${suffix}`;
	const password = randomUUID();
	const admin = new Pool({ connectionString: url.toString(), max: 2 });
	let runtime;
	let schemaCreated = false;
	let roleCreated = false;
	try {
		await admin.query(`CREATE SCHEMA "${schema}"`);
		schemaCreated = true;
		await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD '${password}' NOSUPERUSER NOBYPASSRLS`);
		roleCreated = true;
		const client = await admin.connect();
		try {
			await client.query(`SET search_path TO "${schema}"`);
			await client.query(await readFile(new URL("../sql/memory-v1.sql", import.meta.url), "utf8"));
		} finally { client.release(); }
		await admin.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${role}"`);
		await admin.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "${schema}" TO "${role}"`);
		const runtimeUrl = new URL(url);
		runtimeUrl.username = role;
		runtimeUrl.password = password;
		runtime = new Pool({ connectionString: runtimeUrl.toString(), options: `-c search_path=${schema}`, max: 4 });
		const principal = { tenantId: "t1", principalId: "agent1", readScopes: ["project:p1"], writeScopes: ["project:p1"] };
		const store = new PostgresMemory(runtime, principal);
		const write = (requestId, changes = {}, revision = null) => ({
			requestId, expectedRevision: revision,
			item: { id: "m1", scope: "project:p1", kind: "project", abstract: "alpha", overview: "alpha overview",
				full: "alpha original evidence", status: "confirmed", source: { kind: "user", ref: "event:1" }, ...changes },
		});
		await t.test("write and replay produce one canonical revision", async () => {
			const first = await store.put(write("r1"));
			assert.deepEqual(await store.put(write("r1")), first);
			assert.equal((await store.get("project:p1", "m1")).revision, 1);
			assert.equal((await store.search("alpha")).length, 1);
		});
		await t.test("concurrent stale readers cannot both overwrite", async () => {
			const outcomes = await Promise.allSettled([
				store.put(write("r2", { full: "alpha second A" }, 1)),
				store.put(write("r3", { full: "alpha second B" }, 1)),
			]);
			assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
			assert.equal((await store.get("project:p1", "m1")).revision, 2);
		});
		await t.test("tenant and scope filters prevent unauthorized reads", async () => {
			const other = new PostgresMemory(runtime, { ...principal, tenantId: "other" });
			assert.equal(await other.get("project:p1", "m1"), undefined);
			assert.equal(await store.get("project:other", "m1"), undefined);
		});
		await t.test("RLS denies a connection with no transaction-local scope", async () => {
			const rows = await runtime.query("SELECT body FROM pi861_memory_items");
			assert.equal(rows.rows.length, 0);
		});
		await t.test("withdrawal invalidates search and rejects reprocessed old sources", async () => {
			const withdrawn = await store.withdraw("f1", "project:p1", "m1", 2);
			assert.deepEqual(await store.withdraw("f1", "project:p1", "m1", 2), withdrawn);
			assert.equal(await store.get("project:p1", "m1"), undefined);
			assert.equal((await store.search("alpha")).length, 0);
			await assert.rejects(store.put(write("reimport", { id: "m2", full: "paraphrased old event" })), /Withdrawn/);
		});
		await t.test("versions, invalidation events and receipts exist in matching counts", async () => {
			const connection = await admin.connect();
			try {
				await connection.query(`SET search_path TO "${schema}"`);
				for (const table of ["pi861_memory_versions", "pi861_memory_outbox", "pi861_memory_receipts"]) {
					assert.equal(Number((await connection.query(`SELECT count(*) AS n FROM ${table}`)).rows[0].n), 3);
				}
			} finally { connection.release(); }
		});
	} finally {
		if (runtime) await runtime.end();
		if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
		if (roleCreated) await admin.query(`DROP ROLE "${role}"`);
		await admin.end();
	}
});
