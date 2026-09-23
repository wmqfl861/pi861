import assert from "node:assert/strict";
import { test } from "node:test";
import { routeClassifier, skillCompiler, projectPlan } from "../src/live/compilers.ts";

const signal = new AbortController().signal;
const generate = (value) => async () => JSON.stringify(value);

test("route compiler constructs a validated decision instead of trusting model-shaped values", async () => {
	const decision = { mode: "fixed", targetId: "primary", minQuality: 2, reason: "requires verification" };
	assert.deepEqual(await routeClassifier(generate(decision)).classify("task", [], signal), decision);
	await assert.rejects(routeClassifier(generate({ ...decision, reason: " " })).classify("task", [], signal), /Invalid route/);
	await assert.rejects(routeClassifier(generate({ ...decision, mode: ["fixed"] })).classify("task", [], signal), /Invalid route/);
});

test("Skill compiler rejects malformed nested constraints and tool bindings", async () => {
	const candidate = {
		id: "debug", title: "Debug", category: "engineering", instructions: "Preserve evidence.",
		branches: [{ id: "general", when: "A reproducible defect", instructions: "Reproduce and verify.", environment: [], conflictsWith: [], tools: [] }],
	};
	const input = { group: "debug", sources: [], documents: [], approvedBindings: [] };
	assert.equal((await skillCompiler(generate(candidate)).compile(input, signal)).revision, "candidate");
	const bad = structuredClone(candidate);
	bad.branches[0].environment = "all";
	await assert.rejects(skillCompiler(generate(bad)).compile(input, signal), /environment/);
	const binding = structuredClone(candidate);
	binding.branches[0].tools = [{ toolId: "service/write", accountId: "account" }];
	await assert.rejects(skillCompiler(generate(binding)).compile(input, signal), /resourceId/);
});

test("Skill compilation requires operator-approved bindings and rejects forged tool declarations", async () => {
	const candidate = {
		id: "debug", title: "Debug", category: "engineering", instructions: "Preserve evidence.",
		branches: [{ id: "general", when: "A reproducible defect", instructions: "Reproduce and verify.", environment: [], conflictsWith: [], tools: [] }],
	};
	// Negative: approvedBindings not supplied at all is rejected before any model call.
	let calls = 0;
	const counting = (value) => async () => { calls++; return JSON.stringify(value); };
	const missing = { group: "debug", sources: [], documents: [] };
	await assert.rejects(skillCompiler(counting(candidate)).compile(missing, signal), /approved/);
	assert.equal(calls, 0);
	// Negative: a model-declared tool the operator never approved is rejected.
	const approved = [{ toolId: "service/read", accountId: "account", resourceId: "db", schemaHash: "ab12", phase: "run" }];
	const forged = structuredClone(candidate);
	forged.branches[0].tools = [{ toolId: "service/write", accountId: "account", resourceId: "db", schemaHash: "ab12", phase: "run" }];
	const withApproval = { group: "debug", sources: [], documents: [], approvedBindings: approved };
	await assert.rejects(skillCompiler(counting(forged)).compile(withApproval, signal), /did not approve/);
	// Positive: the exact operator-approved binding survives compilation.
	const exact = structuredClone(candidate);
	exact.branches[0].tools = [{ toolId: "service/read", accountId: "account", resourceId: "db", schemaHash: "ab12", phase: "run" }];
	assert.equal((await skillCompiler(counting(exact)).compile(withApproval, signal)).branches[0].tools.length, 1);
});

test("planner accepts only validated execution contracts and never lets model output authorize retries", async () => {
	const entry = {
		task: { id: "one", title: "Implement", dependsOn: [], writeScopes: ["src"], capabilities: [], acceptance: ["typecheck passes"], retrySafe: true },
		execution: { modelId: "primary", roleId: "dev", instructions: "Implement the requested behavior", checkIds: ["types"] },
	};
	const plan = await projectPlan("goal", "facts", ["primary"], ["dev"], ["types"], generate({ tasks: [entry] }), signal);
	assert.equal(plan[0].task.retrySafe, false);
	const malformed = structuredClone(entry);
	malformed.task.dependsOn = "one";
	await assert.rejects(projectPlan("goal", "facts", ["primary"], ["dev"], ["types"], generate({ tasks: [malformed] }), signal), /dependencies/);
	const unauthorized = structuredClone(entry);
	unauthorized.execution.modelId = "outside-allowlist";
	await assert.rejects(projectPlan("goal", "facts", ["primary"], ["dev"], ["types"], generate({ tasks: [unauthorized] }), signal), /unapproved/);
});
