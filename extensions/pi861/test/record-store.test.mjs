/**
 * P2-D record store unit tests: the file/state-backed authority keeps complete C6
 * records (adoption provenance chains, cross-record derivedFrom) and withdrawal
 * propagates recursively through the same frozen planner as the database path.
 * No database required.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyAdoption } from "../src/contracts/memory.ts";
import { digest } from "../src/contracts/hash.ts";
import { IdempotencyConflict, VersionConflict } from "../src/contracts/storage.ts";
import { FileStateStore } from "../src/live/store.ts";
import { RecordMemory, emptyRecordStoreState } from "../src/live/record-store.ts";

const principal = {
	tenantId: "t1",
	principalId: "agent1",
	readScopes: ["project:p1", "project:p2"],
	writeScopes: ["project:p1", "project:p2"],
};

function record(overrides = {}) {
	return {
		id: "source",
		scope: { kind: "project", key: "p1" },
		purpose: "project",
		abstract: "source abstract",
		overview: "source overview",
		full: "source evidence text",
		provenance: [{ sourceKind: "user", ref: "event:1", at: 1000 }],
		derivedFrom: [],
		revision: 1,
		status: "candidate",
		updatedAt: 1000,
		...overrides,
	};
}

test("record put preserves adoption chains and derivedFrom; withdrawal propagates recursively", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi861-record-store-"));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const memory = new RecordMemory(new FileStateStore(join(dir, "records.json"), emptyRecordStoreState()), principal);

	const first = await memory.putRecord({ requestId: "r1", expectedRevision: null, record: record() });
	assert.equal(first.revision, 1);
	const stored = await memory.getRecord("project:p1", "source");
	assert.equal(stored.provenance.length, 1);

	// Adoption (P2-M pattern): the frozen contract appends verified provenance.
	const adopted = applyAdoption(await memory.getRecord("project:p1", "source"), {
		version: 1,
		recordId: "source",
		scope: "project:p1",
		adoptedAt: 2000,
		acceptanceEvidenceDigest: digest(["acceptance", "evidence"]),
		adoptedBy: "integration-acceptance",
	});
	const second = await memory.putRecord({ requestId: "r2", expectedRevision: 1, record: adopted });
	assert.equal(second.revision, 2);
	assert.deepEqual((await memory.getRecord("project:p1", "source")).provenance.map((entry) => entry.sourceKind), [
		"user",
		"verified",
	]);

	// Cross-record derivation chain the item facade cannot express.
	await memory.putRecord({
		requestId: "d1",
		expectedRevision: null,
		record: record({
			id: "direct",
			scope: { kind: "project", key: "p2" },
			purpose: "experience",
			abstract: "summary",
			overview: "summary overview",
			full: "summary of the source",
			provenance: [{ sourceKind: "tool", ref: "pi-session:s/tool:1", at: 3000 }],
			derivedFrom: [{ scope: "project:p1", id: "source", revision: 2 }],
		}),
	});
	await memory.putRecord({
		requestId: "d2",
		expectedRevision: null,
		record: record({
			id: "transitive",
			purpose: "experience",
			abstract: "summary of summary",
			overview: "transitive overview",
			full: "summary of the summary",
			provenance: [{ sourceKind: "tool", ref: "pi-session:s/tool:2", at: 3100 }],
			derivedFrom: [{ scope: "project:p2", id: "direct", revision: 1 }],
		}),
	});

	// Recursive withdrawal: source, direct and transitive derivatives all die.
	const withdrawn = await memory.withdraw("w1", "project:p1", "source", 2);
	assert.equal(withdrawn.revision, 3);
	assert.equal(await memory.getRecord("project:p1", "source"), undefined);
	assert.equal(await memory.getRecord("project:p2", "direct"), undefined);
	assert.equal(await memory.getRecord("project:p1", "transitive"), undefined);
	const state = await memory.read();
	const statuses = new Map(state.records.map((row) => [row.id, row.status]));
	assert.equal(statuses.get("source"), "withdrawn");
	assert.equal(statuses.get("direct"), "withdrawn");
	assert.equal(statuses.get("transitive"), "withdrawn");
	assert.ok(state.tombstones.length >= 3);

	// Old sources cannot revive: with the CAS satisfied, the tombstoned provenance
	// ref and the withdrawn previous state both refuse the restoration.
	await assert.rejects(
		memory.putRecord({ requestId: "revive", expectedRevision: 3, record: record({ full: "paraphrased" }) }),
		/Withdrawn memory requires explicit restoration/,
	);
});

test("record put idempotency, compare-and-set and derivation validation", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "pi861-record-store-2-"));
	t.after(async () => {
		await rm(dir, { recursive: true, force: true });
	});
	const memory = new RecordMemory(new FileStateStore(join(dir, "records.json"), emptyRecordStoreState()), principal);
	const first = await memory.putRecord({ requestId: "r1", expectedRevision: null, record: record() });
	assert.deepEqual(
		await memory.putRecord({ requestId: "r1", expectedRevision: null, record: record() }),
		first,
	);
	await assert.rejects(
		memory.putRecord({ requestId: "r1", expectedRevision: null, record: record({ full: "different" }) }),
		IdempotencyConflict,
	);
	await assert.rejects(
		memory.putRecord({ requestId: "r2", expectedRevision: 7, record: record({ full: "cas" }) }),
		VersionConflict,
	);
	// Derivation targets must exist, be live, and not be in the future.
	await assert.rejects(
		memory.putRecord({
			requestId: "r3",
			expectedRevision: null,
			record: record({ id: "bad1", derivedFrom: [{ scope: "project:p1", id: "missing", revision: 1 }] }),
		}),
		/Unknown derivation source/,
	);
	await assert.rejects(
		memory.putRecord({
			requestId: "r4",
			expectedRevision: null,
			record: record({ id: "bad2", derivedFrom: [{ scope: "project:p1", id: "source", revision: 99 }] }),
		}),
		/revision is in the future/,
	);
	await assert.rejects(
		memory.putRecord({
			requestId: "r5",
			expectedRevision: null,
			record: record({ id: "bad3", derivedFrom: [{ scope: "project:secret", id: "source", revision: 1 }] }),
		}),
		/not readable/,
	);
	// Cross-scope writes stay denied; withdrawn-status writes are rejected.
	await assert.rejects(
		memory.putRecord({ requestId: "r6", expectedRevision: null, record: record({ scope: { kind: "project", key: "p3" } }) }),
		/scope not authorized/,
	);
	await assert.rejects(
		memory.putRecord({ requestId: "r7", expectedRevision: null, record: record({ status: "withdrawn" }) }),
		/Use withdraw/,
	);
	// Withdrawal idempotency: replay returns the same receipt, different intent conflicts.
	const withdrawn = await memory.withdraw("w1", "project:p1", "source", 1);
	assert.deepEqual(await memory.withdraw("w1", "project:p1", "source", 1), withdrawn);
	await assert.rejects(memory.withdraw("w1", "project:p1", "source", 2), IdempotencyConflict);
});
