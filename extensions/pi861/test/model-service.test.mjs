import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ProbeInFlight, TaskTreeBudget } from "../src/contracts/budget.ts";
import { auxiliaryPort } from "../src/live/auxiliary-models.ts";
import {
	emptyUsageLedger,
	estimateCostUsd,
	ModelBudgetExhausted,
	ModelRequestService,
	ModelUsageService,
} from "../src/live/model-service.ts";
import { FileStateStore } from "../src/live/store.ts";
import { ModelFailure } from "../src/routing.ts";

const billing = { inputPerMt: 3, outputPerMt: 6, cacheReadPerMt: 0.3, cacheWritePerMt: 3.75 };
const measures = {
	estimate: { inputTokens: 50, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 },
	unknownEstimate: {
		inputTokens: 2000,
		outputTokens: 2000,
		cacheReadTokens: 100,
		cacheWriteTokens: 100,
		costUsd: 0.01,
	},
};
const rootLimits = { maxTotalCostUsd: 100, maxAttempts: 100, maxInputTokens: 10_000_000, maxOutputTokens: 10_000_000 };
function ledger(path = randomUUID(), limits = rootLimits) {
	const store = new FileStateStore(join(tmpdir(), `pi861-model-service-${path}.json`), emptyUsageLedger());
	const service = new ModelUsageService(store, {
		...measures,
		rootLimits: limits,
		budgetId: `budget-${path}`,
		recordLimit: 4,
		identityLimit: 10,
	});
	return { store, service, budgetId: `budget-${path}` };
}
const target = { id: "strong", provider: "p", model: "m", revision: "1", billing };
async function admit(service, requestId, purpose = "execution", admission = {}) {
	const { reservationId } = await service.reserve(requestId, purpose, admission);
	return reservationId;
}
const record = (requestId, reservationId, patch = {}) => ({
	requestId,
	purpose: "execution",
	target,
	startedAt: 1,
	finishedAt: 2,
	outcome: "success",
	reservationId,
	...patch,
});

test("admission is idempotent per request identity", async () => {
	const { service } = ledger();
	assert.equal((await service.reserve("goal-1-plan", "planning")).admitted, true);
	const replay = await service.reserve("goal-1-plan", "planning");
	assert.equal(replay.admitted, false);
	assert.equal(replay.reservationId.startsWith("r-"), true);
	const totals = await service.totals();
	assert.equal(totals.attempts, 0); // Admission alone books nothing.
	await assert.rejects(service.reserve("goal-1-plan", "distill"), /Budget intent changed/);
	await assert.rejects(service.reserve("__proto__", "execution"), /identity/);
});

test("probe reservations single-flight through the C3 probe key", async () => {
	const { service } = ledger();
	const probeKey = "account-a\nendpoint-a\nprov";
	const first = await service.reserve("p1", "probe", { probeKey });
	assert.equal(first.admitted, true);
	// A second consumer for the same physical probe joins the in-flight reservation.
	await assert.rejects(
		service.reserve("p2", "probe", { probeKey }),
		(error) => error instanceof ProbeInFlight,
	);
	await service.settle(record("p1", first.reservationId, { purpose: "probe" }));
	// Settling frees the key: the next reservation is a NEW physical probe and may reuse it.
	assert.equal((await service.reserve("p3", "probe", { probeKey })).admitted, true);
	// Only probe reservations may carry a key (frozen C3 rule).
	await assert.rejects(service.reserve("p4", "execution", { probeKey: "k" }), /probe key/);
});

test("unknown usage books a bounded conservative estimate, never zero", async () => {
	const { store, service } = ledger();
	const reservation = await admit(service, "a");
	await service.settle(record("a", reservation)); // Provider reported nothing.
	const totals = await service.totals();
	assert.equal(totals.unknownUsage, 1);
	assert.equal(totals.unknownSettlements, 1);
	assert.deepEqual(totals.usage, measures.unknownEstimate); // Conservative, not zero.
	const state = await store.read();
	assert.equal(state.records[0].settledUnknown, true);
	assert.equal(state.records[0].usage, undefined);
});

test("complete usage settles actual numbers and an explicit cost wins", async () => {
	const { service } = ledger();
	const reservation = await admit(service, "a");
	await service.settle(
		record("a", reservation, { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 2 }, costUsd: 0.02 }),
	);
	const totals = await service.totals();
	assert.equal(totals.unknownUsage, 0);
	assert.equal(totals.usage.inputTokens, 10);
	assert.equal(totals.usage.costUsd, 0.02);
	const computed = await admit(service, "b");
	await service.settle(
		record("b", computed, {
			usage: { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 },
		}),
	);
	assert.ok(Math.abs((await service.totals()).usage.costUsd - (0.02 + 13.05)) < 1e-9);
});

test("complete tokens without billing keep the cost unknown", async () => {
	const { service } = ledger();
	const reservation = await admit(service, "a");
	const unbilled = { ...target, billing: undefined };
	await service.settle(
		record("a", reservation, {
			target: unbilled,
			usage: { inputTokens: 9, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0 },
		}),
	);
	const totals = await service.totals();
	assert.equal(totals.unknownUsage, 1); // Cost unknown: never written down as zero.
	assert.deepEqual(totals.usage, measures.unknownEstimate);
});

test("C3 limits fail closed through the service", async () => {
	const { store, service } = ledger(randomUUID(), {
		maxTotalCostUsd: 100,
		maxAttempts: 1,
		maxInputTokens: 10_000_000,
		maxOutputTokens: 10_000_000,
	});
	assert.equal((await service.reserve("a", "execution")).admitted, true);
	await assert.rejects(service.reserve("b", "execution"), (error) => error instanceof ModelBudgetExhausted);
	const state = await store.read();
	assert.equal(Object.keys(state.admissions).length, 1); // The failed reserve booked nothing.
});

test("settlement is idempotent per receipt and rejects aliasing", async () => {
	const { service } = ledger();
	const reservation = await admit(service, "a");
	assert.equal(await service.settle(record("a", reservation)), true);
	assert.equal(await service.settle(record("a", reservation)), false); // Identical replay confirms.
	await assert.rejects(service.settle(record("a", reservation, { outcome: "failure" })), /changed/);
	await assert.rejects(service.settle(record("a", "r-999")), /admission/); // Foreign reservation id.
	const second = await admit(service, "b");
	await assert.rejects(service.settle(record("b", reservation)), /admission/); // Crossed receipt.
	await service.settle(record("b", second));
	const totals = await service.totals();
	assert.equal(totals.attempts, 2);
	assert.equal(totals.records, 2);
	assert.equal(totals.byPurpose.execution, 2);
});

test("settlement requires admission and rejects invalid measurements", async () => {
	const { service } = ledger();
	await assert.rejects(service.settle(record("missing", "r-1")), /admission/);
	const reservation = await admit(service, "a");
	await assert.rejects(
		service.settle(
			record("a", reservation, { usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
		),
	);
	await assert.rejects(service.settle(record("a", reservation, { purpose: "not-a-purpose" })));
});

test("identity capacity refuses new work without forgetting replay protection", async () => {
	const { store } = ledger();
	const service = new ModelUsageService(store, { ...measures, identityLimit: 2, budgetId: "cap" });
	await service.reserve("a", "execution");
	await service.reserve("b", "execution");
	await assert.rejects(service.reserve("c", "execution"), /capacity/);
	assert.equal((await service.reserve("a", "execution")).admitted, false);
});

test("ledger and C3 budget restore together across a service replacement", async () => {
	const path = randomUUID();
	const first = ledger(path);
	const reservation = await admit(first.service, "a");
	await first.service.settle(
		record("a", reservation, { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
	);
	await first.service.reserve("open", "probe", { probeKey: "d" });
	const before = await first.service.totals();
	const store = new FileStateStore(join(tmpdir(), `pi861-model-service-${path}.json`), emptyUsageLedger());
	const second = new ModelUsageService(store, { ...measures, budgetId: `budget-${path}` });
	const after = await second.totals();
	assert.equal(after.budgetId, before.budgetId);
	assert.equal(after.attempts, before.attempts);
	assert.deepEqual(after.usage, before.usage);
	assert.equal(after.unknownUsage, before.unknownUsage);
	assert.equal(after.unsettled, 1); // The open probe still requires reconciliation.
	assert.equal((await second.reserve("a", "execution")).admitted, false); // Replay protection survives.
	// A ledger restored against a different budget identity is refused.
	const foreign = new ModelUsageService(store, { ...measures, budgetId: "another-budget" });
	await assert.rejects(foreign.reserve("x", "execution"), /different budget/);
});

test("task-attributed attempts roll up in the shared tree budget", async () => {
	const { service } = ledger();
	const budget = service.budget;
	assert.equal(budget.budgetId.startsWith("budget-"), true);
	budget.registerTask("task-1", null, {
		maxTotalCostUsd: 100,
		maxAttempts: 2,
		maxInputTokens: 10_000_000,
		maxOutputTokens: 10_000_000,
	});
	const reservation = await admit(service, "a", "execution", { taskId: "task-1" });
	await service.settle(
		record("a", reservation, { usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
	);
	const summary = budget.taskSummary("task-1");
	assert.equal(summary.attempts, 1);
	assert.equal(summary.usage.inputTokens, 10);
});

const model = {
	id: "primary",
	revision: "1",
	provider: "fixture",
	model: "one",
	quality: 1,
	costRank: 1,
	contextWindow: 100,
	capabilities: [],
	enabled: true,
	billing: { inputPerMt: 3, outputPerMt: 6, cacheReadPerMt: 0.3, cacheWritePerMt: 3.75 },
};
const requestPolicy = {
	targets: [model],
	preferred: model.id,
	requirements: { allowedIds: [model.id], minQuality: 1, contextTokens: 1, capabilities: [] },
	recovery: {
		failoverEnabled: false,
		failbackEnabled: false,
		probeIntervalMs: 1,
		maxProbeIntervalMs: 10,
		requiredProbeSuccesses: 1,
		sameTargetRetries: 1,
	},
	maxAttempts: 2,
	requestTimeoutMs: 100,
	maxRequests: 10,
	maxProbeRequests: 2,
};
const usage = { inputTokens: 20, outputTokens: 5, cacheReadTokens: 8, cacheWriteTokens: 3, costUsd: 0.01 };

function metering(limitOverrides) {
	const store = new FileStateStore(join(tmpdir(), `pi861-model-service-${randomUUID()}.json`), emptyUsageLedger());
	const service = new ModelUsageService(store, {
		...measures,
		rootLimits: limitOverrides ?? rootLimits,
		recordLimit: 4,
		identityLimit: 10,
	});
	return { store, service };
}

test("auxiliary retry settles each physical attempt; the partial one books unknown", async () => {
	const { service: usageService } = metering();
	const requests = new ModelRequestService(usageService);
	let calls = 0;
	assert.equal(
		await requests.request(
			{ requestId: "compile-1", purpose: "skill-compile", policy: requestPolicy, signal: new AbortController().signal },
			async (_model, _signal, _progress, onUsage) => {
				calls++;
				if (calls === 1) {
					onUsage({ inputTokens: 10 });
					throw new ModelFailure("transient");
				}
				onUsage(usage);
				return "compiled";
			},
		),
		"compiled",
	);
	const totals = await usageService.totals();
	assert.equal(totals.attempts, 2); // Every physical attempt, including the failure.
	assert.equal(totals.byPurpose["skill-compile"], 2);
	assert.equal(totals.unknownUsage, 1); // Partial usage on the failed attempt.
	assert.equal(totals.unknownSettlements, 1);
	// The known attempt settled actual numbers and the explicit cost.
	assert.ok(Math.abs(totals.usage.costUsd - (measures.unknownEstimate.costUsd + 0.01)) < 1e-12);
	assert.equal(totals.usage.inputTokens, measures.unknownEstimate.inputTokens + 20);
	// Replaying the logical request id is refused (the attempt identity is already settled);
	// the rejection surfaces through the recovery loop and no transport call happens.
	await assert.rejects(
		requests.request(
			{ requestId: "compile-1", purpose: "skill-compile", policy: requestPolicy, signal: new AbortController().signal },
			async () => {
				calls++;
				return "duplicate";
			},
		),
	);
	assert.equal(calls, 2);
});

test("cancelled noncooperative attempts settle unknown once and ignore late usage", async () => {
	const { service: usageService } = metering();
	const requests = new ModelRequestService(usageService);
	const controller = new AbortController();
	let release, onUsage;
	const running = requests.attempt(
		{ requestId: "cancelled", purpose: "execution", target: model, signal: controller.signal },
		async (callback) => {
			onUsage = callback;
			controller.abort(new Error("cancelled"));
			return new Promise((resolve) => {
				release = resolve;
			});
		},
	);
	await assert.rejects(running, /cancelled/);
	onUsage(usage);
	release("late");
	const totals = await usageService.totals();
	assert.equal(totals.unknownUsage, 1);
	assert.equal(totals.attempts, 1);
});

test("the durable call ledger enumerates every physical request for audit", async () => {
	const { store, service: usageService } = metering();
	const requests = new ModelRequestService(usageService);
	const dispatchLog = [];
	await requests.attempt(
		{ requestId: "audit-1", purpose: "execution", target: model, signal: new AbortController().signal },
		async () => {
			dispatchLog.push({ requestId: "audit-1", outcome: "failure" });
			throw new ModelFailure("transient");
		},
	).catch(() => {});
	await requests.attempt(
		{ requestId: "audit-2", purpose: "reception", target: model, signal: new AbortController().signal },
		async (onUsage) => {
			dispatchLog.push({ requestId: "audit-2", outcome: "success" });
			onUsage({ inputTokens: 4, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 });
			return "ok";
		},
	);
	const state = await store.read();
	// The auditor reconciles the fixture's own dispatch log against the ledger records.
	assert.deepEqual(
		state.records.map((entry) => ({ requestId: entry.requestId, outcome: entry.outcome })),
		dispatchLog,
	);
	const identities = new Set(state.records.map((entry) => entry.requestId));
	assert.equal(identities.size, state.records.length); // One record per physical request.
	assert.ok(state.records.every((entry) => entry.reservationId.startsWith("r-")));
	const totals = await usageService.totals();
	assert.deepEqual(totals.byPurpose, {
		execution: 1,
		reception: 1,
		planning: 0,
		"skill-compile": 0,
		distill: 0,
		probe: 0,
		auxiliary: 0,
	});
});

test("unavailable settlement blocks subsequent transport calls", async () => {
	let calls = 0;
	const broken = {
		reserve: async () => ({ reservationId: "r-1", admitted: true }),
		settle: async () => {
			throw new Error("store unavailable");
		},
	};
	const requests = new ModelRequestService(broken);
	await assert.rejects(
		requests.attempt(
			{ requestId: "one", purpose: "execution", target: model, signal: new AbortController().signal },
			async () => {
				calls++;
				return "done";
			},
		),
		/settlement unavailable/,
	);
	await assert.rejects(
		requests.attempt(
			{ requestId: "two", purpose: "execution", target: model, signal: new AbortController().signal },
			async () => {
				calls++;
				return "done";
			},
		),
		/settlement unavailable/,
	);
	assert.equal(calls, 1);
});

test("cost is computed only from explicit billing", () => {
	const cost = estimateCostUsd(billing, {
		inputTokens: 1e6,
		outputTokens: 1e6,
		cacheReadTokens: 1e6,
		cacheWriteTokens: 1e6,
	});
	assert.ok(Math.abs(cost - 13.05) < 1e-9);
});

test("an injected TaskTreeBudget is the shared authority", async () => {
	const shared = new TaskTreeBudget(rootLimits, { budgetId: "shared-root" });
	const store = new FileStateStore(join(tmpdir(), `pi861-model-service-${randomUUID()}.json`), emptyUsageLedger());
	const one = new ModelUsageService(store, { ...measures, budget: shared });
	const other = new ModelUsageService(store, { ...measures, budget: shared });
	const first = await one.reserve("a", "execution");
	assert.equal(first.admitted, true);
	// The second service sees the same open admission: the tree budget never forks.
	assert.equal((await other.reserve("a", "execution")).admitted, false);
	await one.settle(
		record("a", first.reservationId, { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
	);
	assert.equal((await other.totals()).attempts, 1);
});

test("the P1-S auxiliary port records the ledger without double-booking C3", async () => {
	const shared = new TaskTreeBudget(rootLimits, { budgetId: "aux-shared" });
	const store = new FileStateStore(join(tmpdir(), `pi861-model-service-${randomUUID()}.json`), emptyUsageLedger());
	const usageService = new ModelUsageService(store, { ...measures, budget: shared });
	const requests = new ModelRequestService(usageService);
	let transports = 0;
	const port = auxiliaryPort(
		requests.auxiliaryBoundary(),
		async (request, onUsage) => {
			transports++;
			onUsage({ inputTokens: 7, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 });
			return `done:${request.prompt}`;
		},
		() => requests.newRequestId(),
	);
	// The P1-S invocation side books its own C3 reservation for the same physical call.
	const reservation = shared.reserve(null, "reception", measures.estimate, Date.now());
	const settled = [];
	assert.equal(
		await port.attempt(
			{
				requestId: "classify-1",
				purpose: "classify",
				target: model,
				signal: new AbortController().signal,
				prompt: "route this",
			},
			(usage) => settled.push(usage),
		),
		"done:route this",
	);
	assert.equal(transports, 1);
	assert.deepEqual(settled, [{ inputTokens: 7, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 }]);
	shared.settle(reservation.reservationId, { inputTokens: 7, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 });
	const totals = await usageService.totals();
	// Exactly one C3 attempt exists for the single physical request: S's reservation.
	assert.equal(totals.attempts, 1);
	assert.equal(totals.byPurpose.reception, 1); // S's "classify" maps to the C3 reception kind.
	const state = await store.read();
	assert.equal(state.records.length, 1);
	assert.equal(state.records[0].settledUnknown, false);
});
