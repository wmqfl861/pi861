import assert from "node:assert/strict";
import { test } from "node:test";
import { LocalMemory, contextPack, digest } from "../src/memory.ts";
const principal = { tenantId: "t1", principalId: "agent1", readScopes: ["project:p1"], writeScopes: ["project:p1"] };
const write = (requestId = "r1", changes = {}) => ({
	requestId, expectedRevision: null,
	item: { id: "m1", scope: "project:p1", kind: "project", abstract: "Use pnpm", overview: "This project uses pnpm",
		full: "This project uses pnpm instead of npm.", source: { kind: "user", ref: "event:1" }, status: "confirmed", ...changes },
});
test("write and read return detached scoped records", async () => {
	const store = new LocalMemory(principal);
	const receipt = await store.put(write());
	assert.equal(receipt.state, "committed");
	const item = await store.get("project:p1", "m1");
	item.full = "mutated";
	assert.notEqual((await store.get("project:p1", "m1")).full, "mutated");
	assert.equal(await store.get("project:other", "m1"), undefined);
});
test("unauthorized scope and tenant-reused snapshot are rejected", async () => {
	const store = new LocalMemory(principal);
	await assert.rejects(store.put(write("r1", { scope: "project:other" })), /authorized/);
	assert.throws(() => new LocalMemory({ ...principal, tenantId: "t2" }, store.snapshot), /another tenant/);
});
test("request replay is idempotent, changed intent conflicts", async () => {
	const store = new LocalMemory(principal);
	assert.deepEqual(await store.put(write()), await store.put(write()));
	assert.equal(store.snapshot.items.length, 1);
	await assert.rejects(store.put(write("r1", { full: "different" })), /idempotency/);
});
test("revision precondition prevents stale overwrite", async () => {
	const store = new LocalMemory(principal);
	await store.put(write());
	await store.put({ ...write("r2", { full: "Now use something else" }), expectedRevision: 1 });
	await assert.rejects(store.put({ ...write("r3"), expectedRevision: 1 }), /revision/);
	assert.equal((await store.get("project:p1", "m1")).revision, 2);
});
test("recalled text is not accepted as new evidence", async () => {
	const store = new LocalMemory(principal);
	await assert.rejects(store.put(write("r1", { source: { kind: "recall", ref: "m0" } })), /not new evidence/);
});
test("model inference cannot claim confirmation or change policy", async () => {
	const store = new LocalMemory(principal);
	await assert.rejects(store.put(write("r1", { source: { kind: "inference", ref: "a1" } })), /promote/);
	await assert.rejects(store.put(write("r2", { status: "candidate", kind: "constraint", source: { kind: "inference", ref: "a1" } })), /promote/);
});
test("withdrawal is idempotent and suppresses re-ingestion under another id", async () => {
	const store = new LocalMemory(principal);
	await store.put(write());
	const receipt = await store.withdraw("forget", "project:p1", "m1", 1);
	assert.deepEqual(await store.withdraw("forget", "project:p1", "m1", 1), receipt);
	assert.equal(await store.get("project:p1", "m1"), undefined);
	assert.equal((await store.search("pnpm")).length, 0);
	await assert.rejects(store.put(write("resurrect", { id: "m2" })), /Withdrawn/);
	assert.equal(store.snapshot.items[0].status, "withdrawn");
});
test("failed persistence does not report committed or mutate the store", async () => {
	const store = new LocalMemory(principal, undefined, () => { throw new Error("disk full"); });
	await assert.rejects(store.put(write()), /disk full/);
	assert.equal(store.snapshot.items.length, 0);
	assert.equal(store.snapshot.receipts.length, 0);
});
test("context pack is byte-bounded, whole-entry and provenance-bearing", async () => {
	const store = new LocalMemory(principal);
	await store.put(write("r1", { full: "中文原始证据", overview: "中文概览" }));
	const items = await store.search("中文");
	const small = contextPack(items, { level: 1, maxBytes: 10 });
	assert.equal(small.text, "");
	assert.equal(small.omitted, 1);
	const large = contextPack(items, { level: 2, maxBytes: 2048 });
	assert.equal(large.usedBytes, Buffer.byteLength(large.text, "utf8"));
	assert.equal(JSON.parse(large.text).source.ref, "event:1");
	assert.equal(JSON.parse(large.text).content, "中文原始证据");
});
test("candidate records can be excluded from automatic context", async () => {
	const store = new LocalMemory(principal);
	await store.put(write("r1", { status: "candidate", source: { kind: "inference", ref: "agent:1" } }));
	const packed = contextPack(await store.search("pnpm"), { level: 1, maxBytes: 2048, confirmedOnly: true });
	assert.equal(packed.text, "");
});
test("canonical intent hashes do not depend on object key order", () => {
	assert.equal(digest({ x: 1, y: 2 }), digest({ y: 2, x: 1 }));
	assert.throws(() => digest({ invalid: NaN }), /plain JSON/);
});

test("withdrawal also suppresses paraphrases from the exact same old source", async () => {
	const store = new LocalMemory(principal);
	await store.put(write());
	await store.withdraw("f1", "project:p1", "m1", 1);
	await assert.rejects(store.put(write("again", { id: "other", full: "A paraphrase of old evidence" })), /Withdrawn/);
	await store.put(write("new-intent", { id: "new", full: "An actually new decision", source: { kind: "user", ref: "event:2" } }));
});
test("malformed stored data fails before becoming an active store", () => {
	assert.throws(() => new LocalMemory(principal, { tenantId: "t1", items: "bad", receipts: [], tombstones: [] }), /snapshot/);
});
