import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAlphaPairEvent, createAlphaPair } from "../extensions/pi861/src/live/alpha-pair-runtime.ts";

const version = "req-v1";
const hash = "a".repeat(64);
let sequence = 0;
function event(agentId = "main") {
	return { eventId: `event-${++sequence}`, taskId: "task-1", agentId, time: Date.now(), version };
}
function admitted() {
	return applyAlphaPairEvent(createAlphaPair("fixture-pair", "task-1", version), {
		...event(),
		type: "admit",
		mainModel: "model-main",
		shadowModel: "model-shadow",
		mainAgentId: "main-agent",
		shadowAgentId: "shadow-agent",
	});
}
function reviewing() {
	let state = applyAlphaPairEvent(admitted(), { ...event("shadow-agent"), type: "shadow-prepared", evidenceRefs: ["e1"], checks: ["c1"] });
	return applyAlphaPairEvent(state, { ...event("main-agent"), type: "candidate", artifactHash: hash });
}

test("valid lifecycle preserves evidence and review record", () => {
	const state = applyAlphaPairEvent(reviewing(), { ...event("shadow-agent"), type: "review", artifactHash: hash, verdict: "pass" });
	assert.equal(state.phase, "accepted");
	assert.deepEqual(state.evidenceRefs, ["e1"]);
	assert.deepEqual(state.checks, ["c1"]);
	assert.equal(state.review?.verdict, "pass");
});

test("rejects stale version, duplicate event replay and malformed envelope", () => {
	let state = admitted();
	const cancel = { ...event(), type: "cancel" };
	state = applyAlphaPairEvent(state, cancel);
	assert.throws(() => applyAlphaPairEvent(state, cancel));
	assert.throws(() => applyAlphaPairEvent(admitted(), { ...cancel, version: "old", eventId: "new" }));
	assert.throws(() => applyAlphaPairEvent(admitted(), { ...cancel, eventId: "", time: 0 }));
});

test("rejects empty models, wrong actors and missing evidence", () => {
	assert.throws(() => applyAlphaPairEvent(createAlphaPair("p", "task-1", version), { ...event(), type: "admit", mainModel: "", shadowModel: "s", mainAgentId: "m", shadowAgentId: "s" }));
	assert.throws(() => applyAlphaPairEvent(admitted(), { ...event("main-agent"), type: "candidate", artifactHash: hash }));
	assert.throws(() => applyAlphaPairEvent(admitted(), { ...event("wrong"), type: "shadow-prepared", evidenceRefs: ["e"], checks: ["c"] }));
});

test("rejects wrong review actor, invalid hash and invalid verdict", () => {
	const state = reviewing();
	assert.throws(() => applyAlphaPairEvent(state, { ...event("main-agent"), type: "review", artifactHash: hash, verdict: "pass" }));
	assert.throws(() => applyAlphaPairEvent(state, { ...event("shadow-agent"), type: "review", artifactHash: "bad", verdict: "pass" }));
	assert.throws(() => applyAlphaPairEvent(state, { ...event("shadow-agent"), type: "review", artifactHash: hash, verdict: "retry" }));
});

// Offline host fixture only. It does not prove A5 production dispatch is complete.
