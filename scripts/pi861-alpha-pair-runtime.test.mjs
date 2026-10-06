import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAlphaPairEvent, createAlphaPair } from "../extensions/pi861/src/live/alpha-pair-runtime.ts";

const version = "req-v1";
const hash = "a".repeat(64);

function admitted(main = "model-main", shadow = "model-shadow") {
	return applyAlphaPairEvent(
		createAlphaPair("fixture-pair", version),
		{ type: "admit", requirementVersion: version, mainModel: main, shadowModel: shadow },
	);
}

function reviewing() {
	let state = admitted();
	state = applyAlphaPairEvent(state, {
		type: "shadow-prepared",
		requirementVersion: version,
		evidenceRefs: ["e1"],
		checks: ["c1"],
	});
	return applyAlphaPairEvent(state, { type: "candidate", requirementVersion: version, artifactHash: hash });
}

test("main and shadow complete offline paired lifecycle", () => {
	const state = applyAlphaPairEvent(reviewing(), {
		type: "review",
		requirementVersion: version,
		artifactHash: hash,
		verdict: "pass",
	});
	assert.equal(state.phase, "accepted");
	assert.deepEqual(state.evidenceRefs, ["e1"]);
});

test("rejects empty model identities", () => {
	assert.throws(() => admitted("", "shadow"));
	assert.throws(() => admitted("main", ""));
});

test("rejects empty evidence and checks", () => {
	const state = admitted();
	assert.throws(() => applyAlphaPairEvent(state, {
		type: "shadow-prepared",
		requirementVersion: version,
		evidenceRefs: [""],
		checks: ["c"],
	}));
	assert.throws(() => applyAlphaPairEvent(state, {
		type: "shadow-prepared",
		requirementVersion: version,
		evidenceRefs: ["e"],
		checks: [""],
	}));
});

test("rejects unknown review verdict and preserves review evidence", () => {
	const state = reviewing();
	assert.throws(() => applyAlphaPairEvent(state, {
		type: "review",
		requirementVersion: version,
		artifactHash: hash,
		verdict: "retry",
	}));
	assert.deepEqual(state.evidenceRefs, ["e1"]);
	assert.deepEqual(state.checks, ["c1"]);
});

test("rejects stale requirement, wrong artifact review and cancellation reuse", () => {
	const state = reviewing();
	assert.throws(() => applyAlphaPairEvent(state, {
		type: "review",
		requirementVersion: "old",
		artifactHash: hash,
		verdict: "pass",
	}));
	assert.throws(() => applyAlphaPairEvent(state, {
		type: "review",
		requirementVersion: version,
		artifactHash: "b".repeat(64),
		verdict: "pass",
	}));
	const cancelled = applyAlphaPairEvent(state, { type: "cancel", requirementVersion: version });
	assert.equal(cancelled.phase, "cancelled");
	assert.throws(() => applyAlphaPairEvent(cancelled, { type: "cancel", requirementVersion: version }));
});

// Offline host fixture only. It does not prove A5 production dispatch is complete.
