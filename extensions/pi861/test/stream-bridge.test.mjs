import assert from "node:assert/strict";
import { test } from "node:test";
import { AttemptStreamBridge } from "../src/live/stream-bridge.ts";

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
