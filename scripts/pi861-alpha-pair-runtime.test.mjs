import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAlphaPairEvent, createAlphaPair } from "../extensions/pi861/src/live/alpha-pair-runtime.ts";

const version = "req-v1";
const hash = "a".repeat(64);
let sequence = 0;
function envelope(agentId = "main") {
	return { eventId: `event-${++sequence}`, taskId: "task-1", agentId, time: Date.now(), version };
}
function admitted() {
	return applyAlphaPairEvent(createAlphaPair("fixture-pair", "task-1", version), {
		...envelope(),
		type: "admit",
		mainModel: "model-main",
		shadowModel: "model-shadow",
	});
}
function reviewing() {
	let state = applyAlphaPairEvent(admitted(), { ...envelope("shadow"), type: "shadow-prepared", evidenceRefs: ["e1"], checks: ["c1"] });
	return applyAlphaPairEvent(state, { ...envelope("main"), type: "candidate", artifactHash: hash });
}

test("valid offline envelope lifecycle preserves evidence", () => {
	const state = applyAlphaPairEvent(reviewing(), { ...envelope("shadow"), type: "review", artifactHash: hash, verdict: "pass" });
	assert.equal(state.phase, "accepted");
	assert.deepEqual(state.evidenceRefs, ["e1"]);
	assert.deepEqual(state.checks, ["c1"]);
});

test("rejects stale version, duplicate event and malformed envelope", () => {
	const state = admitted();
	const event = { ...envelope(), type: "cancel" };
	applyAlphaPairEvent(state, event);
	assert.throws(() => applyAlphaPairEvent(state, event));
	assert.throws(() => applyAlphaPairEvent(state, { ...event, version: "old", eventId: "new" }));
	assert.throws(() => applyAlphaPairEvent(state, { ...event, eventId: "", time: 0 }));
});

test("rejects empty models, wrong actor and missing evidence", () => {
	assert.throws(() => applyAlphaPairEvent(createAlphaPair("p", "task-1", version), { ...envelope(), type: "admit", mainModel: "", shadowModel: "s" }));
	const state = admitted();
	assert.throws(() => applyAlphaPairEvent(state, { ...envelope("shadow"), type: "candidate", artifactHash: hash }));
});

test("rejects wrong review actor, invalid hash and invalid verdict", () => {
	const state = reviewing();
	assert.throws(() => applyAlphaPairEvent(state, { ...envelope("main"), type: "review", artifactHash: hash, verdict: "pass" }));
	assert.throws(() => applyAlphaPairEvent(state, { ...envelope("shadow"), type: "review", artifactHash: "bad", verdict: "pass" }));
	assert.throws(() => applyAlphaPairEvent(state, { ...envelope("shadow"), type: "review", artifactHash: hash, verdict: "retry" }));
});

// Offline host fixture only. It does not prove A5 production dispatch is complete.
