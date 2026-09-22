import assert from "node:assert/strict";
import { test } from "node:test";
import { eligible, selectInitial, faultDomainKey, ModelRecovery, ModelFailure, inferWithRecovery } from "../src/routing.ts";

const models = [
	{ id: "cheap", revision: "1", provider: "p1", model: "a", quality: 1, costRank: 1, contextWindow: 100, capabilities: ["tools"], enabled: true },
	{ id: "strong", revision: "1", provider: "p2", model: "b", quality: 3, costRank: 3, contextWindow: 1000, capabilities: ["tools", "vision"], enabled: true },
	{ id: "backup", revision: "1", provider: "p3", model: "c", quality: 3, costRank: 4, contextWindow: 1000, capabilities: ["tools", "vision"], enabled: true },
];
const requirements = { minQuality: 3, contextTokens: 200, capabilities: ["tools"], allowedIds: ["cheap", "strong", "backup"] };
const defaults = { failoverEnabled: true, failbackEnabled: true, probeIntervalMs: 10, maxProbeIntervalMs: 100, requiredProbeSuccesses: 2 };
const make = (options = {}) => new ModelRecovery(models, "strong", requirements, { ...defaults, ...options });
const makeFrom = (targets) => new ModelRecovery(targets, "strong", requirements, defaults);

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
test("extended target configuration is validated and keys by fault domain", () => {
	assert.throws(() => makeFrom([{ ...models[1], faultDomain: { accountId: "", endpoint: "e" } }]));
	assert.throws(() => makeFrom([{ ...models[1], billing: { inputPerMt: -1, outputPerMt: 0, cacheReadPerMt: 0, cacheWritePerMt: 0 } }]));
	assert.throws(() => makeFrom([{ ...models[1], maxOutputTokens: 0 }]));
	assert.throws(() => makeFrom([{ ...models[1], dataEgress: "everywhere" }]));
	assert.throws(() => make({ sameTargetRetries: -1 }));
	assert.throws(() => make({ authFailover: "sometimes" }));
	assert.equal(faultDomainKey(models[1]), "p2\nb");
	assert.equal(faultDomainKey({ ...models[1], faultDomain: { accountId: "acct", endpoint: "edge" } }), "acct\nedge\np2");
});
test("transient failures retry the same target under the retry budget before failing over", async () => {
	const recovery = make({ sameTargetRetries: 2 });
	const called = [];
	const result = await inferWithRecovery(recovery, async (target) => {
		called.push(target.id);
		if (called.filter((id) => id === "strong").length <= 2) throw new ModelFailure("transient");
		return "recovered in place";
	}, { signal: new AbortController().signal, timeoutMs: 200, maxAttempts: 6, retryBackoffMs: 1 });
	assert.deepEqual(called, ["strong", "strong", "strong"]);
	assert.equal(result, "recovered in place");
	assert.equal(recovery.state.active, "strong");
	assert.deepEqual(recovery.state.health, []); // In-place retries never poison health.
});
test("exhausted same-target retries record health and fail over", async () => {
	const recovery = make({ sameTargetRetries: 1 });
	const called = [];
	const result = await inferWithRecovery(recovery, async (target) => {
		called.push(target.id);
		if (target.id === "strong") throw new ModelFailure("transient");
		return "backup result";
	}, { signal: new AbortController().signal, timeoutMs: 200, maxAttempts: 6, retryBackoffMs: 1 });
	assert.deepEqual(called, ["strong", "strong", "backup"]);
	assert.equal(result, "backup result");
	assert.equal(recovery.state.active, "backup");
	assert.equal(recovery.state.health.find((entry) => entry.id === "strong").failures, 1);
});
test("same-target retry honors Retry-After", async () => {
	const recovery = make({ sameTargetRetries: 1 });
	const started = Date.now();
	let calls = 0;
	await inferWithRecovery(recovery, async () => {
		calls++;
		if (calls === 1) throw new ModelFailure("rate-limit", 40);
		return "ok";
	}, { signal: new AbortController().signal, timeoutMs: 200, maxAttempts: 3, retryBackoffMs: 1 });
	assert.equal(calls, 2);
	assert.ok(Date.now() - started >= 40);
});
test("local quota exhaustion neither poisons health nor switches targets", async () => {
	const recovery = make();
	let calls = 0;
	await assert.rejects(inferWithRecovery(recovery, async () => { calls++; throw new ModelFailure("quota"); },
		{ signal: new AbortController().signal, timeoutMs: 100, maxAttempts: 3 }), /quota/);
	assert.equal(calls, 1);
	assert.equal(recovery.state.active, "strong");
	assert.deepEqual(recovery.state.health, []);
});
test("a provider that never sends a first byte is fenced as transient", async () => {
	const recovery = make();
	const called = [];
	const result = await inferWithRecovery(recovery, async (target) => {
		called.push(target.id);
		if (target.id === "strong") return new Promise(() => {});
		return "backup result";
	}, { signal: new AbortController().signal, timeoutMs: 500, firstByteTimeoutMs: 15, maxAttempts: 3 });
	assert.deepEqual(called, ["strong", "backup"]);
	assert.equal(result, "backup result");
});
test("progress stalls are fenced by the idle deadline", async () => {
	const recovery = make();
	const called = [];
	const result = await inferWithRecovery(recovery, async (target, _attempt, _signal, onProgress) => {
		called.push(target.id);
		if (target.id === "strong") { onProgress("first-byte"); return new Promise(() => {}); }
		return "backup result";
	}, { signal: new AbortController().signal, timeoutMs: 500, progressIdleMs: 15, maxAttempts: 3 });
	assert.deepEqual(called, ["strong", "backup"]);
	assert.equal(result, "backup result");
});
test("an open circuit is never a failover candidate until probes mark it ready", () => {
	const spare = { id: "spare", revision: "1", provider: "p4", model: "d", quality: 3, costRank: 5, contextWindow: 1000, capabilities: ["tools", "vision"], enabled: true };
	const all = [...models, spare];
	const wide = { ...requirements, allowedIds: [...requirements.allowedIds, "spare"] };
	const recovery = new ModelRecovery(all, "strong", wide, defaults);
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	assert.equal(recovery.state.active, "backup");
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	assert.equal(recovery.state.active, "spare");
	assert.equal(recovery.fail(recovery.beginAttempt(), "transient", 0), false); // Every candidate is open.
	assert.equal(recovery.state.active, "spare");
	const first = recovery.beginProbe(10);
	recovery.finishProbe(first, true, 10);
	const second = recovery.beginProbe(20);
	recovery.finishProbe(second, true, 20);
	assert.equal(recovery.atBoundary(), true);
	assert.equal(recovery.state.active, "strong");
	assert.equal(recovery.fail(recovery.beginAttempt(), "transient", 0), false); // backup/spare stay open.
	assert.equal(recovery.state.active, "strong");
});
test("one success decays failure history instead of erasing it", () => {
	const recovery = make({ failoverEnabled: false });
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	recovery.fail(recovery.beginAttempt(), "transient", 0);
	assert.equal(recovery.succeed(recovery.beginAttempt()), true);
	const strong = recovery.state.health.find((entry) => entry.id === "strong");
	assert.equal(strong.failures, 1);
	assert.equal(strong.ready, false); // Stability still requires probe confirmation.
});
test("service refusal (auth) only fails over across account domains", () => {
	const same = { accountId: "acct-a", endpoint: "https://one" };
	const other = { accountId: "acct-b", endpoint: "https://two" };
	const domainModels = [
		models[0],
		{ ...models[1], faultDomain: same },
		{ ...models[2], faultDomain: same },
		{ id: "spare", revision: "1", provider: "p4", model: "d", quality: 3, costRank: 5, contextWindow: 1000, capabilities: ["tools", "vision"], enabled: true, faultDomain: other },
	];
	const wide = { ...requirements, allowedIds: [...requirements.allowedIds, "spare"] };
	const split = new ModelRecovery(domainModels, "strong", wide, defaults);
	assert.equal(split.fail(split.beginAttempt(), "auth", 0), true);
	assert.equal(split.state.active, "spare");
	const never = new ModelRecovery(domainModels, "strong", wide, { ...defaults, authFailover: "never" });
	assert.equal(never.fail(never.beginAttempt(), "auth", 0), false);
	const any = new ModelRecovery(domainModels, "strong", wide, { ...defaults, authFailover: "any" });
	assert.equal(any.fail(any.beginAttempt(), "auth", 0), true);
	assert.equal(any.state.active, "backup");
	const undomained = make(); // Without declared domains a cross-account switch cannot be proven.
	assert.equal(undomained.fail(undomained.beginAttempt(), "auth", 0), false);
});
