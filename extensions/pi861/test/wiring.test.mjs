// H-owned wiring acceptance tests (deterministic, no real Pi host): the managed
// stream adapter replaces the buffered wrapper, dispatch meters on the C3 service,
// the typed publication contract rejects the legacy signature, and trusted
// behavioral cases come only from the operator file or publish fails honestly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { managedStream } from "../src/live/managed-stream.ts";
import { StreamClaims } from "../src/live/stream-claims.ts";
import { businessOperationId } from "../src/live/stream-bridge.ts";
import { ModelRuntime } from "../src/live/model-runtime.ts";
import {
	emptyUsageLedger,
	ModelRequestService,
	ModelUsageService,
} from "../src/live/model-service.ts";
import { FileStateStore } from "../src/live/store.ts";
import { SkillRepository, emptySkillState } from "../src/live/skill-repository.ts";
import { loadTrustedSkillCases } from "../src/live/skill-cases.ts";
import { runSkillValidation } from "../src/live/skill-validation.ts";

const POLICY = {
	targets: [
		{
			id: "m1",
			revision: "r1",
			provider: "fixture",
			model: "m1",
			quality: 2,
			costRank: 1,
			contextWindow: 200_000,
			capabilities: ["text"],
			enabled: true,
		},
	],
	preferred: "m1",
	requirements: { minQuality: 1, contextTokens: 100_000, capabilities: ["text"], allowedIds: ["m1"] },
	recovery: { failoverEnabled: true, failbackEnabled: false, probeIntervalMs: 1000, maxProbeIntervalMs: 5000, requiredProbeSuccesses: 2 },
	maxAttempts: 2,
	requestTimeoutMs: 10_000,
	maxRequests: 50,
	maxProbeRequests: 1,
};

function collector() {
	const events = [];
	return {
		events,
		output: {
			push(event) {
				events.push(structuredClone(event));
			},
		},
	};
}
const failureMessage = (error, reason) => ({
	content: [],
	stopReason: reason,
	errorMessage: error instanceof Error ? error.message : "failed",
});
function fixtureMessage(extra = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "streamed wiring response" }],
		api: "openai-completions",
		provider: "fixture",
		model: "m1",
		usage: { input: 37, output: 11, cacheRead: 0, cacheWrite: 0, totalTokens: 48, cost: { input: 0.0001, output: 0.0001, cacheRead: 0, cacheWrite: 0, total: 0.0002 } },
		stopReason: "stop",
		timestamp: Date.now(),
		...extra,
	};
}

test("managed stream: text is observable before the terminal message; tool arguments stay private until commit", async () => {
	let release;
	const gate = new Promise((resolve) => {
		release = resolve;
	});
	const runtime = new ModelRuntime(
		POLICY,
		// The infer callback mirrors the runtime.ts wiring: begin the bridge, forward
		// provider events, and hold the terminal done until the fixture releases it.
		async (_target, request, _signal, _onProgress, _onUsage, attempt) => {
			const live = request.stream;
			const message = fixtureMessage({
				content: [
					{ type: "text", text: "streamed wiring response" },
					{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "x", content: "secret-until-commit" } },
				],
				stopReason: "toolUse",
			});
			live.attempt = attempt;
			live.bridge.begin(attempt, new AbortController().signal);
			live.bridge.push(attempt, { type: "start", partial: message });
			live.bridge.push(attempt, { type: "text_delta", contentIndex: 0, delta: "streamed ", partial: message });
			await gate;
			live.bridge.push(attempt, { type: "done", reason: "toolUse", message });
			return message;
		},
		async () => true,
	);
	const { events, output } = collector();
	const stream = managedStream(() => runtime, () => output, failureMessage);
	// Drive the provider stream and observe events while the fixture holds its terminal message.
	stream({ id: "managed" }, { messages: [] }, {});
	await sleep(30);
	assert.ok(events.some((event) => event.type === "start" && event.partial.content.length === 0));
	const delta = events.find((event) => event.type === "text_delta");
	assert.ok(delta, "text delta must be observable before the terminal message");
	assert.equal(delta.delta, "streamed ");
	// Tool arguments and toolcall events never appear before commit.
	for (const event of events) {
		assert.ok(!JSON.stringify(event).includes("secret-until-commit"), "tool arguments leaked before commit");
		if (event.type !== "done")
			assert.ok(event.type !== "toolcall_start" && event.type !== "toolcall_end", "no toolcall events before commit");
	}
	assert.equal(events.some((event) => event.type === "done"), false, "terminal must not be emitted while held");
	release();
	await sleep(50);
	const done = events.at(-1);
	assert.equal(done.type, "done");
	const committed = events.filter((event) => event.type === "toolcall_end");
	assert.equal(committed.length, 1);
	assert.equal(committed[0].toolCall.arguments.content, "secret-until-commit");
});

test("managed stream: a provider failure cancels the buffered stream and emits one terminal error", async () => {
	const runtime = new ModelRuntime(POLICY, async (_target, request, signal, _onProgress, _onUsage, attempt) => {
		const live = request.stream;
		const partial = fixtureMessage();
		live.bridge.begin(attempt, signal);
		live.bridge.push(attempt, { type: "start", partial });
		live.bridge.push(attempt, { type: "text_delta", contentIndex: 0, delta: "partial ", partial });
		live.bridge.push(attempt, { type: "error", reason: "error", error: fixtureMessage({ stopReason: "error", errorMessage: "ECONNRESET fixture" }) });
		throw new Error("fixture transport failed");
	}, async () => true);
	const { events, output } = collector();
	const stream = managedStream(() => runtime, () => output, failureMessage);
	stream({ id: "managed" }, { messages: [] }, {});
	await sleep(50);
	const error = events.at(-1);
	assert.equal(error.type, "error");
	assert.equal(events.filter((event) => event.type === "done").length, 0);
	assert.equal(events.filter((event) => event.type === "toolcall_end").length, 0);
});

test("the runtime meters every physical dispatch on the C3 model service (meteringMode service)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi861-wiring-meter-"));
	try {
		const usage = new ModelUsageService(new FileStateStore(join(directory, "model-usage.json"), emptyUsageLedger()), {
			estimate: { inputTokens: 32_000, outputTokens: 8_192, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2 },
			unknownEstimate: { inputTokens: 32_000, outputTokens: 8_192, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2 },
		});
		const requests = new ModelRequestService(usage);
		let reported;
		const runtime = new ModelRuntime(
			POLICY,
			async (_target, _request, _signal, _onProgress, onUsage) => {
				onUsage?.({ inputTokens: 37, outputTokens: 11, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.0002 });
				reported = true;
				return fixtureMessage();
			},
			async () => true,
			undefined,
			() => {},
			{ requests },
		);
		assert.equal(runtime.meteringMode, "service");
		const message = await runtime.call({ messages: [] }, new AbortController().signal);
		assert.equal(message.stopReason, "stop");
		assert.ok(reported);
		const state = JSON.parse(await readFile(join(directory, "model-usage.json"), "utf8"));
		assert.equal(state.byPurpose.execution, 1);
		assert.equal(state.records.length, 1);
		assert.equal(state.records[0].usage.inputTokens, 37);
		assert.equal(state.records[0].settledUnknown, false);
		// The wiring boundary: a runtime constructed without hooks.requests is unmetered
		// and must never pass the production gate (review N1 negative).
		const bare = new ModelRuntime(POLICY, async () => fixtureMessage(), async () => true);
		assert.equal(bare.meteringMode, "unmetered");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("typed publication: the legacy publish signature is rejected and publish fails honestly without trusted cases", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi861-wiring-publish-"));
	try {
		const skillDir = join(directory, "skill");
		await mkdir(skillDir);
		await writeFile(join(skillDir, "SKILL.md"), "# Wiring fixture\nKeep the wiring-marker constraint visible.");
		const repository = new SkillRepository(new FileStateStore(join(directory, "skills.json"), emptySkillState()));
		await repository.install(skillDir, { id: "wiring-skill", group: "wiring", revision: "1" });
		const compiler = {
			compile: async () => ({
				id: "wiring-skill",
				revision: "seed",
				title: "Wiring",
				category: "test",
				instructions: "Keep the wiring-marker constraint visible.",
				branches: [
					{
						id: "main",
						when: "always",
						instructions: "Follow the wiring-marker constraint.",
						environment: [],
						conflictsWith: [],
						tools: [],
					},
				],
				sources: [],
			}),
		};
		const candidate = await repository.compile("wiring", compiler, new AbortController().signal);
		// Negative: the legacy signatures (no evidence callback / boolean flag) are rejected.
		await assert.rejects(repository.publish(candidate.id), /validate is not a function|TypeError/);
		await assert.rejects(repository.publish(candidate.id, true), /validate is not a function|TypeError/);
		// Negative: untyped evidence never passes.
		await assert.rejects(
			repository.publish(candidate.id, async () => ({ evidence: [] })),
			/typed evidence/,
		);
		const owner = {
			producedBy: { tenantId: "local", projectId: "wiring", goalId: "manual", runId: "host", taskId: "skill-publish", attempt: 1 },
			scope: "project:wiring",
			recordedBy: "main",
		};
		// Negative: without trusted behavioral cases validation fails honestly.
		await assert.rejects(
			runSkillValidation(candidate.skill, { ...owner, approvedBindings: [], environment: [], cases: [] }, new AbortController().signal),
			/trusted cases for every branch/,
		);
		// The operator cases file is the only source; malformed files are refused.
		const casesFile = join(directory, "cases.json");
		await writeFile(casesFile, JSON.stringify({ wiring: [{ branchId: "main", phase: "use", instructionIncludes: ["wiring-marker"] }] }));
		const trusted = loadTrustedSkillCases(casesFile);
		assert.equal(trusted.wiring.length, 1);
		assert.throws(() => loadTrustedSkillCases("relative-cases.json"), /absolute/);
		await writeFile(casesFile, JSON.stringify({ wiring: [{ branchId: "", phase: "use", instructionIncludes: ["x"] }] }));
		assert.throws(() => loadTrustedSkillCases(casesFile), /Invalid trusted case/);
		assert.deepEqual(loadTrustedSkillCases(undefined), {});
		// Positive: with trusted cases the validation layer records real behavioral evidence.
		const validation = await runSkillValidation(
			candidate.skill,
			{ ...owner, approvedBindings: [], environment: [], cases: trusted.wiring },
			new AbortController().signal,
		);
		assert.ok(validation.evidence.some((item) => item.kind === "behavioral-check"));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("C5 stream claims: business tools claim once, settle from the receipt, and lost receipts block until reconciliation", async () => {
	const identity = { serviceId: "server-a", toolName: "deposit", accountId: "acct", resourceId: "res-1", schemaDigest: "sha" };
	const registry = new Map([["pi861_mcp_fixture", { binding: null, identity }]]);
	const claims = new StreamClaims(
		(toolName) => {
			const resolved = registry.get(toolName);
			return resolved ? { identity: resolved.identity, business: true } : undefined;
		},
		(toolName) => ({ serviceId: "pi-host", toolName, accountId: "local", resourceId: toolName, schemaDigest: `d-${toolName}` }),
	);
	// Business identity: the same complete arguments map to one operation across attempts and call ids.
	const first = claims.bind({ type: "toolCall", id: "call-1", name: "pi861_mcp_fixture", arguments: { amount: 5 } });
	const second = claims.bind({ type: "toolCall", id: "call-2", name: "pi861_mcp_fixture", arguments: { amount: 5 } });
	assert.equal(businessOperationId(first), businessOperationId(second));
	// Native tools are per-call local intents: identical invocations never collide.
	const writeA = claims.bind({ type: "toolCall", id: "w-1", name: "write", arguments: { path: "x" } });
	const writeB = claims.bind({ type: "toolCall", id: "w-2", name: "write", arguments: { path: "x" } });
	assert.notEqual(businessOperationId(writeA), businessOperationId(writeB));
	// An unresolved capability name is refused before any claim.
	assert.throws(
		() => claims.bind({ type: "toolCall", id: "call-3", name: "pi861_mcp_missing", arguments: {} }),
		/no active capability binding/,
	);
	// Dispatch, settle from the receipt, and confirm nothing blocks.
	claims.ledger.prepare(businessOperationId(writeA), writeA.identity, writeA.inputDigest, 1);
	claims.ledger.markDispatched(businessOperationId(writeA), 1);
	assert.equal(claims.settle("w-1", { ok: true }, false), businessOperationId(writeA));
	assert.equal(claims.unsettled(), 0);
	// A lost receipt parks as unknown and blocks; reconciliation not-executed re-arms it.
	claims.ledger.prepare(businessOperationId(writeB), writeB.identity, writeB.inputDigest, 2);
	claims.ledger.markDispatched(businessOperationId(writeB), 2);
	claims.markLostReceipts(3);
	assert.equal(claims.unsettled(), 1);
	assert.equal(claims.pending().length, 1);
	claims.reconcile(businessOperationId(writeB), { status: "not-executed" }, 4);
	assert.equal(claims.unsettled(), 0);
	// Error receipts settle as failed and free the slot (fresh claim, after the sweep).
	const failing = claims.bind({ type: "toolCall", id: "call-4", name: "pi861_mcp_fixture", arguments: { amount: 9 } });
	claims.ledger.prepare(businessOperationId(failing), failing.identity, failing.inputDigest, 5);
	claims.ledger.markDispatched(businessOperationId(failing), 5);
	assert.equal(claims.settle("call-4", { error: "x" }, true), businessOperationId(failing));
	assert.equal(claims.unsettled(), 0);
	assert.equal(claims.ledger.get(businessOperationId(failing)).status, "failed");
});

test("C5 gate through the managed stream: an unsettled operation refuses the next model call until reconciled", async () => {
	const identity = { serviceId: "s", toolName: "t", accountId: "a", resourceId: "r", schemaDigest: "h" };
	const registry = new Map([["pi861_mcp_gated", { identity }]]);
	const claims = new StreamClaims(
		(toolName) => {
			const resolved = registry.get(toolName);
			return resolved ? { identity: resolved.identity, business: true } : undefined;
		},
		(toolName) => ({ serviceId: "pi-host", toolName, accountId: "local", resourceId: toolName, schemaDigest: "d" }),
	);
	let dispatchCount = 0;
	const runtime = new ModelRuntime(
		POLICY,
		async (_target, request, signal, _onProgress, _onUsage, attempt) => {
			const live = request.stream;
			const message = fixtureMessage({
				content: [{ type: "toolCall", id: "gate-1", name: "pi861_mcp_gated", arguments: { n: 1 } }],
				stopReason: "toolUse",
			});
			live.attempt = attempt;
			live.bridge.begin(attempt, signal);
			live.bridge.push(attempt, { type: "start", partial: message });
			live.bridge.push(attempt, { type: "done", reason: "toolUse", message });
			dispatchCount++;
			return message;
		},
		async () => true,
	);
	const { events, output } = collector();
	const c5 = {
		prepare: async () => claims.unsettled(),
		wiring: { ledger: claims.ledger, bind: claims.bind },
	};
	const stream = managedStream(() => runtime, () => output, failureMessage, c5);
	// First call: the committed tool is claimed and dispatched exactly once.
	stream({ id: "managed" }, { messages: [] }, {});
	await sleep(40);
	assert.equal(dispatchCount, 1);
	assert.ok(events.some((event) => event.type === "toolcall_end"));
	const operationId = claims.ledger.exportState().operations.find((op) => op.status === "dispatched")?.operationId;
	assert.ok(operationId, "the committed tool must hold a dispatched claim");
	// The receipt never arrives; at turn end it parks unknown and the next call is refused.
	claims.markLostReceipts();
	assert.equal(claims.unsettled(), 1);
	const second = collector();
	const stream2 = managedStream(() => runtime, () => second.output, failureMessage, c5);
	stream2({ id: "managed" }, { messages: [] }, {});
	await sleep(40);
	assert.equal(dispatchCount, 1, "no second model dispatch while an operation is unsettled");
	assert.equal(second.events.at(-1).type, "error");
	assert.match(second.events.at(-1).error.errorMessage, /reconcile pending operations first/);
	// Trusted reconciliation re-arms dispatch.
	claims.reconcile(operationId, { status: "not-executed" });
	const third = collector();
	const stream3 = managedStream(() => runtime, () => third.output, failureMessage, c5);
	stream3({ id: "managed" }, { messages: [] }, {});
	await sleep(40);
	assert.equal(dispatchCount, 2);
	assert.ok(third.events.some((event) => event.type === "done"));
});
