import assert from "node:assert/strict";
import { test } from "node:test";
import { ResultStore, packResult } from "../src/result-store.ts";

test("stored results page through offsets with complete markers", () => {
	const store = new ResultStore({ pageSize: 10 });
	const reference = store.store("x".repeat(25), "role:worker-a");
	assert.equal(reference.totalCharacters, 25);
	assert.ok(/^[0-9a-f]{64}$/.test(reference.resultRef));
	const first = store.read(reference.resultRef, "role:worker-a");
	assert.equal(first.text, "x".repeat(10));
	assert.equal(first.offset, 0);
	assert.equal(first.nextOffset, 10);
	assert.equal(first.complete, false);
	const second = store.read(reference.resultRef, "role:worker-a", 10);
	assert.equal(second.text, "x".repeat(10));
	assert.equal(second.complete, false);
	const last = store.read(reference.resultRef, "role:worker-a", 20);
	assert.equal(last.text, "x".repeat(5));
	assert.equal(last.complete, true);
	assert.equal(last.nextOffset, 25);
});

test("reads are owner-checked without a cross-owner existence oracle", () => {
	const store = new ResultStore();
	const reference = store.store("payload", "role:worker-a");
	assert.throws(() => store.read(reference.resultRef, "role:worker-b"), /Result not found/);
	assert.throws(() => store.read("0".repeat(64), "role:worker-a"), /Result not found/);
	assert.throws(() => store.read(reference.resultRef, ""), /Result not found/);
});

test("offsets are validated and storage limits are enforced", () => {
	const store = new ResultStore({ maxEntries: 4, maxCharacters: 100 });
	const reference = store.store("abc", "role:worker-a");
	assert.throws(() => store.read(reference.resultRef, "role:worker-a", -1), /Invalid result offset/);
	assert.throws(() => store.read(reference.resultRef, "role:worker-a", 4), /Invalid result offset/);
	assert.throws(() => store.store("y".repeat(101), "role:worker-a"), /storage limit/);
	assert.throws(() => store.store("value", ""), /owner identity/);
});

test("bounded memory evicts the oldest insertion first", () => {
	const store = new ResultStore({ maxEntries: 2, pageSize: 100 });
	const first = store.store("one", "role:worker-a");
	store.store("two", "role:worker-a");
	const third = store.store("three", "role:worker-a");
	assert.throws(() => store.read(first.resultRef, "role:worker-a"), /Result not found/);
	assert.equal(store.read(third.resultRef, "role:worker-a").text, "three");
	// Re-storing identical content is idempotent and does not duplicate entries.
	const again = store.store("three", "role:worker-a");
	assert.equal(again.resultRef, third.resultRef);
});

test("packResult stays inline below the limit and references above it", () => {
	const store = new ResultStore({ pageSize: 8 });
	const small = packResult("short", "role:worker-a");
	assert.equal(small.inline, true);
	assert.equal(small.text, "short");
	const large = packResult("z".repeat(100), "role:worker-a", { store, inlineLimit: 10 });
	assert.equal(large.inline, false);
	assert.equal(large.totalCharacters, 100);
	assert.equal(store.read(large.resultRef, "role:worker-a").totalCharacters, 100);
	assert.throws(() => packResult("z".repeat(100), "role:worker-a", { inlineLimit: 10 }), /no controlled-reference store/);
});
