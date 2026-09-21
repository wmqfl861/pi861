import assert from "node:assert/strict";
import { test } from "node:test";
import { PostgresMemory } from "../src/postgres.ts";

const principal = { tenantId: "tenant1", principalId: "agent1", readScopes: ["project:p1"], writeScopes: ["project:p1"] };
const input = { requestId: "request1", expectedRevision: null, item: {
	id: "fact1", scope: "project:p1", kind: "project", abstract: "A", overview: "Overview", full: "A durable fact",
	source: { kind: "user", ref: "event:1" }, status: "confirmed",
} };
function database(handler = () => ({ rows: [] })) {
	const calls = [];
	let releases = 0;
	let connections = 0;
	const pool = { async connect() {
		connections++;
		return { async query(sql, params) {
			calls.push({ sql, params });
			return handler(sql, params);
		}, release() { releases++; } };
	} };
	return { calls, pool, get releases() { return releases; }, get connections() { return connections; } };
}
test("writes commit canonical item, version, outbox and receipt together", async () => {
	const db = database();
	const result = await new PostgresMemory(db.pool, principal).put(input);
	assert.equal(result.state, "committed");
	assert.equal(db.calls[0].sql, "BEGIN");
	assert.equal(db.calls.at(-1).sql, "COMMIT");
	for (const table of ["pi861_memory_items", "pi861_memory_versions", "pi861_memory_outbox", "pi861_memory_receipts"])
		assert.ok(db.calls.some((call) => call.sql.startsWith(`INSERT INTO ${table}`)));
	assert.equal(db.releases, 1);
	const settings = db.calls.find((call) => call.sql.includes("set_config"));
	assert.deepEqual(settings.params.slice(0, 2), ["tenant1", "agent1"]);
	assert.match(settings.sql, /true/);
});
test("no committed receipt is exposed before database commit completes", async () => {
	let unblock;
	const commit = new Promise((resolve) => { unblock = resolve; });
	const db = database(async (sql) => { if (sql === "COMMIT") await commit; return { rows: [] }; });
	let resolved = false;
	const operation = new PostgresMemory(db.pool, principal).put(input).then((value) => { resolved = true; return value; });
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(resolved, false);
	unblock();
	assert.equal((await operation).state, "committed");
});
test("ambiguous commit response rejects and keeps original request identity replayable", async () => {
	const db = database((sql) => { if (sql === "COMMIT") throw new Error("lost commit response"); return { rows: [] }; });
	await assert.rejects(new PostgresMemory(db.pool, principal).put(input), /lost commit/);
	assert.equal(db.calls.at(-1).sql, "ROLLBACK");
	assert.equal(db.releases, 1);
	const receiptWrite = db.calls.find((call) => call.sql.startsWith("INSERT INTO pi861_memory_receipts"));
	assert.equal(receiptWrite.params[2], "request1");
});
test("replay returns original receipt and never rewrites data", async () => {
	let stored;
	const first = database((sql, params) => {
		if (sql.startsWith("INSERT INTO pi861_memory_receipts")) stored = { intent_hash: params[4], receipt: JSON.parse(params[5]) };
		return { rows: [] };
	});
	const original = await new PostgresMemory(first.pool, principal).put(input);
	const second = database((sql) => ({ rows: sql.startsWith("SELECT intent_hash") ? [stored] : [] }));
	assert.deepEqual(await new PostgresMemory(second.pool, principal).put(input), original);
	assert.ok(second.calls.every((call) => !call.sql.startsWith("INSERT")));
});
test("idempotency mismatch rejects without changing an existing record", async () => {
	const db = database((sql) => ({ rows: sql.startsWith("SELECT intent_hash") ? [{ intent_hash: "different", receipt: {} }] : [] }));
	await assert.rejects(new PostgresMemory(db.pool, principal).put(input), /idempotency/);
	assert.equal(db.calls.at(-1).sql, "ROLLBACK");
	assert.ok(db.calls.every((call) => !call.sql.startsWith("INSERT")));
});
test("stale revisions fail before publication", async () => {
	const db = database((sql) => ({ rows: sql.startsWith("SELECT body") ? [{ body: { ...input.item, revision: 2, updatedAt: 0 } }] : [] }));
	await assert.rejects(new PostgresMemory(db.pool, principal).put({ ...input, expectedRevision: 1 }), /revision/);
	assert.ok(db.calls.every((call) => !call.sql.startsWith("INSERT")));
});
test("unauthorized scope does not connect to the database", async () => {
	const db = database();
	const store = new PostgresMemory(db.pool, principal);
	assert.equal(await store.get("project:other", "fact1"), undefined);
	await assert.rejects(store.put({ ...input, item: { ...input.item, scope: "project:other" } }), /authorized/);
	assert.equal(db.connections, 0);
});
test("search uses parameters and explicit tenant and allowed scopes", async () => {
	const db = database();
	await new PostgresMemory(db.pool, principal).search("'); DROP TABLE t; --");
	const call = db.calls.find((entry) => entry.sql.startsWith("SELECT body"));
	assert.ok(!call.sql.includes("DROP TABLE"));
	assert.equal(call.params[0], "tenant1");
	assert.deepEqual(call.params[1], ["project:p1"]);
	assert.equal(call.params[2], "'); DROP TABLE t; --");
});
test("withdrawal commits content and source tombstones and an invalidation event", async () => {
	const db = database((sql) => ({ rows: sql.startsWith("SELECT body") ? [{ body: { ...input.item, revision: 1, updatedAt: 0 } }] : [] }));
	await new PostgresMemory(db.pool, principal).withdraw("withdraw1", "project:p1", "fact1", 1);
	assert.equal(db.calls.filter((call) => call.sql.startsWith("INSERT INTO pi861_memory_tombstones")).length, 2);
	const event = db.calls.find((call) => call.sql.startsWith("INSERT INTO pi861_memory_outbox"));
	assert.equal(event.params[4], "withdraw");
	assert.equal(db.calls.at(-1).sql, "COMMIT");
});
