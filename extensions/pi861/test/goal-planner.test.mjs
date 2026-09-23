import assert from "node:assert/strict";
import { test } from "node:test";
import { AuxiliaryModelInvocations } from "../src/live/auxiliary-models.ts";
import { createGoalPlanner } from "../src/live/goal-planner.ts";
import { emptyProject } from "../src/live/coordinator.ts";
import { TaskTreeBudget, BudgetExhausted } from "../src/contracts/budget.ts";
import { IdentityAuthority } from "../src/contracts/identity.ts";

const target = (id) => ({
	id,
	revision: "1",
	provider: "fixture",
	model: id,
	quality: 1,
	costRank: 1,
	contextWindow: 100000,
	capabilities: [],
	enabled: true,
});
const targets = { classifier: target("t-classify"), compiler: target("t-compile"), enrich: target("t-enrich"), planner: target("t-plan") };
const vocabulary = { models: ["t-plan"], roles: ["dev"], checkIds: ["verify"] };
const entry = (id, dependsOn = []) => ({
	task: { id, title: id, dependsOn, writeScopes: [`${id.toLowerCase()}.txt`], capabilities: [], acceptance: ["check passes"] },
	execution: { instructions: `implement ${id}`, roleId: "dev", modelId: "t-plan", checkIds: ["verify"] },
});
function authority() {
	const authority = new IdentityAuthority({
		authorityId: "auth",
		tenantId: "local",
		trustedLocal: true,
		roles: [{ id: "dev", revision: "1", readScopes: ["project:pi861"], writeScopes: [], outbound: [], toolGrants: [] }],
	});
	return { authority, credential: authority.issue("planner-1", { roleIds: ["dev"] }) };
}
function invocations(port, budget, estimates) {
	const { authority: idAuthority, credential } = authority();
	const service = new AuxiliaryModelInvocations({
		authority: idAuthority,
		budget,
		port,
		targets,
		...(estimates ? { estimates: { planning: estimates } } : {}),
	});
	return { service, context: { credential, scope: "project:pi861", taskId: null } };
}
const planJson = (tasks) => JSON.stringify({ tasks });

test("goal planner routes through the shared invocation service and books C3 budget", async () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 50, maxInputTokens: 1e9, maxOutputTokens: 1e9 });
	const port = {
		attempt: async (_request, onUsage) => {
			onUsage({ inputTokens: 11, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.001 });
			return planJson([entry("A"), entry("C", ["A"])]);
		},
		newRequestId: () => "req-1",
	};
	const { service, context } = invocations(port, budget, {
		estimate: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
		unknown: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
	});
	const planner = createGoalPlanner({ invocations: service, context, vocabulary, repositoryFacts: "facts" });
	const state = emptyProject("fixture");
	state.objective = "ship it";
	state.board.tasks = [];
	const result = await planner(state, new AbortController().signal);
	assert.deepEqual(
		result.tasks.map((item) => item.task.id),
		["A", "C"],
	);
	assert.equal(result.sealed, false);
	// The planning attempt was metered under the shared root budget (C3), not bypassed.
	assert.equal(budget.usage.attempts, 1);
	assert.equal(budget.usage.usage.inputTokens, 11);
	assert.equal(budget.usage.usage.outputTokens, 7);
});

test("budget exhaustion rejects planning instead of bypassing C3", async () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 1, maxInputTokens: 1e9, maxOutputTokens: 1e9 });
	const port = {
		attempt: async (_request, onUsage) => {
			onUsage({ inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
			return planJson([entry("A")]);
		},
		newRequestId: () => "req-1",
	};
	const { authority: idAuthority, credential } = authority();
	const service = new AuxiliaryModelInvocations({
		authority: idAuthority,
		budget,
		port,
		targets,
		estimates: {
			planning: {
				estimate: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
				unknown: { inputTokens: 100, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 },
			},
		},
	});
	const context = { credential, scope: "project:pi861", taskId: null };
	const planner = createGoalPlanner({ invocations: service, context, vocabulary, repositoryFacts: "facts" });
	const state = emptyProject("fixture");
	state.objective = "goal";
	await planner(state, new AbortController().signal); // consumes the single allowed attempt
	// The second planning round cannot reserve: budget penetration is rejected, never bypassed.
	await assert.rejects(planner(state, new AbortController().signal), BudgetExhausted);
	assert.equal(budget.usage.attempts, 1, "no unmetered attempt may sneak through");
});

test("planner output with unknown dependency references is rejected at the scheduling layer", async () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 50, maxInputTokens: 1e9, maxOutputTokens: 1e9 });
	const port = {
		attempt: async () => planJson([entry("X", ["ghost"])]),
		newRequestId: () => "req-1",
	};
	const { authority: idAuthority, credential } = authority();
	const service = new AuxiliaryModelInvocations({ authority: idAuthority, budget, port, targets });
	const state = emptyProject("fixture");
	state.board.tasks = [];
	await assert.rejects(
		createGoalPlanner({
			invocations: service,
			context: { credential, scope: "project:pi861", taskId: null },
			vocabulary,
			repositoryFacts: "facts",
		})(state, new AbortController().signal),
		/unknown dependency: ghost/,
	);
});

test("planner output with a dependency cycle is rejected at the scheduling layer", async () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 50, maxInputTokens: 1e9, maxOutputTokens: 1e9 });
	const port = {
		attempt: async () => planJson([entry("A", ["B"]), entry("B", ["A"])]),
		newRequestId: () => "req-1",
	};
	const { authority: idAuthority, credential } = authority();
	const service = new AuxiliaryModelInvocations({ authority: idAuthority, budget, port, targets });
	const state = emptyProject("fixture");
	state.board.tasks = [];
	await assert.rejects(
		createGoalPlanner({
			invocations: service,
			context: { credential, scope: "project:pi861", taskId: null },
			vocabulary,
			repositoryFacts: "facts",
		})(state, new AbortController().signal),
		/dependency cycle/,
	);
});

test("planner output that survives an existing board may depend on already-known tasks", async () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 50, maxInputTokens: 1e9, maxOutputTokens: 1e9 });
	const port = {
		attempt: async () => planJson([entry("C2", ["A"])]),
		newRequestId: () => "req-1",
	};
	const { authority: idAuthority, credential } = authority();
	const service = new AuxiliaryModelInvocations({ authority: idAuthority, budget, port, targets });
	const state = emptyProject("fixture");
	state.board.tasks = [
		{
			id: "A",
			title: "A",
			dependsOn: [],
			writeScopes: ["a.txt"],
			capabilities: [],
			acceptance: ["check"],
			status: "done",
			attempts: 1,
			artifacts: [],
			evidence: ["done"],
		},
	];
	const result = await createGoalPlanner({
		invocations: service,
		context: { credential, scope: "project:pi861", taskId: null },
		vocabulary,
		repositoryFacts: (live) => `facts for ${live.board.tasks.length} tasks`,
		sealed: (live) => live.board.tasks.length > 0,
	})(state, new AbortController().signal);
	assert.equal(result.sealed, true);
	assert.equal(result.tasks[0].task.dependsOn[0], "A");
});

test("empty vocabulary and empty sealing batches are refused", async () => {
	const budget = new TaskTreeBudget({ maxTotalCostUsd: 1, maxAttempts: 50, maxInputTokens: 1e9, maxOutputTokens: 1e9 });
	const { authority: idAuthority, credential } = authority();
	const service = new AuxiliaryModelInvocations({ authority: idAuthority, budget, port: { attempt: async () => planJson([entry("A")]), newRequestId: () => "r" }, targets });
	const state = emptyProject("fixture");
	await assert.rejects(
		createGoalPlanner({
			invocations: service,
			context: { credential, scope: "project:pi861", taskId: null },
			vocabulary: { models: [], roles: ["dev"], checkIds: ["verify"] },
			repositoryFacts: "facts",
		})(state, new AbortController().signal),
		/non-empty model, role and check vocabularies/,
	);
	// An empty sealing batch can only arrive through a stub port (P1-S projectPlan rejects empty
	// plans itself); the adapter still refuses to seal a goal with no tasks at all.
	await assert.rejects(
		createGoalPlanner({
			invocations: { plan: async () => [] },
			context: { credential, scope: "project:pi861", taskId: null },
			vocabulary,
			repositoryFacts: "facts",
			sealed: true,
		})(state, new AbortController().signal),
		/at least one task/,
	);
});
