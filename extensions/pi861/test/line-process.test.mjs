import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LineProcess } from "../src/live/line-process.ts";

const fixture = fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("./fixtures/", import.meta.url));

// A killed orphan can remain as a Linux zombie until PID 1 reaps it. It cannot
// execute or hold its workspace open, but kill(pid, 0) still succeeds. Do not
// mistake that reaping delay for a live descendant, or accept a running process.
function assertProcessStopped(pid) {
	try { process.kill(pid, 0); }
	catch (error) {
		if (error.code === "ESRCH") return;
		throw error;
	}
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const state = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0];
			if (state === "Z") return;
		} catch (error) {
			if (error.code === "ENOENT") return; // Reaped between the two observations.
			throw error;
		}
	}
	assert.fail(`Owned process ${pid} is still running`);
}

test("process-stop assertion rejects a live process", () => {
	assert.throws(() => assertProcessStopped(process.pid), /still running/);
});

test("owned process tree closes before its workspace can be reused and preserves MCP wire ids", { timeout: 15000 }, async () => {
	const child = new LineProcess({ command: process.execPath, args: [fixture], cwd });
	let pids;
	try {
		const reply = await child.request({ jsonrpc: "2.0", id: "operator-supplied", method: "identify" }, AbortSignal.timeout(5000));
		assert.equal(reply.id, "operator-supplied");
		assert.equal(reply.result.requestId, "operator-supplied");
		pids = reply.result;
		const abort = new AbortController();
		const pending = child.request({ id: "duplicate", method: "hang" }, abort.signal);
		await assert.rejects(child.request({ id: "duplicate", method: "hang" }, abort.signal), /Duplicate in-flight/);
		abort.abort(new Error("cancelled by test"));
		await assert.rejects(pending, /cancelled/);
		await child.close();
		await child.close();
		// Negative: a closed process rejects new requests and raw sends instead of silently reviving.
		await assert.rejects(child.request({ id: "after-close", method: "identify" }, AbortSignal.timeout(1000)), /closed/i);
		assert.throws(() => child.send({ type: "after-close" }), /closed/i);
		assertProcessStopped(pids.parent);
		assertProcessStopped(pids.descendant);
	} finally {
		await child.close();
		for (const pid of pids ? [pids.parent, pids.descendant] : []) {
			try { process.kill(pid, "SIGKILL"); } catch {}
		}
	}
});

test("failed process startup closes without hanging", { timeout: 5000 }, async () => {
	const child = new LineProcess({ command: fileURLToPath(new URL("./no-such-owned-process.exe", import.meta.url)), args: [], cwd });
	await assert.rejects(child.request({ method: "identify" }, AbortSignal.timeout(1000)), /could not start|pipe|closed/i);
	await child.close();
});
