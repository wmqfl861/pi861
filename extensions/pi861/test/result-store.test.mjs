import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStateStore } from "../src/live/store.ts";
import { LayeredMemory, emptyLayeredMemory } from "../src/live/layered-memory.ts";
import { PersistentResultStore, ResultStore, packResult } from "../src/result-store.ts";

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

// ----- P2-M durable controlled-reference backend -----

const memoryPrincipal = {
	tenantId: "t",
	principalId: "a",
	readScopes: ["project:p"],
	writeScopes: ["project:p"],
};
function durableSetup(t) {
	const dir = mkdtempSync(join(tmpdir(), "pi861-result-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const store = new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("t"));
	const memory = new LayeredMemory(store, memoryPrincipal);
	const durable = new PersistentResultStore(memory, { scopes: ["project:p"], pageSize: 10 });
	return { dir, store, memory, durable };
}

test("durable references page across chunk records with the same markers as inline reads", async (t) => {
	const { durable } = durableSetup(t);
	const text = `${"ab".repeat(40)}é${"cd".repeat(40)}`; // multibyte char inside, 40*2*2+2 = 162 chars
	const reference = await durable.store(text, "role:worker-a", {
		kind: "web-read",
		scope: "project:p",
		url: "https://example.test/page",
		sourceComplete: true,
	});
	assert.equal(reference.totalCharacters, text.length);
	const first = await durable.read(reference.resultRef, "role:worker-a");
	assert.equal(first.text, text.slice(0, 10));
	assert.equal(first.offset, 0);
	assert.equal(first.complete, false);
	assert.equal(first.sourceComplete, true);
	assert.equal(first.untrusted, true);
	const middle = await durable.read(reference.resultRef, "role:worker-a", 78);
	assert.equal(middle.text, text.slice(78, 88));
	const last = await durable.read(reference.resultRef, "role:worker-a", text.length - 5);
	assert.equal(last.text, text.slice(-5));
	assert.equal(last.complete, true);
	assert.equal(last.nextOffset, text.length);
	const metadata = await durable.metadata(reference.resultRef, "role:worker-a");
	assert.deepEqual(metadata, { kind: "web-read", scope: "project:p", url: "https://example.test/page", sourceComplete: true });
});

test("durable reference ids match the session-local store for identical web metadata", async (t) => {
	const { durable } = durableSetup(t);
	const inline = new ResultStore();
	const metadata = { kind: "web-read", scope: "project:p", url: "https://example.test/doc", sourceComplete: false };
	const inlineReference = inline.store("shared payload", "role:worker-a", metadata);
	const durableReference = await durable.store("shared payload", "role:worker-a", metadata);
	assert.equal(durableReference.resultRef, inlineReference.resultRef);
});

test("oversized payloads chunk into bounded records and re-store is idempotent", async (t) => {
	const { durable, memory } = durableSetup(t);
	const payload = `x`.repeat(300_000); // forces two chunks at the 240_000-byte budget
	const reference = await durable.store(payload, "role:worker-a", {
		kind: "tool",
		scope: "project:p",
		tool: "web.read",
		sourceComplete: true,
	});
	const first = await durable.read(reference.resultRef, "role:worker-a", 299_990);
	assert.equal(first.text, payload.slice(299_990));
	assert.equal(first.complete, true);
	// Identical re-store reuses the committed records instead of duplicating them.
	const again = await durable.store(payload, "role:worker-a", {
		kind: "tool",
		scope: "project:p",
		tool: "web.read",
		sourceComplete: true,
	});
	assert.equal(again.resultRef, reference.resultRef);
	const delta = await memory.delta();
	// Exactly the two chunk puts plus the manifest; the idempotent re-store appended none.
	assert.equal(delta.changes.length, 3);
	assert.deepEqual(
		delta.changes.map((change) => change.withdrawn),
		[false, false, false],
	);
});

test("revocation withdraws every chunk and reads fail uniformly afterwards", async (t) => {
	const { durable, memory } = durableSetup(t);
	const payload = `${"y".repeat(250_000)}tail`; // two chunks plus a manifest record
	const reference = await durable.store(payload, "role:worker-a", {
		kind: "tool",
		scope: "project:p",
		tool: "shell.run",
		sourceComplete: true,
	});
	const withdrawn = await durable.revoke("revoke-1", reference.resultRef, "role:worker-a");
	assert.equal(withdrawn, 3);
	assert.equal(await durable.read(reference.resultRef, "role:worker-a").then(
		() => "readable",
		(error) => error.message,
	), "Result not found");
	// Withdrawn chunks carry tombstones: the payload is unreachable through search too.
	assert.equal((await memory.search("yyyyyyyyyyyy")).length, 0);
	// Revoking again is a no-op, and foreign owners never see the reference at all.
	assert.equal(await durable.revoke("revoke-2", reference.resultRef, "role:worker-a"), 0);
	assert.equal(await durable.read(reference.resultRef, "role:worker-b").then(
		() => "readable",
		(error) => error.message,
	), "Result not found");
});

test("durable references stay readable from a fresh authority over the same state", async (t) => {
	const { dir, durable } = durableSetup(t);
	const reference = await durable.store("cross-session payload", "role:worker-a", {
		kind: "search",
		scope: "project:p",
		url: "https://example.test/search",
		sourceComplete: true,
	});
	const reopened = new LayeredMemory(
		new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("t")),
		memoryPrincipal,
	);
	const secondNode = new PersistentResultStore(reopened, { scopes: ["project:p"] });
	const page = await secondNode.read(reference.resultRef, "role:worker-a", 0);
	assert.equal(page.text, "cross-session payload");
	assert.equal(page.complete, true);
});

test("durable store validates limits and descriptors", async (t) => {
	const { durable } = durableSetup(t);
	await assert.rejects(durable.store("", "role:worker-a", { kind: "tool", scope: "project:p", sourceComplete: true }), /storage limit/);
	await assert.rejects(
		durable.store("payload", "role:worker-a", { kind: "tool", scope: "not a scope", sourceComplete: true }),
		/Invalid result descriptor/,
	);
	await assert.rejects(durable.store("payload", "", { kind: "tool", scope: "project:p", sourceComplete: true }), /owner identity/);
});

test("durable references survive a raw authority distillation pass (review-1 F1 regression)", async (t) => {
	const { durable, memory } = durableSetup(t);
	const payload = `${"r".repeat(250_000)}end`; // two chunks + manifest
	const reference = await durable.store(payload, "role:worker-a", {
		kind: "tool",
		scope: "project:p",
		tool: "web.read",
		sourceComplete: true,
	});
	// A raw authority enrich (bypassing any governance wrapper) projects the
	// reference storage records: abstract/overview are replaced by model output.
	const stats = await memory.enrich(
		{
			modelId: "fixture",
			async extract() {
				return { abstract: "模型摘要", overview: "投影生成的概览文本覆盖了原字段。", facts: [] };
			},
		},
		{ signal: new AbortController().signal },
	);
	assert.ok(stats.completed >= 3, `reference records were distilled: ${JSON.stringify(stats)}`);
	// The projections really landed on the reference storage records.
	const jobs = await memory.listJobs();
	assert.ok(jobs.filter((job) => job.state === "done").length >= 3);
	for (const done of jobs.filter((job) => job.state === "done")) {
		const item = await memory.get("project:p", done.memoryId);
		assert.ok(item.overview.includes("投影生成的概览文本"), `projection present on ${done.memoryId.slice(0, 12)}`);
	}
	// The descriptor lives in the manifest record's full body, which projections
	// never touch: read, metadata and revoke keep working. (The reader uses a
	// wide page size so the full-payload loop is two pages, not 25,000.)
	const fastReader = new PersistentResultStore(memory, { scopes: ["project:p"], pageSize: 128_000 });
	let text = "";
	for (let offset = 0; ; ) {
		const page = await fastReader.read(reference.resultRef, "role:worker-a", offset);
		text += page.text;
		offset = page.nextOffset;
		if (page.complete) break;
	}
	assert.equal(text, payload);
	const metadata = await durable.metadata(reference.resultRef, "role:worker-a");
	assert.equal(metadata.tool, "web.read");
	assert.equal(await durable.revoke("revoke-after-distill", reference.resultRef, "role:worker-a"), 3);
	assert.equal(await durable.read(reference.resultRef, "role:worker-a").then(
		() => "readable",
		(error) => error.message,
	), "Result not found");
});

test("store tolerates an unreadable authority: probes degrade to writes and puts adjudicate (review-1 F2-R1)", async (t) => {
	const { memory } = durableSetup(t);
	// Backend whose reads all fail (full outage read side) while writes pass.
	// The governance wiring layers the pending queue on top of put, so at unit
	// level the contract is: store() must not leak the get error; the writes
	// proceed and the idempotent puts (deterministic requestId + content) win.
	const blinded = new PersistentResultStore(
		{
			get: () => Promise.reject(new Error("connection lost")),
			put: (input) => memory.put(input),
			withdraw: (requestId, scope, id, revision) => memory.withdraw(requestId, scope, id, revision),
		},
		{ scopes: ["project:p"], pageSize: 128_000 },
	);
	const payload = "f".repeat(80_000);
	const reference = await blinded.store(payload, "role:worker-a", {
		kind: "tool",
		scope: "project:p",
		tool: "web.read",
		sourceComplete: true,
	});
	// A healthy reader resolves what the blinded writer committed.
	const healthy = new PersistentResultStore(memory, { scopes: ["project:p"], pageSize: 128_000 });
	let text = "";
	for (let offset = 0; ; ) {
		const page = await healthy.read(reference.resultRef, "role:worker-a", offset);
		text += page.text;
		offset = page.nextOffset;
		if (page.complete) break;
	}
	assert.equal(text, payload);
	// Idempotent re-store through the same blinded backend replays the same
	// reference without leaking the get error either.
	const again = await blinded.store(payload, "role:worker-a", {
		kind: "tool",
		scope: "project:p",
		tool: "web.read",
		sourceComplete: true,
	});
	assert.equal(again.resultRef, reference.resultRef);
});
