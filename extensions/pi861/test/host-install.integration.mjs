import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadExtensionFromFactory, createExtensionRuntime } from "../../../packages/coding-agent/src/core/extensions/loader.ts";
import { createEventBus } from "../../../packages/coding-agent/src/core/event-bus.ts";
import { installPi861 } from "../index.ts";
import { hostPort } from "../runtime.ts";

const cwd = fileURLToPath(new URL("../../../", import.meta.url));

test("real source host facades share one Pi861 installation claim", async () => {
	const runtime = createExtensionRuntime();
	const bus = createEventBus();
	const apis = [];
	const factory = (pi) => {
		apis.push(pi);
		installPi861(pi, { search: { enabled: false } });
	};
	const first = await loadExtensionFromFactory(factory, cwd, bus, runtime, "<pi861-first>");
	assert.ok(first.commands.has("goal"));
	await assert.rejects(loadExtensionFromFactory(factory, cwd, bus, runtime, "<pi861-duplicate>"), /already installed/);
	assert.notEqual(apis[0].events, apis[1].events);
	const secondRuntime = createExtensionRuntime();
	const secondBus = createEventBus();
	const independent = await loadExtensionFromFactory(factory, cwd, secondBus, secondRuntime, "<pi861-other-host>");
	assert.ok(independent.commands.has("goal"));
	await assert.rejects(loadExtensionFromFactory(factory, cwd, bus, runtime, "<pi861-still-duplicate>"), /already installed/);
	runtime.invalidate();
	const reloaded = await loadExtensionFromFactory(factory, cwd, bus, createExtensionRuntime(), "<pi861-reloaded>");
	assert.ok(reloaded.commands.has("goal"));
});

test("real host adapter validates tool gates and context results", async () => {
	const bus = createEventBus(), runtime = createExtensionRuntime();
	let port;
	const extension = await loadExtensionFromFactory((pi) => {
		port = hostPort(pi);
		port.on("tool_call", () => ({ block: true, reason: "operator policy" }));
		port.on("before_agent_start", () => ({ message: { customType: "memory", content: "untrusted", display: false } }));
	}, cwd, bus, runtime, "<adapter>");
	assert.deepEqual(await extension.handlers.get("tool_call")[0]({}, {}), { block: true, reason: "operator policy" });
	assert.equal((await extension.handlers.get("before_agent_start")[0]({}, {})).message.content, "untrusted");
	assert.throws(() => port.on("unrecognized_event", () => {}), /does not carry/);
	port.on("tool_call", () => ({ block: "yes" }));
	await assert.rejects(extension.handlers.get("tool_call")[1]({}, {}), /Invalid Pi861 tool gate/);
});

test("basic and full runtime compositions are mutually exclusive on one host", async () => {
	const bus = createEventBus(), runtime = createExtensionRuntime();
	const basic = await loadExtensionFromFactory((pi) => {
		installPi861(pi, { search: { enabled: false } });
	}, cwd, bus, runtime, "<pi861-basic>");
	assert.ok(basic.commands.has("goal"));
	assert.ok(basic.commands.has("web-search"));
	// The full runtime entry composes through the same install claim via the
	// host adapter; a second composition must be refused instead of registering
	// a second goal owner, model controller or memory collector.
	await assert.rejects(
		loadExtensionFromFactory((pi) => {
			installPi861(hostPort(pi), { managedGoal: true, managedSearch: true });
		}, cwd, bus, runtime, "<pi861-full-duplicate>"),
		/already installed/,
	);
	const full = await loadExtensionFromFactory((pi) => {
		installPi861(hostPort(pi), { managedGoal: true, managedSearch: true });
	}, cwd, createEventBus(), createExtensionRuntime(), "<pi861-full-alone>");
	assert.equal(full.commands.has("goal"), false, "managed goal defers to the full runtime entry");
	assert.equal(full.commands.has("web-search"), false, "managed search defers to the installed web service");
	assert.ok(full.tools.has("pi861_memory"));
});
