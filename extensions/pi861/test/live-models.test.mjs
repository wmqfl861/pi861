import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { SharedHealthService } from "../src/live/health-service.ts";
import { ModelRuntime, RequestBudget } from "../src/live/model-runtime.ts";
import { emptyUsageLedger, ModelRequestService, ModelUsageService } from "../src/live/model-service.ts";
import { faultDomainKey, ModelFailure } from "../src/routing.ts";

const targets = [
	{
		id: "cheap",
		revision: "1",
		provider: "test",
		model: "cheap",
		quality: 1,
		costRank: 1,
		contextWindow: 10000,
		capabilities: ["tools"],
		enabled: true,
		// Explicit zero pricing: the cost is known to be zero, which is not an unknown written as zero.
		billing: { inputPerMt: 0, outputPerMt: 0, cacheReadPerMt: 0, cacheWritePerMt: 0 },
	},
	{
		id: "strong",
		revision: "1",
		provider: "test",
		model: "strong",
		quality: 3,
		costRank: 3,
		contextWindow: 10000,
		capabilities: ["tools"],
		enabled: true,
		billing: { inputPerMt: 0, outputPerMt: 0, cacheReadPerMt: 0, cacheWritePerMt: 0 },
	},
];
function policy(patch = {}) {
	return {
		targets,
		preferred: "cheap",
		requirements: { minQuality: 1, contextTokens: 100, capabilities: ["tools"], allowedIds: ["cheap", "strong"] },
		recovery: {
			failoverEnabled: true,
			failbackEnabled: true,
			probeIntervalMs: 20,
			maxProbeIntervalMs: 100,
			requiredProbeSuccesses: 2,
		},
		maxAttempts: 3,
		requestTimeoutMs: 500,
		maxRequests: 20,
		maxProbeRequests: 5,
		...patch,
	};
}
const signal = () => new AbortController().signal;
const measures = {
	estimate: { inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
	unknownEstimate: { inputTokens: 2000, outputTokens: 2000, cacheReadTokens: 100, cacheWriteTokens: 100, costUsd: 0.01 },
};
function memoryStore(initial) {
	let state = structuredClone(initial),
		tail = Promise.resolve();
	return {
		read: async () => structuredClone(state),
		update(fn) {
			const result = tail.then(async () => {
				const next = structuredClone(state);
				const value = await fn(next);
				state = next;
				return value;
			});
			tail = result.catch(() => {});
			return result;
		},
	};
}
function usageService(store) {
	return new ModelUsageService(store, { ...measures, budgetId: "runtime-budget" });
}
function gates() {
	let resolve;
	const promise = new Promise((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
test("fixed route classifies once then escalates on a concrete gap", async () => {
	let classifications = 0;
	const seen = [];
	const runtime = new ModelRuntime(
		policy(),
		async (m) => {
			seen.push(m.id);
			return m.id;
		},
		async () => true,
		{
			classify: async () => {
				classifications++;
				return { mode: "fixed", targetId: "cheap", minQuality: 1, reason: "stable" };
			},
		},
	);
	try {
		runtime.setTask("stable task");
		await runtime.call({}, signal());
		await runtime.call({}, signal());
		assert.equal(classifications, 1);
		runtime.report("capability_gap");
		await runtime.call({}, signal());
		assert.deepEqual(seen, ["cheap", "cheap", "strong"]);
		assert.equal(runtime.state.preferred, "strong");
	} finally {
		runtime.close();
	}
});
test("failover holds the original goal and auto failback waits for next inference", async () => {
	let broken = true;
	const seen = [];
	const runtime = new ModelRuntime(
		policy(),
		async (m) => {
			seen.push(m.id);
			if (m.id === "cheap" && broken) throw new ModelFailure("transient");
			return m.id;
		},
		async () => true,
	);
	try {
		assert.equal(await runtime.call({}, signal()), "strong");
		assert.equal(runtime.state.preferred, "cheap");
		broken = false;
		await runtime.checkRecovery(Date.now() + 500);
		await runtime.checkRecovery(Date.now() + 1000);
		assert.equal(runtime.state.active, "strong");
		assert.equal(await runtime.call({}, signal()), "cheap");
		assert.deepEqual(seen, ["cheap", "strong", "cheap"]);
	} finally {
		runtime.close();
	}
});
test("disabled failover never calls backup", async () => {
	const p = policy();
	p.recovery.failoverEnabled = false;
	let calls = 0;
	const runtime = new ModelRuntime(
		p,
		async () => {
			calls++;
			throw new ModelFailure("transient");
		},
		async () => true,
	);
	try {
		await assert.rejects(runtime.call({}, signal()));
		assert.equal(calls, 1);
	} finally {
		runtime.close();
	}
});
test("disabled failback issues no probes", async () => {
	const p = policy();
	p.recovery.failbackEnabled = false;
	let probes = 0;
	const runtime = new ModelRuntime(
		p,
		async (m) => {
			if (m.id === "cheap") throw new ModelFailure("transient");
			return m.id;
		},
		async () => {
			probes++;
			return true;
		},
	);
	try {
		await runtime.call({}, signal());
		await runtime.checkRecovery(Date.now() + 1000);
		await sleep(25);
		assert.equal(probes, 0);
	} finally {
		runtime.close();
	}
});
test("cancellation never starts backup", async () => {
	const p = policy({ requestTimeoutMs: 30 });
	const ac = new AbortController();
	let calls = 0;
	const runtime = new ModelRuntime(
		p,
		async () => {
			calls++;
			await sleep(100);
			return "late";
		},
		async () => new Promise(() => {}),
	);
	const running = runtime.call({}, ac.signal);
	setTimeout(() => ac.abort(), 5);
	try {
		await assert.rejects(running);
		assert.equal(calls, 1);
	} finally {
		runtime.close();
	}
});
test("global request allowance is atomic and idempotent", async () => {
	const state = { limit: 2, used: 0, intents: {} };
	let tail = Promise.resolve();
	const store = {
		read: async () => structuredClone(state),
		update(fn) {
			const result = tail.then(() => fn(state));
			tail = result.catch(() => {});
			return result;
		},
	};
	const a = new RequestBudget(store),
		b = new RequestBudget(store);
	await Promise.all([a.reserve("same"), b.reserve("same")]);
	assert.equal(state.used, 1);
	await a.reserve("second");
	await assert.rejects(b.reserve("third"));
	assert.equal(state.used, 2);
});
test("backup state and request accounting survive a runtime replacement", async () => {
	const p = policy();
	p.recovery.failbackEnabled = false;
	const first = new ModelRuntime(
		p,
		async (m) => {
			if (m.id === "cheap") throw new ModelFailure("transient");
			return m.id;
		},
		async () => true,
	);
	first.setTask("persistent task");
	await first.call({}, signal());
	const checkpoint = first.checkpoint;
	first.close();
	const second = new ModelRuntime(
		p,
		async (m) => m.id,
		async () => true,
	);
	try {
		second.restore(checkpoint);
		second.setTask("persistent task");
		assert.equal(second.state.active, "strong");
		assert.equal(second.state.requests, 2);
		assert.equal(await second.call({}, signal()), "strong");
		assert.equal(second.state.requests, 3);
	} finally {
		second.close();
	}
});

test("direct reception answers once without another inference", async (t) => {
	let classifications = 0,
		inferences = 0;
	const runtime = new ModelRuntime(
		policy(),
		async () => {
			inferences++;
			return "inferred";
		},
		async () => true,
		{
			classify: async () => {
				classifications++;
				return { mode: "direct", targetId: "cheap", minQuality: 1, reason: "complete", directAnswer: "42" };
			},
		},
		undefined,
		{ directResponse: (answer) => answer },
	);
	t.after(() => runtime.close());
	runtime.setTask("answer");
	assert.equal(await runtime.call({}, signal()), "42");
	assert.equal(inferences, 0);
	assert.equal(classifications, 1);
	assert.equal(await runtime.call({}, signal()), "inferred");
	assert.equal(classifications, 1);
});

test("dynamic decisions receive persisted evidence and new tasks reset it", async (t) => {
	const summaries = [];
	const classify = {
		classify: async (_task, _targets, _signal, evidence) => {
			summaries.push(evidence);
			return { mode: "dynamic", targetId: "cheap", minQuality: 1, reason: "assessed" };
		},
	};
	const first = new ModelRuntime(
		policy(),
		async (m) => m.id,
		async () => true,
		classify,
	);
	t.after(() => first.close());
	first.setTask("task");
	await first.call({}, signal());
	first.report("no_progress", "loop repeated", {
		phase: "implementation",
		verification: "assertion failed",
		scopeDelta: "new files",
	});
	const second = new ModelRuntime(
		policy(),
		async (m) => m.id,
		async () => true,
		classify,
	);
	t.after(() => second.close());
	assert.equal(second.restore(first.checkpoint), true);
	second.setTask("task");
	await second.call({}, signal());
	assert.deepEqual(summaries.at(-1).recentReasons, ["loop repeated"]);
	assert.deepEqual(summaries.at(-1).verificationResults, ["assertion failed"]);
	assert.equal(summaries.at(-1).phase, "implementation");
	assert.equal(summaries.at(-1).scopeDelta, "new files");
	assert.equal(summaries.at(-1).noProgressCount, 1);
	second.setTask("different task");
	await second.call({}, signal());
	assert.equal(summaries.at(-1).events.length, 0);
	second.report("verification_failed", "first failure");
	await second.call({}, signal());
	assert.equal(second.state.preferred, "cheap");
});

test("classifier failure falls back safely, strict mode pauses, and checkpoint conflicts are visible", async (t) => {
	const classifier = {
		classify: async () => {
			throw new Error("offline");
		},
	};
	const runtime = new ModelRuntime(
		policy(),
		async (m) => m.id,
		async () => true,
		classifier,
	);
	t.after(() => runtime.close());
	runtime.setTask("task");
	assert.equal(await runtime.call({}, signal()), "cheap");
	assert.match(runtime.state.reason, /Classifier unavailable/);
	const checkpoint = runtime.checkpoint;
	checkpoint.policyHash = "conflict";
	assert.equal(runtime.restore(checkpoint), false);
	assert.match(runtime.state.reason, /conflict/);
	const strict = new ModelRuntime(
		policy(),
		async () => assert.fail("no transport"),
		async () => true,
		classifier,
		undefined,
		{ strictClassifier: true },
	);
	t.after(() => strict.close());
	strict.setTask("task");
	await assert.rejects(strict.call({}, signal()), /offline/);
	assert.equal(strict.state.paused, "classifier_failed");
});

test("downgrade requires trusted acceptance and verification at an idle boundary", async (t) => {
	const runtime = new ModelRuntime(
		policy(),
		async (m) => m.id,
		async () => true,
	);
	t.after(() => runtime.close());
	runtime.report("capability_gap", "harder work");
	assert.equal(await runtime.call({}, signal()), "strong");
	runtime.report("phase_complete", "model says done");
	assert.equal(await runtime.call({}, signal()), "strong");
	runtime.report("phase_complete", "host accepted", { verificationPassed: true, phaseAccepted: true });
	await assert.rejects(runtime.call({}, signal(), 1), /reconcile/);
	assert.equal(runtime.state.preferred, "strong");
	assert.equal(await runtime.call({}, signal(), 0), "cheap");
});

test("dynamic route cannot lower quality before a verified accepted phase", async (t) => {
	let calls = 0;
	const runtime = new ModelRuntime(
		policy(),
		async (m) => m.id,
		async () => true,
		{
			classify: async () => ({
				mode: "dynamic",
				targetId: ++calls === 1 ? "strong" : "cheap",
				minQuality: calls === 1 ? 3 : 1,
				reason: "candidate",
			}),
		},
	);
	t.after(() => runtime.close());
	runtime.setTask("task");
	assert.equal(await runtime.call({}, signal()), "strong");
	runtime.report("scope_changed", "smaller task");
	assert.equal(await runtime.call({}, signal()), "strong");
	runtime.report("phase_complete", "checked", { verificationPassed: true, phaseAccepted: true });
	assert.equal(await runtime.call({}, signal()), "cheap");
});

test("new evidence, not the initial input alone, changes the decision", async (t) => {
	const summaries = [];
	const classify = {
		classify: async (_task, _candidates, _signal, evidence) => {
			summaries.push(evidence);
			const expanded = evidence !== undefined && evidence.events.some((event) => event.kind === "scope_changed");
			return expanded
				? { mode: "fixed", targetId: "strong", minQuality: 3, reason: "scope grew; stronger model" }
				: { mode: "fixed", targetId: "cheap", minQuality: 1, reason: "stable task" };
		},
	};
	const runtime = new ModelRuntime(policy(), async (m) => m.id, async () => true, classify);
	t.after(() => runtime.close());
	runtime.setTask("same task text");
	assert.equal(await runtime.call({}, signal()), "cheap");
	assert.equal(await runtime.call({}, signal()), "cheap"); // No new evidence: the classifier does not rerun.
	runtime.report("scope_changed", "rewrite step added", { scopeDelta: "rewrite" });
	assert.equal(await runtime.call({}, signal()), "strong");
	assert.equal(summaries.length, 2);
	assert.equal(summaries[1].scopeDelta, "rewrite");
	assert.match(runtime.state.reason, /scope grew/);
});

test("runtime rejects concurrent calls and task replacement during inference", async (t) => {
	const started = gates(),
		finish = gates();
	let calls = 0;
	const runtime = new ModelRuntime(
		policy(),
		async () => {
			calls++;
			started.resolve();
			return finish.promise;
		},
		async () => true,
	);
	t.after(() => runtime.close());
	const running = runtime.call({}, signal());
	await started.promise;
	await assert.rejects(runtime.call({}, signal()), /already active/);
	assert.throws(() => runtime.setTask("changed"), /idle/);
	finish.resolve("complete");
	assert.equal(await running, "complete");
	assert.equal(calls, 1);
});

test("exhausted targets persist a pause until stable probes restore admission", async (t) => {
	const p = policy();
	p.recovery.probeIntervalMs = 10000;
	p.recovery.maxProbeIntervalMs = 20000;
	let broken = true,
		calls = 0;
	const runtime = new ModelRuntime(
		p,
		async (m) => {
			calls++;
			if (broken) throw new ModelFailure("transient");
			return m.id;
		},
		async () => true,
	);
	t.after(() => runtime.close());
	await assert.rejects(runtime.call({}, signal()));
	assert.equal(runtime.checkpoint.state.paused, "no_healthy_target");
	await assert.rejects(runtime.call({}, signal()), /paused/);
	assert.equal(calls, 2);
	assert.equal(runtime.resume(), false);
	broken = false;
	await runtime.checkRecovery(Date.now() + 30000);
	assert.equal(runtime.state.paused, "no_healthy_target");
	await runtime.checkRecovery(Date.now() + 60000);
	assert.equal(await runtime.call({}, signal()), "cheap");
});

test("execution, reception, auxiliary and probes share one ledger without double metering", async (t) => {
	const store = memoryStore(emptyUsageLedger());
	const usage = usageService(store);
	const requests = new ModelRequestService(usage);
	const p = policy();
	p.recovery.probeIntervalMs = 10000;
	p.recovery.maxProbeIntervalMs = 20000;
	const measured = { inputTokens: 5, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 1 };
	const classifier = {
		classify: async (_task, _models, classifySignal) =>
			requests.request(
				{ requestId: "classify", purpose: "reception", policy: p, signal: classifySignal },
				async (_model, _signal, _progress, onUsage) => {
					onUsage(measured);
					return { mode: "fixed", targetId: "cheap", minQuality: 1, reason: "ready" };
				},
			),
	};
	const runtime = new ModelRuntime(
		p,
		async (m, _context, _signal, _progress, onUsage) => {
			onUsage(measured); // Even the failed attempt reports its measured usage.
			if (m.id === "cheap") throw new ModelFailure("transient");
			return m.id;
		},
		async (_model, _signal, onUsage) => {
			onUsage(measured);
			return true;
		},
		classifier,
		undefined,
		{ requests },
	);
	t.after(() => runtime.close());
	runtime.setTask("task");
	assert.equal(await runtime.call({}, signal()), "strong");
	await runtime.checkRecovery(Date.now() + 30000);
	await requests.request(
		{ requestId: "enrich", purpose: "auxiliary", policy: p, signal: signal() },
		async (_model, _signal, _progress, onUsage) => {
			onUsage(measured);
			return "ok";
		},
	);
	const totals = await usage.totals();
	assert.equal(totals.attempts, 5);
	assert.deepEqual(totals.byPurpose, {
		execution: 2,
		reception: 1,
		planning: 0,
		"skill-compile": 0,
		distill: 0,
		probe: 1,
		auxiliary: 1,
	});
	assert.equal(totals.unknownUsage, 0); // Zero-priced billing keeps the cost known.
	assert.deepEqual(totals.usage, { inputTokens: 25, outputTokens: 10, cacheReadTokens: 15, cacheWriteTokens: 5, costUsd: 0 });
});

test("new runtime skips a domain already failed in shared health", async (t) => {
	const store = memoryStore({ domains: {}, probesUsed: 0 });
	const health = new SharedHealthService(store, {
		probeLimit: 3,
		requiredSuccesses: 2,
		backoffMs: 10000,
		maxBackoffMs: 20000,
		minProbeIntervalMs: 10000,
		leaseTimeoutMs: 2000,
	});
	await health.recordFailure("test\ncheap", Date.now());
	const seen = [];
	const runtime = new ModelRuntime(
		policy(),
		async (m) => {
			seen.push(m.id);
			return m.id;
		},
		async () => true,
		undefined,
		undefined,
		{ health },
	);
	t.after(() => runtime.close());
	assert.equal(await runtime.call({}, signal()), "strong");
	assert.deepEqual(seen, ["strong"]);
});

test("auth failover never policy survives the next call and resume", async (t) => {
	const p = policy();
	p.recovery.authFailover = "never";
	let calls = 0;
	const runtime = new ModelRuntime(
		p,
		async () => {
			calls++;
			throw new ModelFailure("auth");
		},
		async () => true,
	);
	t.after(() => runtime.close());
	await assert.rejects(runtime.call({}, signal()));
	assert.equal(runtime.state.active, "cheap");
	assert.equal(runtime.resume(), false);
	await assert.rejects(runtime.call({}, signal()));
	assert.equal(calls, 1);
});

test("consumers sharing one health store and one budget probe exactly once", async (t) => {
	const healthStore = memoryStore({ domains: {}, probesUsed: 0 });
	const health = new SharedHealthService(healthStore, {
		probeLimit: 2,
		requiredSuccesses: 2,
		backoffMs: 500,
		maxBackoffMs: 1000,
		minProbeIntervalMs: 100,
		leaseTimeoutMs: 2000,
	});
	const ledgerStore = memoryStore(emptyUsageLedger());
	const usage = usageService(ledgerStore);
	const requests = new ModelRequestService(usage);
	let probeCalls = 0;
	const make = () =>
		new ModelRuntime(
			policy(),
			async (m) => {
				if (m.id === "cheap") throw new ModelFailure("transient");
				return m.id;
			},
			async () => {
				probeCalls++;
				return true;
			},
			undefined,
			undefined,
			{ requests, health },
		);
	const a = make(),
		b = make();
	t.after(() => {
		a.close();
		b.close();
	});
	await a.call({}, signal());
	await b.call({}, signal());
	// Both consumers want to probe the failed cheap domain; the shared lease admits one.
	await Promise.all([a.checkRecovery(Date.now() + 2000), b.checkRecovery(Date.now() + 2000)]);
	assert.equal(probeCalls, 1);
	assert.equal((await usage.totals()).byPurpose.probe, 1);
	assert.equal((await health.totals()).probesUsed, 1);
	// A second round is again shared, then the shared probe budget (probeLimit 2) stops probing.
	await Promise.all([a.checkRecovery(Date.now() + 4000), b.checkRecovery(Date.now() + 4000)]);
	assert.equal(probeCalls, 2);
	assert.equal((await usage.totals()).byPurpose.probe, 2);
	await Promise.all([a.checkRecovery(Date.now() + 6000), b.checkRecovery(Date.now() + 6000)]);
	assert.equal(probeCalls, 2); // Probe budget exhausted: no third probe.
	assert.equal((await health.totals()).probesUsed, 2);
});

test("a stale in-flight probe reservation joins instead of dispatching", async (t) => {
	const store = memoryStore(emptyUsageLedger());
	const usage = usageService(store);
	const requests = new ModelRequestService(usage);
	// A crashed consumer left its probe reservation open under this domain's key.
	const domain = faultDomainKey(targets[0]);
	await usage.reserve("ghost-probe", "probe", { probeKey: domain });
	let probeCalls = 0;
	const runtime = new ModelRuntime(
		policy(),
		async (m) => {
			if (m.id === "cheap") throw new ModelFailure("transient");
			return m.id;
		},
		async () => {
			probeCalls++;
			return true;
		},
		undefined,
		undefined,
		{ requests },
	);
	t.after(() => runtime.close());
	await runtime.call({}, signal());
	await runtime.checkRecovery(Date.now() + 5000);
	assert.equal(probeCalls, 0); // No second physical probe is dispatched.
	assert.equal(runtime.state.probes, 0); // No local probe budget consumed.
	assert.equal(runtime.state.paused, undefined);
	const totals = await usage.totals();
	assert.equal(totals.byPurpose.probe, 0);
	assert.equal(totals.unsettled, 1); // The ghost reservation still requires reconciliation.
});

test("exhausting the shared C3 budget pauses the runtime without dispatching", async (t) => {
	const store = memoryStore(emptyUsageLedger());
	const usage = new ModelUsageService(store, {
		...measures,
		budgetId: "bounded",
		rootLimits: { maxTotalCostUsd: 100, maxAttempts: 2, maxInputTokens: 10_000_000, maxOutputTokens: 10_000_000 },
	});
	const requests = new ModelRequestService(usage);
	let calls = 0;
	const p = policy();
	p.recovery.failbackEnabled = false; // Keep the C3 attempt budget the only bound in play.
	const runtime = new ModelRuntime(
		p,
		async (m) => {
			calls++;
			if (m.id === "cheap") throw new ModelFailure("transient");
			return m.id;
		},
		async () => true,
		undefined,
		undefined,
		{ requests },
	);
	t.after(() => runtime.close());
	assert.equal(await runtime.call({}, signal()), "strong"); // cheap failure + strong success = 2 C3 attempts.
	await assert.rejects(runtime.call({}, signal()));
	assert.equal(runtime.state.paused, "budget_exhausted");
	assert.equal(calls, 2); // The third request was never dispatched.
	const totals = await usage.totals();
	assert.equal(totals.attempts, 2);
	assert.equal(totals.unsettled, 0);
});

test("an escalated preferred model is never overridden by old-domain recovery", async (t) => {
	const three = [
		targets[0],
		{ ...targets[0], id: "mid", model: "mid", quality: 2, costRank: 2 },
		targets[1],
	];
	const p = policy();
	p.targets = three;
	p.requirements = { ...p.requirements, allowedIds: ["cheap", "mid", "strong"] };
	p.recovery.probeIntervalMs = 5000; // Keep the unref'd probe timer outside the test window.
	p.recovery.maxProbeIntervalMs = 10000;
	let broken = true;
	const seen = [];
	const probed = [];
	const runtime = new ModelRuntime(
		p,
		async (m) => {
			seen.push(m.id);
			if (m.id === "cheap" && broken) throw new ModelFailure("transient");
			return m.id;
		},
		async (m) => {
			probed.push(m.id);
			return true;
		},
	);
	t.after(() => runtime.close());
	runtime.setTask("escalate me");
	assert.equal(await runtime.call({}, signal()), "mid"); // cheap fails; failover picks mid.
	await runtime.checkRecovery(Date.now() + 6000); // Partial recovery of old preferred cheap: 1/2 probes.
	assert.deepEqual(probed, ["cheap"]);
	runtime.report("capability_gap", "needs stronger");
	assert.equal(await runtime.call({}, signal()), "strong"); // Escalation moves preferred to strong.
	assert.equal(runtime.state.preferred, "strong");
	assert.equal(runtime.state.active, "strong");
	broken = false; // The old cheap domain fully recovers.
	await runtime.checkRecovery(Date.now() + 8000);
	await runtime.checkRecovery(Date.now() + 10000);
	assert.deepEqual(probed, ["cheap"]); // Probes target the CURRENT preferred; cheap is never probed again.
	assert.equal(await runtime.call({}, signal()), "strong");
	assert.equal(runtime.state.active, "strong"); // Failback only ever returns to the current preferred.
	assert.ok(seen.every((id, index) => index === 0 || id !== "cheap"));
});

test("the dispatch metering mode boundary is explicit (review N1)", async (t) => {
	const store = memoryStore(emptyUsageLedger());
	const usage = usageService(store);
	const requests = new ModelRequestService(usage);
	const meter = { begin: () => {}, end: () => {} };
	const infer = async (m) => m.id;
	const probe = async () => true;
	const service = new ModelRuntime(policy(), infer, probe, undefined, undefined, { requests });
	const legacy = new ModelRuntime(policy(), infer, probe, undefined, undefined, { meter });
	const unmetered = new ModelRuntime(policy(), infer, probe);
	t.after(() => {
		service.close();
		legacy.close();
		unmetered.close();
	});
	// Production compositions must inject hooks.requests; the other two modes exist only for the
	// basic host composition and are the explicit unmetered-dispatch boundary P3-I gates against.
	assert.equal(service.meteringMode, "service");
	assert.equal(legacy.meteringMode, "legacy");
	assert.equal(unmetered.meteringMode, "unmetered");
});

test("the runtime probe request budget bounds probe traffic", async (t) => {
	let probeCalls = 0;
	const runtime = new ModelRuntime(
		policy({ maxProbeRequests: 1 }),
		async (m) => {
			if (m.id === "cheap") throw new ModelFailure("transient");
			return m.id;
		},
		async () => {
			probeCalls++;
			return true;
		},
	);
	t.after(() => runtime.close());
	await runtime.call({}, signal());
	await runtime.checkRecovery(Date.now() + 5000);
	await runtime.checkRecovery(Date.now() + 6000);
	await runtime.checkRecovery(Date.now() + 7000);
	assert.equal(probeCalls, 1);
	assert.equal(runtime.state.probes, 1);
});
