import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	parseAcceptanceConfig,
	parseAcceptanceManifest,
	runAcceptance,
	validateWorkerPairEvidence,
} from "../src/live/acceptance.ts";

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
const cliEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
test("acceptance executes trusted commands at the artifact, records evidence, redacts explicit env values", async (t) => {
	const path = workspace(t);
	writeFileSync(join(path, "check.mjs"), 'console.log(process.cwd()); console.log(process.env.PRIVATE_VALUE); if(process.env.BRAVE_SEARCH_API_KEY) process.exit(99);');
	const report = await runAcceptance({ workspace: path, checks: [check("pass", ["check.mjs"], { env: { PRIVATE_VALUE: "secret-fixture-value" }, kind: "structural-check" }), check("failure", ["--eval", "process.exit(4)"])] });
	assert.equal(report.status, "failed");
	assert.equal(report.checks[0].status, "passed");
	assert.equal(report.checks[0].outcome, "pass");
	assert.equal(report.checks[0].counts, null);
	assert.equal(report.checks[1].status, "failed");
	assert.equal(report.checks[1].outcome, "fail");
	assert.deepEqual(report.outcomes, { pass: 1, fail: 1, skip: 0, "not-run": 0, blocked: 0 });
	assert.equal(report.checks[1].exitCode, 4);
	assert.equal(report.workspaceChanged, false);
	assert.equal(report.independentReview, "not-performed");
	assert.ok(/^[a-f0-9]{40}$/.test(report.codeSha));
	assert.ok(report.checks[0].stdout.includes(path));
	assert.ok(report.checks[0].evidence.startsWith("check:pass:pass:sha256:"));
	assert.equal(report.checks[0].commandDigest.length, 64);
	assert.equal(JSON.stringify(report).includes("secret-fixture-value"), false);
});
// Regression test adapted from the independent M5 review counterexample
// (C:\Albert\project\pi861-briefs\m5-review-457ccf2\logs\11-acceptance-skip.log):
// "node --test skip.test.mjs" exited 0 with every test skipped, and the exit reporter recorded
// status "passed" with counts null. Skip must remain distinct from pass for every reporter.
test("exit reporter no longer accepts a skip-only test run (m5-review-457ccf2, 11-acceptance-skip)", async (t) => {
	const path = workspace(t);
	writeFileSync(join(path, "skip.test.mjs"), 'import { test } from "node:test"; test.skip("never runs", () => {});');
	const report = await runAcceptance({ workspace: path, checks: [check("skipped", ["--test", "skip.test.mjs"])] });
	assert.notEqual(report.checks[0].status, "passed");
	assert.equal(report.checks[0].status, "incomplete");
	assert.equal(report.checks[0].outcome, "skip");
	assert.ok(report.checks[0].counts);
	assert.equal(report.checks[0].counts.tests, 1);
	assert.equal(report.checks[0].counts.skipped, 1);
	assert.equal(report.checks[0].counts.passed, 0);
	assert.equal(report.status, "incomplete");
	assert.equal(report.outcomes.pass, 0);
	assert.equal(report.outcomes.skip, 1);
});
test("a behavioral check that never starts tests cannot pass on exit code 0", async (t) => {
	const path = workspace(t);
	writeFileSync(join(path, "silent.mjs"), 'console.log("no test runner started");');
	const report = await runAcceptance({ workspace: path, checks: [check("silent", ["silent.mjs"])] });
	assert.equal(report.checks[0].exitCode, 0);
	assert.equal(report.checks[0].counts, null);
	assert.equal(report.checks[0].status, "incomplete");
	assert.equal(report.checks[0].outcome, "not-run");
	assert.equal(report.status, "incomplete");
});
test("TAP counts distinguish skip and failed tests from passing acceptance", async (t) => {
	const path = workspace(t);
	writeFileSync(join(path, "fixture.mjs"), 'import {test} from "node:test"; test("pass",()=>{}); test.skip("skip",()=>{});');
	const report = await runAcceptance({ workspace: path, checks: [check("node", ["--test", "--test-reporter=tap", "fixture.mjs"], { reporter: "tap" }), check("missing", ["--eval", 'console.log("no test summary")'], { reporter: "tap" })] });
	assert.equal(report.status, "incomplete");
	assert.deepEqual(report.checks[0].counts, { tests: 2, passed: 1, failed: 0, skipped: 1, cancelled: 0, todo: 0 });
	assert.equal(report.checks[0].outcome, "skip");
	assert.equal(report.checks[1].status, "incomplete");
	assert.equal(report.checks[1].outcome, "not-run");
});
test("timeouts, cancellation, and mutation prevent acceptance", async (t) => {
	const path = workspace(t);
	const report = await runAcceptance({ workspace: path, checks: [check("timeout", ["--eval", "setInterval(()=>{},1000)"], { timeoutMs: 60 }), check("mutate", ["--eval", 'require("node:fs").writeFileSync("artifact.txt","changed")'], { kind: "structural-check" })] });
	assert.equal(report.checks[0].termination, "timeout");
	assert.equal(report.checks[0].outcome, "blocked");
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
	// Review-1 D3 regression: PI861_REAL_* opt-ins must not be arming-able through check.env
	// in any mode (the A7 attack passed them via a suite manifest's per-check environment).
	assert.throws(
		() => parseAcceptanceConfig({ workspace: path, checks: [check("armed", ["-e", "0"], { env: { PI861_REAL_SEARCH_ACCEPTANCE: "1" } })] }),
		/Real-service authorization variables cannot be passed through acceptance configuration/,
	);
	// Review-1 D3r regression (attack A7b): Windows env lookup is case-insensitive, so a
	// lowercase spelling must be rejected exactly like the uppercase form.
	assert.throws(
		() => parseAcceptanceConfig({ workspace: path, checks: [check("armed", ["-e", "0"], { env: { pi861_real_search_acceptance: "1" } })] }),
		/Real-service authorization variables cannot be passed through acceptance configuration/,
	);
	assert.throws(
		() => parseAcceptanceConfig({ workspace: path, checks: [{ id: "armed", command: "node", args: ["-e", "0"], kind: "structural-check", reporter: "exit", env: { PI861_REAL_MODEL_BUDGET: "3" } }] }),
		/Real-service/,
	);
	await assert.rejects(runAcceptance({ workspace: path, expectedCommit: "0".repeat(40), checks: [check("x", ["--eval", "process.exit(0)"])] }), /commit/);
});
test("acceptance manifest schema rejects missing, unknown and smuggled fields", () => {
	const base = {
		version: 1,
		suite: "unit",
		workspace: join(tmpdir()),
		requiredChecks: ["c"],
		environmentNames: [],
		checks: [{ id: "c", command: "node", args: ["-e", "0"], kind: "structural-check", reporter: "exit" }],
	};
	assert.ok(parseAcceptanceManifest(base));
	for (const field of ["version", "suite", "workspace", "requiredChecks", "environmentNames", "checks"])
		assert.throws(() => parseAcceptanceManifest({ ...base, [field]: undefined }), /requires|must be|bounded|manifest/);
	assert.throws(() => parseAcceptanceManifest({ ...base, suite: "production" }), /known suite/);
	assert.throws(() => parseAcceptanceManifest({ ...base, requiredChecks: ["missing-id"] }), /not defined/);
	assert.throws(() => parseAcceptanceManifest({ ...base, environmentNames: ["PI861_REAL_SEARCH_ACCEPTANCE"] }), /Real-service/);
	// Review-1 D3r: lowercase passthrough names are rejected too (case-insensitive env lookup).
	assert.throws(() => parseAcceptanceManifest({ ...base, environmentNames: ["pi861_real_search_acceptance"] }), /Real-service/);
	assert.throws(
		() => parseAcceptanceManifest({ ...base, checks: [{ ...base.checks[0], env: { PI861_REAL_SEARCH_BUDGET: "3" } }] }),
		/Real-service authorization variables cannot be passed through acceptance configuration/,
	);
	assert.throws(() => parseAcceptanceManifest({ ...base, environmentNames: ["not a name"] }), /variable names/);
	assert.throws(() => parseAcceptanceManifest({ ...base, extra: true }), /Unknown acceptance manifest field/);
	assert.throws(() => parseAcceptanceManifest({ ...base, suite: "workers" }), /worker pair evidence/);
	const workers = parseAcceptanceManifest({ ...base, suite: "workers", workerPairEvidence: join(tmpdir(), "pair.json") });
	assert.equal(workers.suite, "workers");
});
test("single-worker or duplicate-pid evidence never validates as a worker pair", () => {
	// CI regression: drive-letter paths are not absolute on POSIX. Keep the
	// production validator strict and make the positive fixture platform-native.
	const firstWorkspace = join(tmpdir(), "pi861-worker-1");
	const secondWorkspace = join(tmpdir(), "pi861-worker-2");
	const worker = (pid, home) => ({ pid, workspace: home, startedAt: new Date().toISOString() });
	assert.equal(validateWorkerPairEvidence({ kind: "pi-worker-pair", workers: [worker(1, firstWorkspace), worker(2, secondWorkspace)] }).valid, true);
	const single = validateWorkerPairEvidence({ kind: "pi-worker-pair", workers: [worker(1, firstWorkspace)] });
	assert.equal(single.valid, false);
	assert.equal(single.workers, 1);
	assert.equal(single.reason, "fewer than two workers");
	assert.equal(validateWorkerPairEvidence({ kind: "pi-worker-pair", workers: [worker(7, firstWorkspace), worker(7, secondWorkspace)] }).valid, false);
	assert.equal(validateWorkerPairEvidence({ kind: "pi-worker-pair", workers: [worker(7, firstWorkspace), worker(8, firstWorkspace)] }).valid, false);
	assert.equal(validateWorkerPairEvidence(null).valid, false);
	assert.equal(validateWorkerPairEvidence({ kind: "other", workers: [] }).valid, false);
});
test("worker pair evidence rejects invalid records without relaxing absolute paths", () => {
	const worker = (pid, home) => ({ pid, workspace: home, startedAt: "2026-09-23T00:00:00.000Z" });
	const first = worker(4101, join(tmpdir(), "pi861-worker-1"));
	const second = worker(4102, join(tmpdir(), "pi861-worker-2"));
	for (const invalid of [
		{ ...second, workspace: "relative-worker" },
		{ ...second, workspace: "" },
		{ ...second, pid: 0 },
		{ ...second, pid: -1 },
		{ ...second, pid: 1.5 },
		{ ...second, pid: Number.MAX_SAFE_INTEGER + 1 },
		{ ...second, startedAt: null },
	]) {
		const result = validateWorkerPairEvidence({ kind: "pi-worker-pair", workers: [first, invalid] });
		assert.equal(result.valid, false);
		assert.equal(result.reason, "invalid worker record");
	}
});
test("acceptance CLI writes matching JSON and Markdown with redacted evidence", async (t) => {
	const path = workspace(t), config = join(path, "config.json"), output = join(path, "report.json"), markdown = join(path, "report.md");
	const diagnostic = '```\n<script>untrusted</script>\n# forged status';
	writeFileSync(join(path, "check.mjs"), `console.log(process.env.PRIVATE_VALUE); console.error(${JSON.stringify(diagnostic)});`);
	writeFileSync(config, JSON.stringify({ workspace: path, checks: [check("exit", ["check.mjs"], { env: { PRIVATE_VALUE: "secret-fixture-value" }, kind: "structural-check" })] }));
	const cli = fileURLToPath(new URL("../scripts/run-acceptance.mjs", import.meta.url));
	const stdout = execFileSync(process.execPath, [cli, config, output], { env: cliEnv, encoding: "utf8" });
	const report = JSON.parse(readFileSync(output, "utf8")), text = readFileSync(markdown, "utf8");
	assert.deepEqual(JSON.parse(stdout), report);
	assert.equal(report.status, "passed");
	assert.equal(report.checks[0].exitCode, 0);
	assert.ok(text.includes(report.codeSha));
	assert.ok(text.includes(report.workspaceDigest));
	assert.ok(text.includes(report.environment.node));
	assert.ok(text.includes(report.checks[0].evidence));
	assert.ok(text.includes(report.checks[0].commandDigest));
	assert.ok(text.includes(JSON.stringify([report.checks[0].command, ...report.checks[0].args], null, 2)));
	assert.ok(text.includes("PRIVATE_VALUE"));
	assert.ok(text.includes("not-performed"));
	assert.ok(text.includes("[redacted]"));
	assert.equal(text.includes("secret-fixture-value"), false);
	assert.ok(text.includes(`\`\`\`\`text\n${diagnostic}\n\n\`\`\`\``));
});

test("acceptance CLI preserves failed and skipped outcomes in both report formats", (t) => {
	const path = workspace(t), config = join(path, "config.json"), output = join(path, "report.json"), markdown = join(path, "custom-report.md");
	const cli = fileURLToPath(new URL("../scripts/run-acceptance.mjs", import.meta.url));
	for (const [name, source, status] of [["skip", 'test.skip("skip",()=>{});', "incomplete"], ["failure", 'test("failure",()=>{throw new Error("fixture");});', "failed"]]) {
		writeFileSync(join(path, "fixture.mjs"), `import {test} from "node:test"; ${source}`);
		writeFileSync(config, JSON.stringify({ workspace: path, checks: [check(name, ["--test", "--test-reporter=tap", "fixture.mjs"], { reporter: "tap" })] }));
		assert.throws(() => execFileSync(process.execPath, [cli, config, output, markdown], { env: cliEnv, stdio: "pipe" }), (error) => error.status === 1);
		const report = JSON.parse(readFileSync(output, "utf8")), text = readFileSync(markdown, "utf8");
		assert.equal(report.status, status);
		assert.equal(report.checks[0].status, status);
		assert.ok(text.includes(`Status: **${status}**`));
		assert.ok(text.includes(`Skipped: ${report.checks[0].counts.skipped}`));
		assert.ok(text.includes(`Failed: ${report.checks[0].counts.failed}`));
		assert.ok(text.includes(report.checks[0].evidence));
	}
});

test("acceptance CLI rejects colliding or relative report paths before running checks", (t) => {
	const path = workspace(t), config = join(path, "config.json"), output = join(path, "report.json");
	const source = JSON.stringify({ workspace: path, checks: [check("mutate", ["--eval", 'require("node:fs").writeFileSync("artifact.txt","changed")'], { kind: "structural-check" })] });
	writeFileSync(config, source);
	const cli = fileURLToPath(new URL("../scripts/run-acceptance.mjs", import.meta.url));
	for (const destinations of [[config], [output, output], [output, config], [output, "relative.md"]]) {
		assert.throws(() => execFileSync(process.execPath, [cli, config, ...destinations], { env: cliEnv, stdio: "pipe" }), (error) => error.status === 1);
		assert.equal(readFileSync(config, "utf8"), source);
		assert.equal(readFileSync(join(path, "artifact.txt"), "utf8"), "initial");
	}
});

// Review-1 D4 regression (attack A9): positional mode used to execute the default-closed
// real-service scripts and record the deferred run as passed; both modes now refuse them
// before any execution.
test("acceptance CLI refuses real-service scripts in positional mode before executing", (t) => {
	const path = workspace(t), config = join(path, "config.json"), output = join(path, "report.json");
	writeFileSync(config, JSON.stringify({ workspace: path, checks: [check("real", ["scripts/real-acceptance/real-search.mjs"], { kind: "structural-check" })] }));
	const cli = fileURLToPath(new URL("../scripts/run-acceptance.mjs", import.meta.url));
	assert.throws(() => execFileSync(process.execPath, [cli, config, output], { env: cliEnv, stdio: "pipe" }), (error) => {
		assert.match(String(error.stderr), /default-closed real-service scripts; positional configs cannot invoke them/);
		return error.status === 1;
	});
	assert.equal(existsSync(output), false);
	assert.equal(readFileSync(join(path, "artifact.txt"), "utf8"), "initial");
});

test("suite runner refuses missing manifests, suite mismatch and real-service scripts before executing", (t) => {
	const path = workspace(t), manifestPath = join(path, "manifest.json"), evidencePath = join(path, "evidence.json");
	writeFileSync(manifestPath, JSON.stringify({
		version: 1, suite: "local", workspace: path, requiredChecks: ["mutate"], environmentNames: [],
		checks: [{ id: "mutate", command: process.execPath, args: ["--eval", 'require("node:fs").writeFileSync("artifact.txt","changed")'], kind: "structural-check", reporter: "exit" }],
	}));
	const cli = fileURLToPath(new URL("../scripts/run-acceptance.mjs", import.meta.url));
	assert.throws(() => execFileSync(process.execPath, [cli, "--suite", "workers", "--manifest", manifestPath, "--evidence", evidencePath], { env: cliEnv, stdio: "pipe" }), (error) => {
		assert.match(String(error.stderr), /does not match requested suite/);
		return error.status === 1;
	});
	assert.equal(existsSync(evidencePath), false);
	assert.equal(readFileSync(join(path, "artifact.txt"), "utf8"), "initial");
	assert.throws(() => execFileSync(process.execPath, [cli, "--suite", "local", "--manifest", join(path, "absent.json"), "--evidence", evidencePath], { env: cliEnv, stdio: "pipe" }), (error) => error.status === 1);
	assert.equal(existsSync(evidencePath), false);
	const realServiceManifest = join(path, "real.json");
	writeFileSync(realServiceManifest, JSON.stringify({
		version: 1, suite: "local", workspace: path, requiredChecks: ["real"], environmentNames: [],
		checks: [{ id: "real", command: process.execPath, args: ["scripts/real-acceptance/real-search.mjs"], kind: "behavioral-check", reporter: "exit" }],
	}));
	assert.throws(() => execFileSync(process.execPath, [cli, "--suite", "local", "--manifest", realServiceManifest, "--evidence", evidencePath], { env: cliEnv, stdio: "pipe" }), (error) => {
		assert.match(String(error.stderr), /default-closed real-service scripts/);
		return error.status === 1;
	});
	const armedManifest = join(path, "armed.json");
	writeFileSync(armedManifest, JSON.stringify({
		version: 1, suite: "local", workspace: path, requiredChecks: ["armed"], environmentNames: [],
		checks: [{
			id: "armed", command: process.execPath, args: ["-e", "console.log(process.env.PI861_REAL_SEARCH_ACCEPTANCE ?? 'unset')"],
			kind: "structural-check", reporter: "exit", env: { PI861_REAL_SEARCH_ACCEPTANCE: "1", PI861_REAL_SEARCH_BUDGET: "3" },
		}],
	}));
	// Review-1 D3 regression (attack A7): arming PI861_REAL_* through per-check env is rejected
	// before any execution; the child process must never observe the values.
	assert.throws(() => execFileSync(process.execPath, [cli, "--suite", "local", "--manifest", armedManifest, "--evidence", evidencePath], { env: cliEnv, stdio: "pipe" }), (error) => {
		assert.match(String(error.stderr), /Real-service authorization variables cannot be passed through/);
		return error.status === 1;
	});
	// Review-1 D3r regression (attack A7b): lowercase keys smuggle nothing either.
	const armedLowerManifest = join(path, "armed-lower.json");
	writeFileSync(armedLowerManifest, JSON.stringify({
		version: 1, suite: "local", workspace: path, requiredChecks: ["armed"], environmentNames: [],
		checks: [{
			id: "armed", command: process.execPath, args: ["-e", "console.log(process.env.PI861_REAL_SEARCH_ACCEPTANCE ?? 'unset')"],
			kind: "structural-check", reporter: "exit", env: { pi861_real_search_acceptance: "1", pi861_real_search_budget: "3" },
		}],
	}));
	assert.throws(() => execFileSync(process.execPath, [cli, "--suite", "local", "--manifest", armedLowerManifest, "--evidence", evidencePath], { env: cliEnv, stdio: "pipe" }), (error) => {
		assert.match(String(error.stderr), /Real-service authorization variables cannot be passed through/);
		return error.status === 1;
	});
	assert.equal(existsSync(evidencePath), false);
	assert.equal(readFileSync(join(path, "artifact.txt"), "utf8"), "initial");
});

test("suite runner: single-worker evidence fails the workers suite; a real pair passes it", (t) => {
	const path = workspace(t), manifestPath = join(path, "manifest.json"), evidencePath = join(path, "evidence.json"), pairPath = join(path, "pair.json");
	writeFileSync(join(path, "ok.test.mjs"), 'import { test } from "node:test"; test("ok", () => {});');
	const manifest = {
		version: 1, suite: "workers", workspace: path, requiredChecks: ["behavior"], environmentNames: [], workerPairEvidence: pairPath,
		checks: [{ id: "behavior", command: process.execPath, args: ["--test", "ok.test.mjs"], kind: "behavioral-check", reporter: "exit" }],
	};
	writeFileSync(manifestPath, JSON.stringify(manifest));
	const cli = fileURLToPath(new URL("../scripts/run-acceptance.mjs", import.meta.url));
	const run = () => execFileSync(process.execPath, [cli, "--suite", "workers", "--manifest", manifestPath, "--evidence", evidencePath], { env: cliEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	writeFileSync(pairPath, JSON.stringify({ kind: "pi-worker-pair", workers: [{ pid: process.pid, workspace: path, startedAt: new Date().toISOString() }] }));
	let failure = null;
	try {
		run();
	} catch (error) {
		failure = error;
	}
	assert.ok(failure, "single-worker workers suite must exit nonzero");
	assert.equal(failure.status, 1);
	assert.ok(existsSync(evidencePath), "the failed suite run still writes evidence");
	const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
	assert.equal(evidence.status, "failed");
	assert.equal(evidence.workerPair.valid, false);
	assert.equal(evidence.workerPair.workers, 1);
	assert.equal(evidence.workerPair.reason, "fewer than two workers");
	assert.equal(evidence.acceptance.checks[0].status, "passed");
	assert.equal(evidence.requiredChecks[0].id, "behavior");
	assert.equal(evidence.requiredChecks[0].status, "passed");
	assert.ok(existsSync(`${evidencePath}.md`));
	writeFileSync(pairPath, JSON.stringify({
		kind: "pi-worker-pair",
		workers: [
			{ pid: 4101, workspace: join(path, "w1"), startedAt: "2026-09-23T00:00:00.000Z" },
			{ pid: 4102, workspace: join(path, "w2"), startedAt: "2026-09-23T00:00:01.000Z" },
		],
	}));
	const stdout = run();
	const passing = JSON.parse(stdout);
	assert.equal(passing.status, "passed");
	assert.equal(passing.workerPair.valid, true);
	assert.equal(passing.workerPair.workers, 2);
	assert.deepEqual(JSON.parse(readFileSync(evidencePath, "utf8")), passing);
});
