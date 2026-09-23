import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { LineProcess } from "../src/live/line-process.ts";

const fixture = fileURLToPath(new URL("./fixtures/process-tree.mjs", import.meta.url));
const cwd = fileURLToPath(new URL("./fixtures/", import.meta.url));

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
		assert.throws(() => process.kill(pids.parent, 0), { code: "ESRCH" });
		assert.throws(() => process.kill(pids.descendant, 0), { code: "ESRCH" });
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
