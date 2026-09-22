import assert from "node:assert/strict";
import { test } from "node:test";
import { FileStateStore } from "../src/live/store.ts";
import { estimateCostUsd, ModelBudgetExhausted, ModelUsageService } from "../src/live/model-service.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function ledger(path = randomUUID(), limit = 3) {
	const store = new FileStateStore(join(tmpdir(), `pi861-model-service-${path}.json`), { limit, used: 0, intents: {}, settled: {}, records: [], unknownUsage: 0 });
	return { store, service: new ModelUsageService(store, { recordLimit: 4, identityLimit: 4 }) };
}
const target = { id: "strong", provider: "p", model: "m" };
const record = (patch = {}) => ({
	requestId: randomUUID(), intent: "main#1", purpose: "main", target,
	startedAt: 1, finishedAt: 2, outcome: "success", ...patch,
});

test("reserves are atomic and idempotent per logical intent", async () => {
	const { service } = ledger();
	await service.reserve("goal-1-plan");
	await service.reserve("goal-1-plan"); // Replay never double counts.
	const totals = await service.totals();
	assert.equal(totals.used, 1);
	await assert.rejects(service.reserve("goal-1-plan", 2), /Budget intent changed/);
});

test("exhausted budget fails explicitly and marks unknown usage separately from zero", async () => {
	const { service } = ledger();
	await service.reserve("a"); await service.reserve("b"); await service.reserve("c");
	await assert.rejects(service.reserve("d"), (error) => error instanceof ModelBudgetExhausted);
	await service.settle(record({ intent: "a", requestId: "r1", usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 2 } }));
	await service.settle(record({ intent: "b", requestId: "r2" })); // Provider reported nothing.
	const totals = await service.totals();
	assert.equal(totals.used, 3);
	assert.equal(totals.unknownUsage, 1); // Explicitly unknown, never zeroed.
	assert.equal(totals.byPurpose.main, 2);
});

test("probes, classifiers and auxiliary calls share one ledger", async () => {
	const { service } = ledger();
	await service.reserve("probe#1"); await service.settle(record({ intent: "probe#1", requestId: "p1", purpose: "probe" }));
	await service.reserve("classify#1"); await service.settle(record({ intent: "classify#1", requestId: "c1", purpose: "classify" }));
	await service.reserve("memory-enrich#1"); await service.settle(record({ intent: "memory-enrich#1", requestId: "x1", purpose: "auxiliary" }));
	const totals = await service.totals();
	assert.deepEqual(totals.byPurpose, { main: 0, probe: 1, classify: 1, auxiliary: 1 });
	assert.equal(totals.used, 3);
});

test("settlement is idempotent per request receipt", async () => {
	const { service } = ledger();
	await service.reserve("a");
	const first = await service.settle(record({ intent: "a", requestId: "receipt-1" }));
	const replay = await service.settle(record({ intent: "a", requestId: "receipt-1" }));
	assert.equal(first, true);
	assert.equal(replay, false);
	const totals = await service.totals();
	assert.equal(totals.records, 1);
});

test("failed attempts are metered and identity tracking stays bounded", async () => {
	const { service, store } = ledger(randomUUID(), 10);
	for (let index = 0; index < 6; index++) {
		await service.reserve(`attempt-${index}`);
		await service.settle(record({ intent: `attempt-${index}`, requestId: `r-${index}`, outcome: "failure" }));
	}
	const totals = await service.totals();
	assert.equal(totals.records, 4); // Record ring keeps the newest attempts.
	assert.equal(totals.unknownUsage, 6); // The counter totals all unknown settlements, not just the ring.
	assert.equal(totals.used, 6);
	assert.ok(Object.keys((await store.read()).settled).length <= 4); // Receipt identities pruned, not unbounded.
});

test("cost is computed only from explicit billing", () => {
	const billing = { inputPerMt: 3, outputPerMt: 6, cacheReadPerMt: 0.3, cacheWritePerMt: 3.75 };
	const cost = estimateCostUsd(billing, { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 });
	assert.ok(Math.abs(cost - 13.05) < 1e-9);
});

test("invalid settlements are rejected", async () => {
	const { service } = ledger();
	await service.reserve("a");
	await assert.rejects(service.settle(record({ intent: "a", requestId: "x", usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })));
	await assert.rejects(service.settle(record({ intent: "a", requestId: "x", purpose: "unknown-purpose" })));
});
