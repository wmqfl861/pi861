import assert from "node:assert/strict";
import { test } from "node:test";
import { TaskTreeBudget } from "../src/contracts/budget.ts";
import { IdentityAuthority } from "../src/contracts/identity.ts";
import {
	AuxiliaryModelInvocations,
	DEFAULT_AUXILIARY_ESTIMATES,
	resolveAuxiliaryTargets,
} from "../src/live/auxiliary-models.ts";

const target = (id) => ({
	id,
	revision: "r1",
	provider: "fixture",
	model: id,
	quality: 5,
	costRank: 1,
	contextWindow: 200_000,
	capabilities: ["text"],
	enabled: true,
});
const targets = { classifier: target("intake"), compiler: target("compiler"), enrich: target("memory"), planner: target("planner") };

const role = { id: "dev", revision: "r1", readScopes: ["project:pi861"], writeScopes: [], outbound: [], toolGrants: [] };
const authority = () => new IdentityAuthority({ authorityId: "p1s-authority", tenantId: "local", trustedLocal: true, roles: [role] });

const limits = { maxTotalCostUsd: 1000, maxAttempts: 100, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000 };
const budget = (overrides = {}) => new TaskTreeBudget({ ...limits, ...overrides }, { budgetId: "budget-p1s-test" });

const fullUsage = (usage = {}) => ({ inputTokens: 120, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.002, ...usage });

const responses = {
	intake: JSON.stringify({ mode: "fixed", targetId: "primary", minQuality: 2, reason: "stable ability needs" }),
	compiler: JSON.stringify({
		id: "debug", title: "Debug", category: "engineering", instructions: "Preserve evidence.",
		branches: [{ id: "general", when: "A reproducible defect", instructions: "Reproduce and verify.", environment: [], conflictsWith: [], tools: [] }],
	}),
	grouping: JSON.stringify({ group: "debug", relatedGroups: [], reason: "matches existing debugging capability" }),
	memory: JSON.stringify({ abstract: "a", overview: "o", facts: [] }),
	planner: JSON.stringify({
		tasks: [{ task: { id: "one", title: "Implement", dependsOn: [], writeScopes: ["src"], capabilities: [], acceptance: ["types pass"] }, execution: { instructions: "Implement it", modelId: "primary", roleId: "dev", checkIds: ["types"] } }],
	}),
};

/** Fake M1-shaped port: records every admitted attempt and replays deterministic responses. */
function fakePort(behavior = {}) {
	const requests = [];
	let sequence = 0;
	return {
		requests,
		port: {
			async attempt(request, onUsage) {
				requests.push(request);
				if (behavior.failWith) {
					if (behavior.reportBeforeFailure) onUsage(fullUsage(behavior.usage));
					throw behavior.failWith;
				}
				if (!behavior.silentUsage) onUsage(fullUsage(behavior.usage));
				const text = behavior.replays ? behavior.replays.shift() : responses[request.target.id];
				if (text === undefined) throw new Error(`No fixture response for target ${request.target.id}`);
				return text;
			},
			newRequestId() {
				return `req-${++sequence}`;
			},
		},
	};
}

const context = (credential, overrides = {}) => ({ credential, scope: "project:pi861", taskId: null, ...overrides });

test("classifier, compile, enrich and planner share one context, one budget and one signal", async () => {
	const verifier = authority();
	const credential = verifier.issue("agent-1", { roleIds: ["dev"] });
	const sharedBudget = budget();
	const { port, requests } = fakePort({
		replays: [responses.intake, responses.compiler, responses.grouping, responses.memory, responses.planner],
	});
	const service = new AuxiliaryModelInvocations({ authority: verifier, budget: sharedBudget, port, targets });
	const signal = new AbortController().signal;
	const ctx = context(credential);

	const decision = await service.classify(ctx, "task text", [], signal);
	const skill = await service.compileSkill(ctx, { group: "debug", sources: [], documents: [], approvedBindings: [] }, signal);
	const grouping = await service.groupSkill(ctx, { id: "s1", revision: "r1", group: "", files: [], hash: "h" }, [], signal);
	const enriched = await service.enrich(ctx, { id: "r1", revision: 1, text: "record", source: { kind: "user", ref: "urn:test:1" } }, signal);
	const plan = await service.plan(ctx, "goal", "facts", { models: ["primary"], roles: ["dev"], checkIds: ["types"] }, signal);

	assert.equal(decision.mode, "fixed");
	assert.equal(skill.revision, "candidate");
	assert.equal(grouping.group, "debug");
	assert.equal(typeof enriched.overview, "string");
	assert.equal(plan.length, 1);
	// Every physical attempt carried the same caller signal and a fresh request identity.
	assert.equal(requests.length, 5);
	assert.ok(requests.every((request) => request.signal === signal));
	assert.equal(new Set(requests.map((request) => request.requestId)).size, 5);
	assert.deepEqual(requests.map((request) => request.target.id), ["intake", "compiler", "compiler", "memory", "planner"]);
	assert.deepEqual(requests.map((request) => request.purpose), ["classify", "auxiliary", "auxiliary", "auxiliary", "auxiliary"]);
	// All five settled against the same root budget with measured usage and nothing left open.
	const usage = sharedBudget.usage;
	assert.equal(usage.attempts, 5);
	assert.equal(usage.unknownSettlements, 0);
	assert.equal(sharedBudget.openReservations().length, 0);
	assert.equal(usage.usage.costUsd, 5 * fullUsage().costUsd);
});

test("compilation without operator-approved bindings is rejected before any model call or reservation", async () => {
	const verifier = authority();
	const credential = verifier.issue("agent-1", { roleIds: ["dev"] });
	const sharedBudget = budget();
	const { port, requests } = fakePort();
	const service = new AuxiliaryModelInvocations({ authority: verifier, budget: sharedBudget, port, targets });
	await assert.rejects(
		service.compileSkill(context(credential), { group: "debug", sources: [], documents: [] }, new AbortController().signal),
		/approved/,
	);
	assert.equal(requests.length, 0);
	assert.equal(sharedBudget.usage.attempts, 0);
});

test("forged, revoked and unauthorized identities never reach the model port", async () => {
	const verifier = authority();
	const credential = verifier.issue("agent-1", { roleIds: ["dev"] });
	const sharedBudget = budget();
	const { port, requests } = fakePort();
	const service = new AuxiliaryModelInvocations({ authority: verifier, budget: sharedBudget, port, targets });
	const signal = new AbortController().signal;

	const tampered = context({ ...credential, readScopes: [...credential.readScopes, "project:other"] });
	await assert.rejects(service.classify(tampered, "task", [], signal), /Untrusted identity|does not match/);
	await assert.rejects(service.enrich(tampered, { id: "r", revision: 1, text: "t", source: { kind: "user", ref: "x" } }, signal), /Untrusted identity|does not match/);
	assert.equal(requests.length, 0);

	await assert.rejects(service.classify(context(credential, { scope: "project:other" }), "task", [], signal), /Read not authorized/);
	assert.equal(requests.length, 0);

	verifier.revoke("agent-1");
	await assert.rejects(service.classify(context(credential), "task", [], signal), /revoked/);
	assert.equal(requests.length, 0);
	assert.equal(sharedBudget.usage.attempts, 0);
});

test("invocations without a budget are rejected at construction and exhaustion rejects the request", async () => {
	const verifier = authority();
	const credential = verifier.issue("agent-1", { roleIds: ["dev"] });
	const { port } = fakePort();
	assert.throws(() => new AuxiliaryModelInvocations({ authority: verifier, port, targets }), /budget/);

	const tight = budget({ maxAttempts: 1 });
	const { port: limitedPort, requests } = fakePort();
	const service = new AuxiliaryModelInvocations({ authority: verifier, budget: tight, port: limitedPort, targets });
	const signal = new AbortController().signal;
	await service.classify(context(credential), "task", [], signal);
	await assert.rejects(service.plan(context(credential), "goal", "facts", { models: ["primary"], roles: ["dev"], checkIds: ["types"] }, signal), /Budget exhausted/);
	assert.equal(requests.length, 1);
	assert.equal(tight.usage.attempts, 1);
});

test("unknown usage books conservatively and is never settled as zero; measured failures still settle", async () => {
	const verifier = authority();
	const credential = verifier.issue("agent-1", { roleIds: ["dev"] });

	const silent = budget();
	const silentPort = fakePort({ silentUsage: true });
	const silentService = new AuxiliaryModelInvocations({ authority: verifier, budget: silent, port: silentPort.port, targets });
	const signal = new AbortController().signal;
	await silentService.classify(context(credential), "task", [], signal);
	const unknownUsage = silent.usage;
	assert.equal(unknownUsage.attempts, 1);
	assert.equal(unknownUsage.unknownSettlements, 1);
	assert.deepEqual(unknownUsage.usage, DEFAULT_AUXILIARY_ESTIMATES.reception.unknown);

	const failing = budget();
	const failingPort = fakePort({ failWith: new Error("transport failed"), reportBeforeFailure: true, usage: fullUsage({ costUsd: 0.05 }) });
	const failingService = new AuxiliaryModelInvocations({ authority: verifier, budget: failing, port: failingPort.port, targets });
	await assert.rejects(failingService.classify(context(credential), "task", [], signal), /transport failed/);
	const failedUsage = failing.usage;
	assert.equal(failedUsage.attempts, 1);
	assert.equal(failedUsage.unknownSettlements, 0);
	assert.equal(failedUsage.usage.costUsd, 0.05);
	assert.equal(failing.openReservations().length, 0);
});

test("a pre-aborted signal consumes no budget and an unregistered task attribution is rejected", async () => {
	const verifier = authority();
	const credential = verifier.issue("agent-1", { roleIds: ["dev"] });
	const sharedBudget = budget();
	const { port, requests } = fakePort();
	const service = new AuxiliaryModelInvocations({ authority: verifier, budget: sharedBudget, port, targets });

	const aborted = new AbortController();
	aborted.abort(new Error("cancelled before dispatch"));
	await assert.rejects(service.classify(context(credential), "task", [], aborted.signal), /cancelled before dispatch/);
	assert.equal(requests.length, 0);
	assert.equal(sharedBudget.usage.attempts, 0);

	await assert.rejects(
		service.classify(context(credential, { taskId: "never-registered" }), "task", [], new AbortController().signal),
		/Unknown task/,
	);
	assert.equal(requests.length, 0);
	assert.equal(sharedBudget.openReservations().length, 0);
});

test("auxiliary targets resolve only from configured, enabled model targets", () => {
	const base = {
		version: 2,
		projectId: "project",
		stateDirectory: "C:\\tmp\\pi861-state",
		role: { id: "dev", skillIds: [], grants: [] },
	};
	const models = (plannerEnabled) => ({
		targets: [target("intake"), target("compiler"), target("memory"), { ...target("planner"), enabled: plannerEnabled }],
		preferred: "intake",
		intakeId: "intake",
		requirements: { minQuality: 0, contextTokens: 1000, capabilities: [], allowedIds: ["intake", "compiler", "memory", "planner"] },
		recovery: { failoverEnabled: true, failbackEnabled: false, probeIntervalMs: 1000, maxProbeIntervalMs: 5000, requiredProbeSuccesses: 1 },
		maxAttempts: 2,
		requestTimeoutMs: 5000,
		maxRequests: 100,
		maxProbeRequests: 5,
	});
	const projectSection = { repository: "C:\\repo", worktreeRoot: "C:\\wt", cli: "C:\\cli", maxConcurrent: 1, checks: [], plannerModelId: "planner" };
	const resolved = resolveAuxiliaryTargets({ ...base, models: models(true), skills: { compilerModelId: "compiler" }, memory: { modelId: "memory" }, project: projectSection });
	assert.deepEqual(Object.keys(resolved).sort(), ["classifier", "compiler", "enrich", "planner"]);
	// Disabled planner target is rejected even though the config names it.
	assert.throws(
		() => resolveAuxiliaryTargets({ ...base, models: models(false), skills: { compilerModelId: "compiler" }, memory: { modelId: "memory" }, project: projectSection }),
		/unavailable.*planner/,
	);
	// Missing optional section is reported instead of silently reusing another target.
	assert.throws(
		() => resolveAuxiliaryTargets({ ...base, models: models(true), skills: { compilerModelId: "compiler" }, memory: { modelId: "memory" } }),
		/not configured.*project.plannerModelId/,
	);
	assert.throws(() => resolveAuxiliaryTargets({ ...base }), /require configured model targets/);
});
