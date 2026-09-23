import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../src/contracts/hash.ts";
import { OperationLedger } from "../src/contracts/operation.ts";
import { ModelRuntime } from "../src/live/model-runtime.ts";
import {
	AttemptStreamBridge,
	businessOperationId,
	StreamOperationBlocked,
} from "../src/live/stream-bridge.ts";
import { ModelFailure } from "../src/routing.ts";

const attempt = (generation = 1) => ({ generation, configId: "fixture", configRevision: "1" });
const signal = () => new AbortController().signal;
const text = { type: "text", text: "answer" };
const tool = { type: "toolCall", id: "write-1", name: "write", arguments: { path: "out.txt" } };
const message = (...content) => ({ content, model: "fixture", usage: { input: 2, output: 1 } });
function fixture(validate = (value) => value.name === "write" && typeof value.arguments.path === "string") {
	const events = [];
	const bridge = new AttemptStreamBridge((event, owner) => events.push({ event, owner }), validate);
	return { bridge, events };
}


test("text streams before completion while partial tools remain private", () => {
	const { bridge, events } = fixture();
	const owner = attempt();
	bridge.begin(owner, signal());
	bridge.push(owner, { type: "start", partial: message() });
	bridge.push(owner, {
		type: "toolcall_delta",
		contentIndex: 0,
		delta: '{"path":',
		partial: message({ ...tool, arguments: {} }),
	});
	bridge.push(owner, { type: "text_delta", contentIndex: 1, delta: "answer", partial: message(tool, text) });
	assert.deepEqual(
		events.map((item) => item.event.type),
		["start", "text_delta"],
	);
	assert.equal(events[1].event.contentIndex, 0);
	assert.deepEqual(events[1].event.partial.content, [text]);
	assert.equal(events[1].owner.tentative, true);
	bridge.push(owner, { type: "error", reason: "error", error: message(tool) });
	assert.equal(bridge.commit(owner), false);
	assert.equal(
		events.some((item) => item.event.type.startsWith("toolcall")),
		false,
	);
});

test("new attempts fence old deltas, terminal responses and commits", () => {
	const { bridge, events } = fixture();
	const old = attempt(),
		next = attempt(2);
	bridge.begin(old, signal());
	bridge.push(old, { type: "text_delta", contentIndex: 0, delta: "old", partial: message({ ...text, text: "old" }) });
	bridge.begin(next, signal());
	assert.equal(bridge.push(old, { type: "done", reason: "toolUse", message: message(tool) }), false);
	assert.equal(bridge.commit(old), false);
	bridge.push(next, { type: "done", reason: "stop", message: message(text) });
	assert.equal(bridge.commit(next), true);
	assert.equal(bridge.commit(next), false);
	assert.equal(events.filter((item) => item.event.type === "done").length, 1);
	assert.equal(events.at(-1).owner.attempt.generation, 2);
});

test("complete tool calls wait for commit and the complete batch must validate", () => {
	const { bridge, events } = fixture();
	const owner = attempt();
	bridge.begin(owner, signal());
	bridge.push(owner, { type: "toolcall_end", contentIndex: 0, toolCall: tool, partial: message(tool) });
	bridge.push(owner, {
		type: "done",
		reason: "toolUse",
		message: message(tool, { ...tool, id: "write-2", arguments: {} }),
	});
	assert.equal(events.length, 0);
	assert.throws(() => bridge.commit(owner), /invalid/);
	assert.equal(events.length, 0);
});

test("cancellation before dispatch discards buffered tools", () => {
	const { bridge, events } = fixture();
	const owner = attempt(),
		controller = new AbortController();
	bridge.begin(owner, controller.signal);
	bridge.push(owner, { type: "done", reason: "toolUse", message: message(tool) });
	controller.abort();
	assert.equal(bridge.commit(owner), false);
	assert.equal(events.length, 0);
	bridge.cancel();
	assert.throws(() => bridge.begin(attempt(2), signal()), /committed/);
});

test("pending operations block dispatch and a committed tool is never emitted twice", () => {
	const { bridge, events } = fixture();
	const owner = attempt();
	bridge.begin(owner, signal());
	bridge.push(owner, { type: "done", reason: "toolUse", message: message(tool) });
	assert.throws(() => bridge.commit(owner, 1), /Reconcile/);
	assert.equal(events.length, 0);
	assert.equal(bridge.commit(owner, 0), true);
	assert.equal(bridge.commit(owner, 0), false);
	assert.deepEqual(
		events.map((item) => item.event.type),
		["start", "toolcall_start", "toolcall_end", "done"],
	);
	assert.equal(
		events.every((item) => item.owner.tentative === false),
		true,
	);
});

test("duplicate tool identities fail before any tool can be dispatched", () => {
	const { bridge, events } = fixture();
	const owner = attempt();
	bridge.begin(owner, signal());
	bridge.push(owner, { type: "done", reason: "toolUse", message: message(tool, tool) });
	assert.throws(() => bridge.commit(owner), /invalid/);
	assert.equal(events.length, 0);
});

// --- AX4 partial coverage: operation authority over committed tool dispatch (C5) ---

const identity = (name) => ({
	serviceId: "svc",
	toolName: name,
	accountId: "acc-1",
	resourceId: "res-1",
	schemaDigest: "sch-1",
});
const bindTool = (binding) => (value) => ({
	identity: binding(value.name),
	inputDigest: digest(value.arguments),
});
function operationFixture(bind = bindTool(identity), ledger = new OperationLedger()) {
	const events = [];
	const bridge = new AttemptStreamBridge((event, owner) => events.push({ event, owner }), () => true, {
		ledger,
		bind,
		now: () => 1,
	});
	return { bridge, events, ledger };
}
const toolEvents = (events) => events.filter((item) => item.event.type.startsWith("toolcall"));

test("a committed tool claims exactly one C5 operation and dispatches once", () => {
	const { bridge, events, ledger } = operationFixture();
	const owner = attempt();
	bridge.begin(owner, signal());
	bridge.push(owner, { type: "done", reason: "toolUse", message: message(tool) });
	assert.equal(bridge.commit(owner), true);
	const operationId = businessOperationId({ identity: identity("write"), inputDigest: digest(tool.arguments) });
	assert.equal(ledger.get(operationId).status, "dispatched");
	assert.equal(toolEvents(events).length, 2); // start + end, exactly one dispatch emission.
	// A second commit of the same stream never re-emits the tool.
	assert.equal(bridge.commit(owner), false);
	assert.equal(toolEvents(events).length, 2);
});

test("a lost receipt blocks re-dispatch until reconciliation and not-executed re-arms once", () => {
	const { bridge: first, events: firstEvents, ledger } = operationFixture();
	const ownerOne = attempt(1);
	first.begin(ownerOne, signal());
	first.push(ownerOne, { type: "done", reason: "toolUse", message: message(tool) });
	assert.equal(first.commit(ownerOne), true);
	const operationId = businessOperationId({ identity: identity("write"), inputDigest: digest(tool.arguments) });
	// The host executed the tool but the receipt was lost: the outcome is unknown, never assumed.
	ledger.markUnknown(operationId, "receipt lost", 2);
	// A NEW model attempt (new bridge instance) requests the same business operation under a
	// different local toolCallId; changing that id never authorizes a re-send (C5).
	const { bridge: second, events: secondEvents } = operationFixture(bindTool(identity), ledger);
	const replay = { ...tool, id: "write-2" };
	const ownerTwo = attempt(2);
	second.begin(ownerTwo, signal());
	second.push(ownerTwo, { type: "done", reason: "toolUse", message: message(replay) });
	assert.throws(() => second.commit(ownerTwo), (error) => error instanceof StreamOperationBlocked);
	assert.equal(toolEvents(secondEvents).length, 0); // Unknown: zero dispatch, reconciliation required.
	// Trusted reconciliation proves the effect never happened: dispatch may be retried.
	ledger.reconcile(operationId, { status: "not-executed" }, 3);
	assert.equal(second.commit(ownerTwo), true); // Same buffered stream commits after reconciliation.
	assert.equal(toolEvents(secondEvents).length, 2);
	assert.equal(ledger.get(operationId).status, "dispatched");
	ledger.markSucceeded(operationId, digest(["done"]), 4);
	// A succeeded operation can never dispatch again: the side effect is not duplicated.
	const { bridge: third, events: thirdEvents } = operationFixture(bindTool(identity), ledger);
	const ownerThree = attempt(3);
	third.begin(ownerThree, signal());
	third.push(ownerThree, { type: "done", reason: "toolUse", message: message({ ...tool, id: "write-3" }) });
	assert.throws(() => third.commit(ownerThree), (error) => error instanceof StreamOperationBlocked);
	assert.equal(toolEvents(thirdEvents).length, 0);
	assert.equal(firstEvents.length > 0, true);
});

test("a binding failure aborts the whole commit with zero dispatch", () => {
	const bind = (value) => {
		if (value.id === "write-2") throw new Error("tool not authorized for this account");
		return { identity: identity(value.name), inputDigest: digest(value.arguments) };
	};
	const { bridge, events, ledger } = operationFixture(bind);
	const owner = attempt();
	bridge.begin(owner, signal());
	bridge.push(owner, {
		type: "done",
		reason: "toolUse",
		message: message(tool, { ...tool, id: "write-2" }),
	});
	assert.throws(() => bridge.commit(owner), /not authorized/);
	assert.equal(events.length, 0); // Not even the start event: the commit aborted in phase A.
	const prepared = ledger.exportState().operations;
	assert.equal(prepared.length, 1); // Only the authorized tool was declared; it never dispatched.
	assert.equal(prepared[0].status, "prepared");
});

test("partial tool parameters never reach the operation ledger", () => {
	const { bridge, events, ledger } = operationFixture();
	const owner = attempt();
	bridge.begin(owner, signal());
	bridge.push(owner, {
		type: "toolcall_delta",
		contentIndex: 0,
		delta: '{"path":',
		partial: message({ ...tool, arguments: {} }),
	});
	bridge.push(owner, { type: "error", reason: "error", error: message(tool) }); // Stream cut mid-argument.
	assert.equal(bridge.commit(owner), false);
	assert.equal(ledger.exportState().operations.length, 0);
	assert.equal(toolEvents(events).length, 0);
});

// --- AX4 partial coverage: streaming composition through ModelRuntime ---

const streamingTargets = [
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
	},
];
const streamingPolicy = {
	targets: streamingTargets,
	preferred: "cheap",
	requirements: { minQuality: 1, contextTokens: 100, capabilities: ["tools"], allowedIds: ["cheap", "strong"] },
	recovery: {
		failoverEnabled: true,
		failbackEnabled: false,
		probeIntervalMs: 1000,
		maxProbeIntervalMs: 2000,
		requiredProbeSuccesses: 2,
	},
	maxAttempts: 3,
	requestTimeoutMs: 500,
	maxRequests: 20,
	maxProbeRequests: 5,
};

test("text is observable mid-call and a mid-stream retry keeps attempt ownership", async (t) => {
	const observed = [];
	const bridge = new AttemptStreamBridge((event, owner) => observed.push({ event, owner }), () => true);
	let calls = 0;
	let lastAttempt;
	const runtime = new ModelRuntime(
		streamingPolicy,
		async (_target, _context, attemptSignal, _onProgress, _onUsage, attempt) => {
			calls++;
			bridge.begin(attempt, attemptSignal);
			bridge.push(attempt, {
				type: "text_delta",
				contentIndex: 0,
				delta: calls === 1 ? "partial answer" : "final answer",
				partial: message({ ...text, text: calls === 1 ? "partial answer" : "final answer" }),
			});
			if (calls === 1) throw new ModelFailure("transient");
			// Tentative text is already observable before the provider response resolves.
			assert.ok(observed.some((item) => item.event.type === "text_delta"));
			const done = { type: "done", reason: "stop", message: message({ ...text, text: "final answer" }) };
			bridge.push(attempt, done);
			lastAttempt = attempt;
			return done.message;
		},
		async () => true,
	);
	t.after(() => runtime.close());
	const final = await runtime.call({}, signal());
	assert.equal(final.content[0].text, "final answer");
	// One logical stream: the start event fires once (attempt 1), each delta carries its own
	// attempt ownership, and the failed attempt's text stays attributed to its generation. The
	// retry attempt's generation is 3: the kernel advances it once per cancel and once per begin.
	assert.deepEqual(
		observed.map((item) => `${item.event.type}:${item.owner.attempt.generation}:${item.owner.tentative}`),
		["start:1:true", "text_delta:1:true", "text_delta:3:true"],
	);
	// The failed attempt's late terminal output is fenced and never re-emitted.
	assert.equal(
		bridge.push(attempt(1), { type: "done", reason: "stop", message: message(text) }),
		false,
	);
	assert.equal(bridge.commit(lastAttempt), true);
	assert.equal(observed.at(-1).event.type, "done");
	assert.equal(observed.at(-1).owner.attempt.generation, 3);
	assert.equal(observed.at(-1).owner.tentative, false);
	assert.equal(calls, 2);
});
