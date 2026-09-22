import assert from "node:assert/strict";
import { test } from "node:test";
import { validateMemoryRecord, memoryFingerprints, planWithdrawal, assembleNecessaryContext } from "../src/contracts/memory.ts";

const record = (overrides = {}) => ({
	id: "mem-1",
	scope: { kind: "project", key: "pi861" },
	purpose: "project",
	abstract: "short",
	overview: "medium",
	full: "the complete fact with details",
	provenance: [{ sourceKind: "user", ref: "chat#1", at: 1 }],
	derivedFrom: [],
	revision: 1,
	status: "confirmed",
	updatedAt: 10,
	...overrides,
});

test("records validate their provenance chain and body bounds", () => {
	assert.doesNotThrow(() => validateMemoryRecord(record()));
	assert.throws(() => validateMemoryRecord(record({ provenance: [] })), /provenance/);
	assert.throws(() => validateMemoryRecord(record({ scope: { kind: "bogus", key: "x" } })), /canonical/);
	assert.throws(() => validateMemoryRecord(record({ full: " ".repeat(10) })), /non-empty/);
	assert.throws(() => validateMemoryRecord(record({ revision: 0 })), /revision/);
});

test("model inference cannot promote itself to confirmed fact or policy", () => {
	const inference = record({ provenance: [{ sourceKind: "inference", ref: "model-claim", at: 1 }] });
	assert.throws(() => validateMemoryRecord(inference), /cannot promote/);
	assert.doesNotThrow(() => validateMemoryRecord({ ...inference, status: "candidate" }));
	const constraint = record({ purpose: "constraint", provenance: [{ sourceKind: "verified", ref: "check", at: 1 }] });
	assert.throws(() => validateMemoryRecord(constraint), /Constraints require direct user provenance/);
});

test("fingerprints separate content from provenance and ignore whitespace noise", () => {
	const base = record();
	const sameContent = record({ full: "the complete fact   with details" });
	assert.equal(memoryFingerprints(base)[0], memoryFingerprints(sameContent)[0]);
	const otherContent = record({ full: "different" });
	assert.notEqual(memoryFingerprints(base)[0], memoryFingerprints(otherContent)[0]);
	const otherProvenance = record({ provenance: [{ sourceKind: "user", ref: "chat#2", at: 1 }] });
	assert.notEqual(memoryFingerprints(base)[1], memoryFingerprints(otherProvenance)[1]);
});

test("withdrawal planning lists the derivatives that must be withdrawn or rebuilt", () => {
	const source = record({ status: "withdrawn" });
	const derivative = record({ id: "mem-2", purpose: "experience",
		derivedFrom: [{ scope: "project:pi861", id: "mem-1", revision: 1 }],
		provenance: [{ sourceKind: "inference", ref: "distill", at: 2 }], status: "candidate" });
	const unrelated = record({ id: "mem-3", derivedFrom: [{ scope: "project:pi861", id: "other", revision: 1 }] });
	const plan = planWithdrawal(source, [derivative, unrelated, { ...derivative, status: "withdrawn" }]);
	assert.equal(plan.tombstones.length, 2);
	assert.deepEqual(plan.invalidDerivatives.map((link) => link.id), ["mem-2"]);
	assert.throws(() => planWithdrawal(record(), []), /withdrawn record itself/);
});

test("boot modes assemble constraints and working state but not long-term experience", () => {
	const items = [
		record({ id: "c1", purpose: "constraint", abstract: "always run tests", overview: "run tests", full: "always run the full deterministic suite" }),
		record({ id: "w1", purpose: "working", abstract: "current task", overview: "task state", full: "current task state details" }),
		record({ id: "e1", purpose: "experience", abstract: "lesson", overview: "a lesson", full: "a distilled lesson from earlier work" }),
	];
	const boot = assembleNecessaryContext(items, { mode: "startup", maxBytes: 10_000, readDepth: 0, readableScopes: ["project:pi861"] });
	assert.equal(boot.text.includes("always run tests"), true);
	assert.equal(boot.text.includes("a distilled lesson"), false);
	assert.deepEqual(boot.sections.map((section) => section.kind), ["constraint", "working"]);
	const recall = assembleNecessaryContext(items, { mode: "event-recall", maxBytes: 10_000, readDepth: 2, readableScopes: ["project:pi861"] });
	assert.equal(recall.text.includes("a distilled lesson from earlier work"), true);
});

test("assembly filters by readable scope and drops whole records at the byte budget", () => {
	const items = [
		record({ id: "c1", purpose: "constraint", full: "x".repeat(60) }),
		record({ id: "c2", purpose: "constraint", full: "y".repeat(60) }),
	];
	const scoped = assembleNecessaryContext(items, { mode: "takeover", maxBytes: 10_000, readDepth: 2, readableScopes: ["task:pi861/t1"] });
	assert.equal(scoped.text, "");
	assert.deepEqual(scoped.sections, []);
	const tight = assembleNecessaryContext(items, { mode: "takeover", maxBytes: 100, readDepth: 2, readableScopes: ["project:pi861"] });
	assert.ok(tight.omitted >= 1);
	assert.ok(tight.usedBytes <= 100);
	assert.throws(() => assembleNecessaryContext(items, { mode: "startup", maxBytes: 0, readDepth: 2, readableScopes: ["project:pi861"] }));
});

test("read depth selects abstract, overview or full per assembly", () => {
	const items = [record({ id: "c1", purpose: "constraint" })];
	const l0 = assembleNecessaryContext(items, { mode: "model-switch", maxBytes: 10_000, readDepth: 0, readableScopes: ["project:pi861"] });
	assert.equal(l0.text.includes("short"), true);
	const l1 = assembleNecessaryContext(items, { mode: "model-switch", maxBytes: 10_000, readDepth: 1, readableScopes: ["project:pi861"] });
	assert.equal(l1.text.includes("medium"), true);
	const l2 = assembleNecessaryContext(items, { mode: "model-switch", maxBytes: 10_000, readDepth: 2, readableScopes: ["project:pi861"] });
	assert.equal(l2.text.includes("the complete fact"), true);
});
