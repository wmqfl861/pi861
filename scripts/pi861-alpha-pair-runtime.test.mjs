import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAlphaPairEvent, createAlphaPair } from "../extensions/pi861/src/live/alpha-pair-runtime.ts";

const version = "req-v1";
const hash = "a".repeat(64);

function admitted() {
  return applyAlphaPairEvent(
    createAlphaPair("fixture-pair", version),
    { type: "admit", requirementVersion: version, mainModel: "model-main", shadowModel: "model-shadow" },
  );
}

test("main and shadow complete offline paired lifecycle", () => {
  let state = admitted();
  state = applyAlphaPairEvent(state, { type: "shadow-prepared", requirementVersion: version, evidenceRefs: ["e1"], checks: ["c1"] });
  state = applyAlphaPairEvent(state, { type: "candidate", requirementVersion: version, artifactHash: hash });
  state = applyAlphaPairEvent(state, { type: "review", requirementVersion: version, artifactHash: hash, verdict: "pass" });
  assert.equal(state.phase, "accepted");
});

test("rejects stale requirement and missing shadow preparation", () => {
  const state = admitted();
  assert.throws(() => applyAlphaPairEvent(state, { type: "candidate", requirementVersion: version, artifactHash: hash }));
  assert.throws(() => applyAlphaPairEvent(state, { type: "shadow-prepared", requirementVersion: "old", evidenceRefs: ["e"], checks: ["c"] }));
});

test("rejects wrong artifact review and supports cancellation", () => {
  let state = admitted();
  state = applyAlphaPairEvent(state, { type: "shadow-prepared", requirementVersion: version, evidenceRefs: ["e"], checks: ["c"] });
  state = applyAlphaPairEvent(state, { type: "candidate", requirementVersion: version, artifactHash: hash });
  assert.throws(() => applyAlphaPairEvent(state, { type: "review", requirementVersion: version, artifactHash: "b".repeat(64), verdict: "pass" }));
  state = applyAlphaPairEvent(state, { type: "cancel", requirementVersion: version });
  assert.equal(state.phase, "cancelled");
});

// This is an offline host fixture only. It does not prove A5 production dispatch is complete.
