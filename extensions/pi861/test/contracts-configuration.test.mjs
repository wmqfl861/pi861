import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationRegistry, deriveSubagentConfiguration } from "../src/contracts/configuration.ts";

const global = {
	revision: "g1",
	behavior: {
		executionModePreference: "auto", failoverEnabled: true, failbackEnabled: true,
		memory: { autoRecall: true, autoCapture: true, autoDistill: true, activeTools: true, defaultReadDepth: 1 },
		planning: { lowWatermarkTasks: 4, maxPlanTasks: 50 },
		search: { enabled: true },
	},
	ceilings: {
		maxConcurrentAttempts: 8, maxRequestAttempts: 4,
		readScopes: ["project:p1", "task:p1/a", "task:p1/b"], writeScopes: ["project:p1"],
		outbound: {
			rules: [
				{ hostPattern: "api.example.com", protocols: ["https", "http"], allowPrivateNetworks: false },
				{ hostPattern: "cdn.example.net", protocols: ["https"], allowPrivateNetworks: false },
			],
			allowPrivateNetworks: false,
		},
		toolGrants: [{ serviceId: "svc", toolName: "deploy", accountId: "acc", resourceIds: ["r1", "r2"] }],
	},
};

const registry = () => new ConfigurationRegistry(structuredClone(global));

test("behavior preferences are overridden by more specific layers", () => {
	const config = registry();
	config.put({ layer: "agent", ownerId: "a1", revision: "v1", behavior: { failbackEnabled: false, memory: { defaultReadDepth: 2 } } });
	const resolved = config.resolve({ agentId: "a1" });
	assert.equal(resolved.behavior.failbackEnabled, false);
	assert.equal(resolved.behavior.memory.defaultReadDepth, 2);
	assert.equal(resolved.behavior.failoverEnabled, true);
	assert.deepEqual(resolved.resolutionPath, ["global", "agent:a1"]);
});

test("permission ceilings only narrow through layers and never widen", () => {
	const config = registry();
	config.put({
		layer: "role", ownerId: "dev", revision: "v1",
		ceilings: {
			readScopes: ["project:p1", "shared:never-granted"],
			writeScopes: ["project:p1"],
			maxConcurrentAttempts: 3,
			outbound: [{ hostPattern: "api.example.com", protocols: ["https"], allowPrivateNetworks: false }],
			toolGrants: [{ serviceId: "svc", toolName: "deploy", accountId: "acc", resourceIds: ["r1"] }],
		},
	});
	const resolved = config.resolve({ roleId: "dev" });
	assert.deepEqual(resolved.ceilings.readScopes, ["project:p1"]);
	assert.equal(resolved.ceilings.maxConcurrentAttempts, 3);
	assert.deepEqual(resolved.ceilings.toolGrants[0].resourceIds, ["r1"]);
	assert.equal(resolved.ceilings.outbound.rules.length, 1);
	const plain = config.resolve({});
	assert.equal(plain.ceilings.maxConcurrentAttempts, 8);
});

test("numeric ceilings take the minimum and never increase", () => {
	const config = registry();
	config.put({ layer: "project", ownerId: "p1", revision: "v1", ceilings: { maxRequestAttempts: 99 } });
	const resolved = config.resolve({ projectId: "p1" });
	assert.equal(resolved.ceilings.maxRequestAttempts, 4);
	config.put({ layer: "agent", ownerId: "a1", revision: "v1", ceilings: { maxRequestAttempts: 2 } });
	assert.equal(config.resolve({ projectId: "p1", agentId: "a1" }).ceilings.maxRequestAttempts, 2);
});

test("configuration revisions are immutable and runtime changes advance the epoch", () => {
	const config = registry();
	config.put({ layer: "project", ownerId: "p1", revision: "v1", behavior: { search: { enabled: false } } });
	const epochBefore = config.configurationEpoch;
	assert.throws(() => config.put({ layer: "project", ownerId: "p1", revision: "v1", behavior: { search: { enabled: true } } }), /immutable/);
	config.put({ layer: "project", ownerId: "p1", revision: "v1", behavior: { search: { enabled: false } } });
	assert.equal(config.configurationEpoch, epochBefore);
	config.put({ layer: "project", ownerId: "p1", revision: "v2", behavior: { search: { enabled: true } } });
	assert.ok(config.configurationEpoch > epochBefore);
	assert.equal(config.resolve({ projectId: "p1" }).behavior.search.enabled, true);
});

test("pins capture a resolved configuration for in-flight execution", () => {
	const config = registry();
	const first = config.resolve({});
	const pin = config.pin(first, 1_000);
	config.put({ layer: "agent", ownerId: "a1", revision: "v1", behavior: { failoverEnabled: false } });
	const second = config.pin(config.resolve({ agentId: "a1" }), 2_000);
	assert.notEqual(pin.pinnedDigest, second.pinnedDigest);
	assert.equal(pin.epoch, 0);
});

test("snapshots restore with integrity re-derivation and tampering is rejected", () => {
	const config = registry();
	config.put({ layer: "agent", ownerId: "a1", revision: "v1", behavior: { search: { enabled: false } } });
	const snapshot = config.snapshot();
	const restored = registry();
	restored.restore(snapshot);
	assert.equal(restored.resolve({ agentId: "a1" }).behavior.search.enabled, false);
	const forged = structuredClone(snapshot);
	forged.documents[0].behavior.search.enabled = true;
	assert.throws(() => registry().restore(forged), /integrity/);
});

test("subagent derivation inherits behavior and only narrows ceilings", () => {
	const config = registry();
	const parent = config.resolve({});
	const child = deriveSubagentConfiguration(parent, { readScopes: ["task:p1/a"], maxConcurrentAttempts: 2 });
	assert.deepEqual(child.behavior, parent.behavior);
	assert.deepEqual(child.ceilings.readScopes, ["task:p1/a"]);
	assert.equal(child.ceilings.maxConcurrentAttempts, 2);
	assert.ok(child.resolutionPath.length > parent.resolutionPath.length);
});

test("invalid documents are rejected at write time", () => {
	const config = registry();
	assert.throws(() => config.put({ layer: "global", ownerId: "", revision: "x", behavior: {} }), /override layers/);
	assert.throws(() => config.put({ layer: "agent", ownerId: "a1", revision: "v1", ceilings: { readScopes: ["bogus scope"] } }), /canonical/);
	assert.throws(() => config.put({ layer: "agent", ownerId: "a1", revision: "v1", ceilings: { maxConcurrentAttempts: 0 } }), /ceiling/);
	assert.throws(() => config.put({ layer: "agent", ownerId: "a1", revision: "v1", behavior: { memory: { defaultReadDepth: 5 } } }), /read depth/);
});
