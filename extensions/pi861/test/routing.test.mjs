import assert from "node:assert/strict";
import { test } from "node:test";
import { eligible, selectInitial, ModelRecovery, ModelFailure, inferWithRecovery } from "../src/routing.ts";

const models = [
	{ id: "cheap", revision: "1", provider: "p1", model: "a", quality: 1, costRank: 1, contextWindow: 100, capabilities: ["tools"], enabled: true },
	{ id: "strong", revision: "1", provider: "p2", model: "b", quality: 3, costRank: 3, contextWindow: 1000, capabilities: ["tools", "vision"], enabled: true },
	{ id: "backup", revision: "1", provider: "p3", model: "c", quality: 3, costRank: 4, contextWindow: 1000, capabilities: ["tools", "vision"], enabled: true },
];
const requirements = { minQuality: 3, contextTokens: 200, capabilities: ["tools"], allowedIds: ["cheap", "strong", "backup"] };
const defaults = { failoverEnabled: true, failbackEnabled: true, probeIntervalMs: 10, maxProbeIntervalMs: 100, requiredProbeSuccesses: 2 };
const make = (options = {}) => new ModelRecovery(models, "strong", requirements, { ...defaults, ...options });

test("quality, context, capability, and allowlist are hard filters", () => {
	assert.equal(eligible(models[0], requirements), false);
	assert.equal(eligible(models[1], { ...requirements, allowedIds: ["cheap"] }), false);
	assert.equal(eligible(models[1], { ...requirements, capabilities: ["audio"] }), false);
	assert.throws(() => selectInitial(models, { ...requirements, minQuality: 9 }, { canFinishDirectly: false, variableNeeds: true }));
});
test("mode and initial model are selected together", () => {
	assert.deepEqual(selectInitial(models, requirements, { canFinishDirectly: true, variableNeeds: false }), { mode: "direct", configId: "strong" });
	assert.equal(selectInitial(models, requirements, { canFinishDirectly: false, variableNeeds: false }).mode, "fixed");
	assert.equal(selectInitial(models, requirements, { canFinishDirectly: false, variableNeeds: true }).mode, "dynamic");
});
for (const failoverEnabled of [false, true]) for (const failbackEnabled of [false, true]) {
	test(`independent switches: fallback=${failoverEnabled}, return=${failbackEnabled}`, () => {
		const recovery = make({ failoverEnabled, failbackEnabled });
		assert.equal(recovery.fail(recovery.beginAttempt(), "transient", 0), failoverEnabled);
		assert.equal(recovery.state.preferred, "strong");
		assert.equal(recovery.state.active, failoverEnabled ? "backup" : "strong");
		assert.equal(!!recovery.beginProbe(10), failoverEnabled && failbackEnabled);
	});
}
test("two successful probes and an idle operation boundary are required for failback", () => {
	const recovery = make();
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	assert.equal(recovery.beginProbe(9), undefined);
	const first = recovery.beginProbe(10);
	assert.equal(recovery.beginProbe(10), undefined);
	recovery.finishProbe(first, true, 10);
	assert.equal(recovery.atBoundary(), false);
	const second = recovery.beginProbe(20);
	recovery.finishProbe(second, true, 20);
	assert.equal(recovery.atBoundary(1), false);
	const inFlight = recovery.beginAttempt();
	assert.equal(recovery.atBoundary(), false);
	recovery.succeed(inFlight);
	assert.equal(recovery.atBoundary(), true);
	assert.equal(recovery.state.active, "strong");
});
test("a new preferred model invalidates the old probe", () => {
	const recovery = make();
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	const probe = recovery.beginProbe(10);
	recovery.setPreferred("backup", requirements);
	assert.equal(recovery.finishProbe(probe, true, 20), false);
	assert.equal(recovery.atBoundary(), false);
});
test("turning off failover does not forcibly abandon an already active backup", () => {
	const recovery = make();
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	recovery.setOptions({ failoverEnabled: false });
	assert.equal(recovery.state.active, "backup");
	const probe = recovery.beginProbe(10);
	assert.ok(probe);
	recovery.setOptions({ failbackEnabled: false });
	assert.equal(recovery.finishProbe(probe, true, 11), false);
});
test("late successful output cannot revive a failed or cancelled attempt", () => {
	const recovery = make();
	const old = recovery.beginAttempt();
	recovery.fail(old, "transient", 0);
	assert.equal(recovery.succeed(old), false);
	const next = recovery.beginAttempt();
	recovery.cancel(next);
	assert.equal(recovery.succeed(next), false);
	assert.equal(recovery.state.inFlight, false);
});
for (const kind of ["cancelled", "invalid", "context"]) {
	test(`${kind} does not trigger fallback`, () => {
		const recovery = make();
		assert.equal(recovery.fail(recovery.beginAttempt(), kind, 0), false);
		assert.equal(recovery.state.active, "strong");
	});
}
test("retry-after and backoff are honored by probe eligibility", () => {
	const recovery = make();
	recovery.fail(recovery.beginAttempt(), "rate-limit", 0, 500);
	assert.equal(recovery.beginProbe(499), undefined);
	const probe = recovery.beginProbe(500);
	recovery.finishProbe(probe, false, 500);
	assert.equal(recovery.beginProbe(519), undefined);
	assert.ok(recovery.beginProbe(520));
});
test("buffered inference switches once after a classified transient failure", async () => {
	const recovery = make();
	const called = [];
	const result = await inferWithRecovery(recovery, async (target) => {
		called.push(target.id);
		if (target.id === "strong") throw new ModelFailure("transient");
		return "complete answer";
	}, { signal: new AbortController().signal, timeoutMs: 100, maxAttempts: 3 });
	assert.deepEqual(called, ["strong", "backup"]);
	assert.equal(result, "complete answer");
});
test("an unclassified programming error is not retried on another model", async () => {
	const recovery = make();
	let calls = 0;
	await assert.rejects(inferWithRecovery(recovery, async () => { calls++; throw new Error("programming bug"); },
		{ signal: new AbortController().signal, timeoutMs: 100, maxAttempts: 3 }), /invalid/);
	assert.equal(calls, 1);
});
test("deadline fences noncooperative provider output", async () => {
	const recovery = make();
	let release;
	const hung = new Promise((resolve) => { release = resolve; });
	const result = await inferWithRecovery(recovery, async (target) => target.id === "strong" ? hung : "backup result",
		{ signal: new AbortController().signal, timeoutMs: 10, maxAttempts: 2 });
	release("late original result");
	assert.equal(result, "backup result");
	assert.equal(recovery.state.active, "backup");
});
test("user cancellation never starts a backup request", async () => {
	const controller = new AbortController();
	const recovery = make();
	let calls = 0;
	await assert.rejects(inferWithRecovery(recovery, async () => {
		calls++;
		controller.abort(new Error("user cancelled"));
		return new Promise(() => {});
	}, { signal: controller.signal, timeoutMs: 100, maxAttempts: 3 }), /user cancelled/);
	assert.equal(calls, 1);
	assert.equal(recovery.state.inFlight, false);
});
test("invalid configuration is rejected", () => {
	assert.throws(() => make({ probeIntervalMs: 0 }));
	assert.throws(() => make({ requiredProbeSuccesses: 0 }));
	assert.throws(() => new ModelRecovery([...models, models[0]], "strong", requirements, defaults));
	assert.throws(() => make().setPreferred("cheap", requirements));
});
