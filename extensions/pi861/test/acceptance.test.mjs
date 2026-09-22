import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseAcceptanceConfig, runAcceptance } from "../src/live/acceptance.ts";

function workspace(t) {
	const path = mkdtempSync(join(tmpdir(), "pi861 acceptance "));
	t.after(() => rmSync(path, { recursive: true, force: true }));
	execFileSync("git", ["init", "--quiet", path]);
	writeFileSync(join(path, "artifact.txt"), "initial");
	execFileSync("git", ["add", "artifact.txt"], { cwd: path });
	execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "core.hooksPath=/dev/null", "commit", "--quiet", "-m", "fixture"], { cwd: path });
	return path;
}
const check = (id, args, extra = {}) => ({ id, command: process.execPath, args, kind: "behavioral-check", reporter: "exit", ...extra });
test("acceptance executes trusted commands at the artifact, records evidence, redacts explicit env values", async (t) => {
	const path = workspace(t);
	writeFileSync(join(path, "check.mjs"), 'console.log(process.cwd()); console.log(process.env.PRIVATE_VALUE); if(process.env.BRAVE_SEARCH_API_KEY) process.exit(99);');
	const report = await runAcceptance({ workspace: path, checks: [check("pass", ["check.mjs"], { env: { PRIVATE_VALUE: "secret-fixture-value" } }), check("failure", ["--eval", "process.exit(4)"])] });
	assert.equal(report.status, "failed");
	assert.equal(report.checks[0].status, "passed");
	assert.equal(report.checks[0].counts, null);
	assert.equal(report.checks[1].exitCode, 4);
	assert.equal(report.workspaceChanged, false);
	assert.equal(report.independentReview, "not-performed");
	assert.ok(/^[a-f0-9]{40}$/.test(report.codeSha));
	assert.ok(report.checks[0].stdout.includes(path));
	assert.ok(report.checks[0].evidence.startsWith("check:pass:passed:sha256:"));
	assert.equal(JSON.stringify(report).includes("secret-fixture-value"), false);
});
test("TAP counts distinguish skip and failed tests from passing acceptance", async (t) => {
	const path = workspace(t);
	writeFileSync(join(path, "fixture.mjs"), 'import {test} from "node:test"; test("pass",()=>{}); test.skip("skip",()=>{});');
	const report = await runAcceptance({ workspace: path, checks: [check("node", ["--test", "--test-reporter=tap", "fixture.mjs"], { reporter: "tap" }), check("missing", ["--eval", 'console.log("no test summary")'], { reporter: "tap" })] });
	assert.equal(report.status, "incomplete");
	assert.deepEqual(report.checks[0].counts, { tests: 2, passed: 1, failed: 0, skipped: 1, cancelled: 0, todo: 0 });
	assert.equal(report.checks[1].status, "incomplete");
});
test("timeouts, cancellation, and mutation prevent acceptance", async (t) => {
	const path = workspace(t);
	const report = await runAcceptance({ workspace: path, checks: [check("timeout", ["--eval", "setInterval(()=>{},1000)"], { timeoutMs: 60 }), check("mutate", ["--eval", 'require("node:fs").writeFileSync("artifact.txt","changed")'])] });
	assert.equal(report.checks[0].termination, "timeout");
	assert.equal(report.workspaceChanged, true);
	assert.equal(report.status, "failed");
	const stop = new AbortController(); stop.abort();
	const cancelled = await runAcceptance({ workspace: path, checks: [check("cancel", ["--eval", "process.exit(0)"])] }, stop.signal);
	assert.equal(cancelled.checks[0].termination, "cancelled");
	assert.equal(cancelled.status, "failed");
});
test("invalid trusted configuration and wrong commit fail before executing", async (t) => {
	const path = workspace(t);
	assert.throws(() => parseAcceptanceConfig({ workspace: ".", checks: [] }), /absolute/);
	assert.throws(() => parseAcceptanceConfig({ workspace: path, checks: [check("x", []), check("x", [])] }), /Invalid/);
	await assert.rejects(runAcceptance({ workspace: path, expectedCommit: "0".repeat(40), checks: [check("x", ["--eval", "process.exit(0)"])] }), /commit/);
});
test("acceptance CLI writes a version-bound JSON report and exits nonzero on skip", async (t) => {
	const path = workspace(t), config = join(path, "config.json"), output = join(path, "report.json");
	writeFileSync(config, JSON.stringify({ workspace: path, checks: [check("exit", ["--eval", "process.exit(0)"])] }));
	const cli = fileURLToPath(new URL("../scripts/run-acceptance.mjs", import.meta.url));
	execFileSync(process.execPath, [cli, config, output], { env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
	const report = JSON.parse(readFileSync(output, "utf8"));
	assert.equal(report.status, "passed");
	assert.equal(report.checks[0].exitCode, 0);
});
