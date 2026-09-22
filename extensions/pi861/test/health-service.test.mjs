import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStateStore } from "../src/live/store.ts";
import { SharedHealthService } from "../src/live/health-service.ts";
import { faultDomainKey } from "../src/routing.ts";

const options = { probeLimit: 3, requiredSuccesses: 2, backoffMs: 10, maxBackoffMs: 100, minProbeIntervalMs: 5, leaseTimeoutMs: 1000 };
function pair(overrides = {}) {
	const store = new FileStateStore(join(tmpdir(), `pi861-health-${randomUUID()}.json`), { domains: {}, probesUsed: 0 });
	return [new SharedHealthService(store, { ...options, ...overrides }), new SharedHealthService(store, { ...options, ...overrides })];
}
const domain = faultDomainKey({ id: "m1", revision: "1", provider: "p", model: "a", quality: 1, costRank: 1, contextWindow: 10, capabilities: [], enabled: true, faultDomain: { accountId: "acct", endpoint: "https://edge" } });
const sibling = faultDomainKey({ id: "m2", revision: "1", provider: "p", model: "b", quality: 1, costRank: 1, contextWindow: 10, capabilities: [], enabled: true, faultDomain: { accountId: "acct", endpoint: "https://edge" } });

test("one probe flies at a time across instances", async () => {
	const [a, b] = pair();
	const claims = await Promise.all([a.acquireProbe(domain, 100), b.acquireProbe(domain, 100)]);
	assert.equal(claims.filter(Boolean).length, 1);
	const winner = claims.find(Boolean);
	assert.equal(await b.finishProbe(domain, winner.probeId, true, 110), true);
	assert.equal(await a.finishProbe(domain, winner.probeId, true, 111), false); // Released lease rejects replays.
});
test("a shared probe budget stops probing for every instance", async () => {
	const [a, b] = pair();
	const first = await a.acquireProbe(domain, 100);
	assert.ok(first);
	await a.finishProbe(domain, first.probeId, false, 105);
	const second = await b.acquireProbe(domain, 200);
	assert.ok(second);
	await b.finishProbe(domain, second.probeId, false, 205);
	const third = await a.acquireProbe(domain, 300);
	assert.ok(third);
	await a.finishProbe(domain, third.probeId, false, 305);
	assert.equal(await a.acquireProbe(domain, 400), undefined);
	assert.equal(await b.acquireProbe(domain, 400), undefined);
	assert.equal((await a.totals()).probesUsed, 3);
});
test("disabled failback refuses probes that only serve switching back", async () => {
	const [a] = pair();
	await a.recordFailure(domain, 100);
	a.setFailbackProbes(false);
	assert.equal(await a.acquireProbe(domain, 200, "failback"), undefined);
	assert.ok(await a.acquireProbe(domain, 200, "health"));
});
test("backpressure spaces probes against a recovering domain", async () => {
	const [a] = pair({ minProbeIntervalMs: 50 });
	await a.recordFailure(domain, 100, 30); // nextProbeAt = 130
	assert.equal(await a.acquireProbe(domain, 129), undefined);
	const probe = await a.acquireProbe(domain, 130);
	assert.ok(probe);
	await a.finishProbe(domain, probe.probeId, true, 131);
	assert.equal(await a.acquireProbe(domain, 135), undefined); // success still spaces the next probe
	assert.ok(await a.acquireProbe(domain, 181));
});
test("stability requires consecutive probe successes", async () => {
	const [a] = pair();
	await a.recordFailure(domain, 100);
	assert.equal(await a.isAvailable(domain), false);
	const first = await a.acquireProbe(domain, 130);
	await a.finishProbe(domain, first.probeId, true, 131);
	assert.equal(await a.isAvailable(domain), false);
	const second = await a.acquireProbe(domain, 200);
	await a.finishProbe(domain, second.probeId, true, 201);
	assert.equal(await a.isAvailable(domain), true);
	const third = await a.acquireProbe(domain, 300);
	await a.finishProbe(domain, third.probeId, false, 301);
	assert.equal(await a.isAvailable(domain), false); // A miss resets the run and re-arms backoff.
});
test("an expired lease is claimable again (crash recovery)", async () => {
	const [a, b] = pair({ leaseTimeoutMs: 10 });
	const dead = await a.acquireProbe(domain, 100);
	assert.ok(dead);
	// Simulate a crash: instance a never finishes its probe; the lease expires at 110.
	const reclaimed = await b.acquireProbe(domain, 200);
	assert.ok(reclaimed);
	assert.notEqual(reclaimed.probeId, dead.probeId);
	assert.equal(await a.finishProbe(domain, dead.probeId, true, 210), false); // The old lease is gone.
});
test("one model's failure shares the circuit with its fault-domain sibling", async () => {
	const [a] = pair();
	assert.equal(await a.isAvailable(sibling), true);
	await a.recordFailure(domain, 100);
	assert.equal(await a.isAvailable(sibling), false); // Same account/endpoint/provider domain.
	await a.recordSuccess(domain);
	assert.equal(await a.isAvailable(sibling), false); // Decay is not a reset.
});
