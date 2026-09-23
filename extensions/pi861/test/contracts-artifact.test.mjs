import assert from "node:assert/strict";
import { test } from "node:test";
import { ControlledArtifactStore, ArtifactUnavailable, verifyArtifactContent, contentDigestOf } from "../src/contracts/artifact.ts";
import { AcceptanceLedger, evidenceDigest, summarizeOutcomes } from "../src/contracts/acceptance.ts";

const identity = { tenantId: "t", projectId: "p", goalId: "g", runId: "r", taskId: "task-1", attempt: 1 };
const producer = { readScopes: ["project:p"] };

test("artifacts are content-addressed and integrity-verified", () => {
	const store = new ControlledArtifactStore();
	const referenceOut = store.put("hello world", { scope: "project:p", producedBy: identity, now: 1 });
	assert.equal(referenceOut.byteSize, 11);
	assert.equal(referenceOut.contentDigest, contentDigestOf(new TextEncoder().encode("hello world")));
	assert.equal(verifyArtifactContent(new TextEncoder().encode("hello world"), referenceOut), true);
	assert.equal(verifyArtifactContent(new TextEncoder().encode("tampered"), referenceOut), false);
	const replay = store.put("hello world", { scope: "project:p", producedBy: identity, artifactId: referenceOut.artifactId, now: 2 });
	assert.equal(replay.contentDigest, referenceOut.contentDigest);
	assert.throws(() => store.put("other", { scope: "project:p", producedBy: identity, artifactId: referenceOut.artifactId, now: 3 }), /immutable/);
});

test("windows are bounded, offset-checked and report completeness", () => {
	const store = new ControlledArtifactStore();
	const referenceOut = store.put("abcdefghij", { scope: "project:p", producedBy: identity, now: 1 });
	const window = store.window(referenceOut.artifactId, producer, 2, 3);
	assert.equal(new TextDecoder().decode(window.content), "cde");
	assert.equal(window.complete, false);
	assert.equal(window.totalBytes, 10);
	const whole = store.window(referenceOut.artifactId, producer, 0, 10);
	assert.equal(whole.complete, true);
	const clamped = store.window(referenceOut.artifactId, producer, 8, 99);
	assert.equal(clamped.length, 2);
	assert.deepEqual(new TextDecoder().decode(clamped.content), "ij");
	assert.throws(() => store.window(referenceOut.artifactId, producer, -1, 3));
});

test("scope denial, revocation and missing ids fail uniformly without leaking existence", () => {
	const store = new ControlledArtifactStore();
	const referenceOut = store.put("secret", { scope: "project:p", producedBy: identity, now: 1 });
	const outsider = { readScopes: ["task:p/t1"] };
	assert.throws(() => store.describe(referenceOut.artifactId, outsider), ArtifactUnavailable);
	store.revoke(referenceOut.artifactId);
	const errors = [];
	for (const probe of [
		() => store.describe(referenceOut.artifactId, producer),
		() => store.describe("never-existed", producer),
		() => store.describe("never-existed", outsider),
	]) {
		try { probe(); } catch (error) { errors.push(error); }
	}
	assert.equal(errors.length, 3);
	assert.ok(errors.every((error) => error instanceof ArtifactUnavailable));
	assert.equal(new Set(errors.map((error) => error.message)).size, 2);
});

test("oversized artifacts are rejected against the configured limit", () => {
	const store = new ControlledArtifactStore({ maxArtifactBytes: 8 });
	assert.throws(() => store.put("too long for the limit", { scope: "project:p", producedBy: identity, now: 1 }), /size limit/);
	assert.throws(() => new ControlledArtifactStore({ maxArtifactBytes: 0 }));
});

test("F09 equal bytes preserve each scope and producer without exposing private metadata", () => {
	const store = new ControlledArtifactStore();
	const first = store.put("ok", { scope: "project:private", producedBy: identity, now: 1 });
	const otherProducer = { ...identity, projectId: "public", taskId: "other" };
	const second = store.put("ok", { scope: "project:public", producedBy: otherProducer, now: 2 });
	assert.notEqual(first.artifactId, second.artifactId);
	assert.equal(first.contentDigest, second.contentDigest);
	assert.equal(second.scope, "project:public");
	assert.deepEqual(second.producedBy, otherProducer);
	assert.equal(second.producedAt, 2);
	assert.throws(() => store.put("ok", { scope: "project:public", producedBy: otherProducer, artifactId: first.artifactId, now: 3 }), /immutable/);
	first.producedBy.projectId = "changed";
	assert.deepEqual(store.describe(first.artifactId, { readScopes: ["project:private"] }).producedBy, identity);
	store.revoke(first.artifactId);
	assert.equal(store.describe(second.artifactId, { readScopes: ["project:public"] }).scope, "project:public");
});

test("F10 nonzero automated exits never satisfy acceptance before or after restore", () => {
	for (const kind of ["structural-check", "behavioral-check"]) {
		const ledger = new AcceptanceLedger();
		ledger.record({ clauseId: "tests", kind, artifact: artifact(), passed: true, commandDigest: "cmd", exitCode: 1,
			summary: "failed process", recordedAt: 1, recordedBy: "checker", recorderKind: "trusted-automated-checker" });
		const clauses = [{ clauseId: "tests", description: "must pass", requiredEvidence: [kind] }];
		assert.equal(ledger.evaluate(clauses).accepted, false);
		const restored = new AcceptanceLedger();
		restored.restore(ledger.exportState());
		assert.equal(restored.evaluate(clauses).accepted, false);
	}
});

test("F10b restore applies every recorder rule atomically", () => {
	const valid = { clauseId: "c1", kind: "human-acceptance", artifact: artifact(), passed: true, summary: "accepted",
		recordedAt: 1, recordedBy: "user", recorderKind: "human" };
	const ledger = new AcceptanceLedger();
	ledger.record(valid);
	const before = ledger.exportState();
	for (const invalid of [
		{ ...valid, recorderKind: "agent" },
		{ ...valid, kind: "independent-review", recorderKind: "agent", reviewedWorkBy: "user" },
		{ ...valid, kind: "structural-check", recorderKind: "trusted-automated-checker" },
		{ ...valid, passed: "yes" },
	]) {
		assert.throws(() => ledger.restore({ version: 1, evidence: [valid, invalid] }));
		assert.deepEqual(ledger.exportState(), before);
	}
});

const artifact = () => new ControlledArtifactStore()
	.put("evidence bytes", { scope: "project:p", producedBy: identity, now: 1 });

const clause = { clauseId: "c1", description: "tests pass", requiredEvidence: ["structural-check", "behavioral-check", "independent-review", "human-acceptance"] };

test("automated evidence requires a trusted recorder, command digest and exit code", () => {
	const ledger = new AcceptanceLedger();
	const ref = artifact();
	assert.throws(() => ledger.record({ clauseId: "c1", kind: "structural-check", artifact: ref, passed: true, summary: "ok",
		recordedAt: 1, recordedBy: "checker", recorderKind: "agent" }), /trusted automated recorder/);
	assert.throws(() => ledger.record({ clauseId: "c1", kind: "structural-check", artifact: ref, passed: true, summary: "ok",
		recordedAt: 1, recordedBy: "checker", recorderKind: "trusted-automated-checker" }), /command digest/);
	ledger.record({ clauseId: "c1", kind: "structural-check", artifact: ref, passed: true, summary: "tsc clean",
		recordedAt: 1, recordedBy: "checker", recorderKind: "trusted-automated-checker", commandDigest: "cmd-1", exitCode: 0 });
	assert.equal(ledger.evidenceFor("c1").length, 1);
});

test("independent review must come from someone other than the implementer", () => {
	const ledger = new AcceptanceLedger();
	const ref = artifact();
	assert.throws(() => ledger.record({ clauseId: "c1", kind: "independent-review", artifact: ref, passed: true, summary: "looks fine",
		recordedAt: 1, recordedBy: "agent-1", recorderKind: "agent", reviewedWorkBy: "agent-1" }), /other than the implementer/);
	assert.throws(() => ledger.record({ clauseId: "c1", kind: "independent-review", artifact: ref, passed: true, summary: "looks fine",
		recordedAt: 1, recordedBy: "agent-1", recorderKind: "agent" }), /other than the implementer/);
	ledger.record({ clauseId: "c1", kind: "independent-review", artifact: ref, passed: true, summary: "reviewed",
		recordedAt: 1, recordedBy: "agent-2", recorderKind: "agent", reviewedWorkBy: "agent-1" });
	assert.equal(ledger.evidenceFor("c1").length, 1);
});

test("human acceptance is recorded only by a human principal", () => {
	const ledger = new AcceptanceLedger();
	const ref = artifact();
	assert.throws(() => ledger.record({ clauseId: "c1", kind: "human-acceptance", artifact: ref, passed: true, summary: "accepted",
		recordedAt: 1, recordedBy: "agent-1", recorderKind: "agent" }), /recorded by a human/);
	ledger.record({ clauseId: "c1", kind: "human-acceptance", artifact: ref, passed: true, summary: "user accepted",
		recordedAt: 1, recordedBy: "user-1", recorderKind: "human" });
	assert.equal(ledger.evidenceFor("c1").length, 1);
});

test("goal contract evaluation demands every required kind and failed checks never satisfy", () => {
	const ledger = new AcceptanceLedger();
	const ref = artifact();
	const partial = ledger.evaluate([clause]);
	assert.equal(partial.accepted, false);
	assert.equal(partial.missing.length, 4);
	ledger.record({ clauseId: "c1", kind: "structural-check", artifact: ref, passed: false, summary: "tsc failed",
		recordedAt: 1, recordedBy: "checker", recorderKind: "trusted-automated-checker", commandDigest: "cmd-1", exitCode: 2 });
	assert.equal(ledger.evaluate([clause]).missing.length, 4);
	ledger.record({ clauseId: "c1", kind: "structural-check", artifact: ref, passed: true, summary: "tsc clean",
		recordedAt: 2, recordedBy: "checker", recorderKind: "trusted-automated-checker", commandDigest: "cmd-1", exitCode: 0 });
	const afterOne = ledger.evaluate([clause]);
	assert.equal(afterOne.satisfied.length, 1);
	assert.equal(afterOne.missing.length, 3);
	assert.ok(afterOne.missing.every((item) => item.kind !== "structural-check"));
});

test("human acceptance never substitutes for automated or review evidence", () => {
	const ledger = new AcceptanceLedger();
	const ref = artifact();
	ledger.record({ clauseId: "c1", kind: "human-acceptance", artifact: ref, passed: true, summary: "user accepted",
		recordedAt: 1, recordedBy: "user-1", recorderKind: "human" });
	const evaluation = ledger.evaluate([clause]);
	assert.equal(evaluation.accepted, false);
	assert.ok(evaluation.missing.some((item) => item.kind === "independent-review"));
	assert.ok(evaluation.missing.some((item) => item.kind === "structural-check"));
	assert.ok(evaluation.missing.some((item) => item.kind === "behavioral-check"));
});

test("evidence digests bind clause, kind, artifact and outcome for reports", () => {
	const ref = artifact();
	const base = { clauseId: "c1", kind: "human-acceptance", artifact: ref, passed: true,
		summary: "accepted", recordedAt: 1, recordedBy: "user-1", recorderKind: "human" };
	assert.equal(evidenceDigest(base), evidenceDigest({ ...base }));
	assert.notEqual(evidenceDigest(base), evidenceDigest({ ...base, passed: false }));
	assert.notEqual(evidenceDigest(base), evidenceDigest({ ...base, clauseId: "c2" }));
});

test("acceptance snapshots round-trip and reject tampered entries", () => {
	const ledger = new AcceptanceLedger();
	const ref = artifact();
	ledger.record({ clauseId: "c1", kind: "human-acceptance", artifact: ref, passed: true, summary: "accepted",
		recordedAt: 1, recordedBy: "user-1", recorderKind: "human" });
	const snapshot = ledger.exportState();
	const restored = new AcceptanceLedger();
	restored.restore(snapshot);
	assert.equal(restored.evidenceFor("c1").length, 1);
	const forged = structuredClone(snapshot);
	forged.evidence[0].recorderKind = "bogus";
	assert.throws(() => new AcceptanceLedger().restore(forged), /Invalid acceptance/);
});

test("skip, not-run and blocked outcomes never satisfy a clause and never masquerade as pass", () => {
	const ledger = new AcceptanceLedger();
	const ref = artifact();
	const clauses = [{ clauseId: "c1", description: "must pass", requiredEvidence: ["structural-check"] }];
	for (const outcome of ["fail", "skip", "not-run", "blocked"]) {
		assert.throws(() => ledger.record({ clauseId: "c1", kind: "structural-check", artifact: ref, passed: true, outcome,
			commandDigest: "cmd", exitCode: 0, summary: `recorded as ${outcome}`, recordedAt: 1, recordedBy: "checker", recorderKind: "trusted-automated-checker" }),
			/agree with passed/);
		ledger.record({ clauseId: "c1", kind: "structural-check", artifact: ref, passed: false, outcome,
			commandDigest: "cmd", exitCode: 0, summary: `recorded as ${outcome}`, recordedAt: 1, recordedBy: "checker", recorderKind: "trusted-automated-checker" });
	}
	assert.equal(ledger.evaluate(clauses).accepted, false);
	ledger.record({ clauseId: "c1", kind: "structural-check", artifact: ref, passed: true, outcome: "pass",
		commandDigest: "cmd", exitCode: 0, summary: "clean", recordedAt: 2, recordedBy: "checker", recorderKind: "trusted-automated-checker" });
	assert.equal(ledger.evaluate(clauses).accepted, true);
	assert.throws(() => ledger.record({ clauseId: "c1", kind: "structural-check", artifact: ref, passed: true, outcome: "bogus",
		commandDigest: "cmd", exitCode: 0, summary: "x", recordedAt: 3, recordedBy: "checker", recorderKind: "trusted-automated-checker" }),
		/pass\/fail\/skip\/not-run\/blocked/);
	const restored = new AcceptanceLedger();
	restored.restore(ledger.exportState());
	assert.deepEqual(summarizeOutcomes(restored.exportState().evidence), [
		{ outcome: "blocked", count: 1 },
		{ outcome: "fail", count: 1 },
		{ outcome: "not-run", count: 1 },
		{ outcome: "pass", count: 1 },
		{ outcome: "skip", count: 1 },
	]);
});

test("outcome summaries derive pass/fail for evidence recorded without an explicit outcome", () => {
	const ref = artifact();
	const legacyPass = { clauseId: "c1", kind: "human-acceptance", artifact: ref, passed: true, summary: "ok",
		recordedAt: 1, recordedBy: "user-1", recorderKind: "human" };
	const legacyFail = { clauseId: "c2", kind: "independent-review", artifact: ref, passed: false, summary: "rejected",
		recordedAt: 2, recordedBy: "reviewer", recorderKind: "agent", reviewedWorkBy: "implementer" };
	assert.deepEqual(summarizeOutcomes([legacyPass, legacyFail]), [
		{ outcome: "fail", count: 1 },
		{ outcome: "pass", count: 1 },
	]);
	assert.deepEqual(summarizeOutcomes([]), []);
});
