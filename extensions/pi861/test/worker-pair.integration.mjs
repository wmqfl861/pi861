import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RemoteWorkerClient } from "../src/live/remote-worker.ts";
import { Workspaces } from "../src/live/workspace.ts";

const exec = promisify(execFile);
const ENTRY = fileURLToPath(new URL("./../scripts/worker-service.mjs", import.meta.url));
const NATIVE_PROVIDER = fileURLToPath(new URL("./fixtures/native-provider.mjs", import.meta.url));
const RUNTIME = fileURLToPath(new URL("./../runtime.ts", import.meta.url));
const DEFAULT_CLI = "C:\\Albert\\pi861-host\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js";
const TOKEN = "pair-integration-" + "x".repeat(32);

// K7 positive case (continuation plan section 7): two REAL worker-service entries, each with an
// independent absolute-path config, auth token, port, agent data directory and Git checkout, driving
// a REAL published Pi host (deterministic local provider - real process, no real model service).
// Same-host container isolation and cross-host scenarios live in worker-isolation.integration.mjs
// and stay separately reported; this file never claims cross-host coverage.
function resolveCli() {
	const cli = process.env.PI861_TEST_PI_CLI ?? (existsSync(DEFAULT_CLI) ? DEFAULT_CLI : "");
	if (!cli) throw new Error("K7 requires a real Pi CLI: set PI861_TEST_PI_CLI to an absolute CLI path");
	return cli;
}
function launchPrefix() {
	const raw = process.env.PI861_TEST_PI_LAUNCH_PREFIX;
	if (!raw) return [];
	const parsed = JSON.parse(raw);
	if (!Array.isArray(parsed) || parsed.some((part) => typeof part !== "string"))
		throw new Error("PI861_TEST_PI_LAUNCH_PREFIX must be a JSON array of strings");
	return parsed;
}
async function sourceRepo(root) {
	const source = join(root, "source");
	await mkdir(source);
	await exec("git", ["init", source]);
	await writeFile(join(source, "README"), "pair fixture");
	await exec("git", ["add", "README"], { cwd: source });
	await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"], {
		cwd: source,
	});
	return source;
}
function piConfig(projectId, stateDirectory) {
	return {
		version: 2,
		projectId,
		stateDirectory,
		role: { id: "developer", skillIds: [], grants: [] },
		models: {
			targets: [
				{
					id: "cheap",
					revision: "1",
					provider: "pi861-fixture",
					model: "cheap",
					quality: 1,
					costRank: 1,
					contextWindow: 200000,
					capabilities: ["tools"],
					enabled: true,
				},
				{
					id: "strong",
					revision: "1",
					provider: "pi861-fixture",
					model: "strong",
					quality: 3,
					costRank: 3,
					contextWindow: 200000,
					capabilities: ["tools"],
					enabled: true,
				},
			],
			preferred: "cheap",
			intakeId: "cheap",
			enableRouting: false,
			requirements: { minQuality: 1, contextTokens: 100, capabilities: ["tools"], allowedIds: ["cheap", "strong"] },
			recovery: {
				failoverEnabled: true,
				failbackEnabled: false,
				probeIntervalMs: 100,
				maxProbeIntervalMs: 1000,
				requiredProbeSuccesses: 2,
			},
			maxAttempts: 2,
			requestTimeoutMs: 20000,
			maxRequests: 20,
			maxProbeRequests: 2,
		},
		memory: { autoRecall: true, autoCapture: true, autoEnrich: false, modelId: "strong" },
		budget: { maxRequests: 50 },
	};
}
/** Starts one REAL worker-service production entry with an independent checkout and Pi agent dir. */
async function startWorker(root, name, source, cli) {
	const repoPath = join(root, `clone-${name}`);
	await exec("git", ["clone", source, repoPath]);
	const home = join(root, `home-${name}`);
	const state = join(root, `pi-state-${name}`);
	await mkdir(join(home, ".pi", "agent"), { recursive: true });
	await mkdir(state);
	const configFile = join(root, `pi-config-${name}.json`);
	await writeFile(configFile, JSON.stringify(piConfig(`pair-${name}`, state)));
	const configPath = join(root, `worker-${name}.json`);
	await writeFile(
		configPath,
		JSON.stringify({
			id: `node-${name}`,
			capabilities: [],
			roleIds: ["dev"],
			modelIds: ["cheap", "strong"],
			tokenEnv: "PI861_TEST_WORKER_TOKEN",
			repository: repoPath,
			worktreeRoot: join(root, `trees-${name}`),
			statePath: join(root, `service-state-${name}.json`),
			process: {
				command: process.execPath,
				args: [
					...launchPrefix(),
					cli,
					"--mode",
					"rpc",
					"--no-extensions",
					"--no-skills",
					"-e",
					NATIVE_PROVIDER,
					"-e",
					RUNTIME,
				],
				env: {
					HOME: home,
					USERPROFILE: home,
					PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
					PI861_CONFIG: configFile,
					NO_COLOR: "1",
				},
				waitForSettled: true,
				rpcTimeoutMs: 30_000,
			},
			checks: [
				{
					id: "verify",
					command: process.execPath,
					args: ["-e", "if(!require('fs').existsSync('fixture.txt'))process.exit(1)"],
				},
			],
			maxConcurrent: 1,
		}),
	);
	const child = spawn(process.execPath, [ENTRY, configPath], {
		env: { ...process.env, PI861_TEST_WORKER_TOKEN: TOKEN },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let buffer = "";
	for (let i = 0; i < 600; i++) {
		const chunk = child.stdout.read();
		if (chunk) buffer += chunk;
		const line = buffer.split("\n").find((item) => item.includes("worker-listening"));
		if (line) {
			const announcement = JSON.parse(line);
			assert.equal(announcement.isolation.mode, "trusted-local");
			assert.equal(announcement.isolation.osSandbox, false);
			return { child, url: announcement.url, configPath, repoPath, home, pid: child.pid };
		}
		await setTimeout(50);
	}
	child.kill("SIGKILL");
	throw new Error(`worker ${name} did not announce its URL`);
}
const jobInput = (task, identity) => ({
	version: 1,
	identity,
	task: {
		id: task,
		title: task,
		status: "running",
		attempts: 1,
		dependsOn: [],
		writeScopes: ["fixture.txt"],
		capabilities: [],
		acceptance: ["fixture.txt exists with real Pi output"],
		artifacts: [],
		evidence: [],
		leaseUntil: Date.now() + 300_000,
		lease: { taskId: task, workerId: `node-${task === "A" ? "one" : "two"}`, token: `lease-${task}`, attempt: 1 },
	},
	execution: {
		instructions: "fixture-write: write fixture.txt once using the write tool",
		roleId: "dev",
		modelId: "cheap",
		checkIds: ["verify"],
	},
});

test(
	"K7 pair: two real worker services run real Pi, independent checkouts, verified artifact transport",
	{ timeout: Number(process.env.PI861_TEST_TIMEOUT_MS ?? 240_000) },
	async () => {
		const cli = resolveCli();
		const version = (await exec(process.execPath, [cli, "--version"])).stdout.trim();
		console.log(`# K7 real Pi CLI: ${cli}`);
		console.log(`# K7 real Pi version: ${version}`);
		const root = await mkdtemp(join(tmpdir(), "pi861-worker-pair-"));
		const children = [];
		try {
			const source = await sourceRepo(root);
			const one = await startWorker(root, "one", source, cli);
			const two = await startWorker(root, "two", source, cli);
			children.push(one.child, two.child);
			console.log(`# K7 worker-one pid=${one.pid} url=${one.url} repo=${one.repoPath}`);
			console.log(`# K7 worker-two pid=${two.pid} url=${two.url} repo=${two.repoPath}`);
			const statusOne = await (await fetch(`${one.url}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
			const statusTwo = await (await fetch(`${two.url}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
			assert.equal(statusOne.id, "node-one");
			assert.equal(statusTwo.id, "node-two");
			assert.notEqual(one.url, two.url);
			assert.equal(statusOne.isolation.mode, "trusted-local");
			assert.equal(statusOne.isolation.osSandbox, false); // honest: same-host, no OS sandbox claim
			// Two independent dispatches in parallel, one per real service.
			const clientOne = new RemoteWorkerClient({ url: one.url, token: TOKEN, allowLoopbackHttp: true, pollMs: 100 });
			const clientTwo = new RemoteWorkerClient({ url: two.url, token: TOKEN, allowLoopbackHttp: true, pollMs: 100 });
			const controller = new Workspaces(source, join(root, "controller-trees"));
			const base = await controller.head();
			const baseBundle = await controller.exportCommit(base);
			const [candidateA, candidateB] = await Promise.all([
				clientOne.run(
					{ ...jobInput("A", { tenantId: "pair", projectId: "pair", goalId: "g1", runId: "r1", taskId: "A", attempt: 1 }), baseCommit: base, baseBundle },
					AbortSignal.timeout(180_000),
				),
				clientTwo.run(
					{ ...jobInput("B", { tenantId: "pair", projectId: "pair", goalId: "g1", runId: "r1", taskId: "B", attempt: 1 }), baseCommit: base, baseBundle },
					AbortSignal.timeout(180_000),
				),
			]);
			for (const candidate of [candidateA, candidateB]) {
				assert.match(candidate.commit, /^[a-f0-9]{40}$/);
				assert.ok(candidate.bundle.sha256.length === 64 && candidate.bundle.data.length > 0);
				assert.ok(candidate.evidence.some((line) => line.startsWith("check:verify:passed:sha256:")));
				assert.ok(candidate.text.length > 0, "real Pi must return assistant text");
			}
			console.log(`# K7 candidate A commit=${candidateA.commit.slice(0, 12)} bundle sha256=${candidateA.bundle.sha256.slice(0, 16)}...`);
			console.log(`# K7 candidate B commit=${candidateB.commit.slice(0, 12)} bundle sha256=${candidateB.bundle.sha256.slice(0, 16)}...`);
			// Controller-side transport verification: digest check happens inside importCommit.
			await controller.importCommit(candidateA.bundle, candidateA.commit);
			await controller.importCommit(candidateB.bundle, candidateB.commit);
			const inspectA = await controller.create("inspect-A", 1, candidateA.commit);
			const inspectB = await controller.create("inspect-B", 1, candidateB.commit);
			assert.equal(await readFile(join(inspectA.path, "fixture.txt"), "utf8"), "written through real Pi");
			assert.equal(await readFile(join(inspectB.path, "fixture.txt"), "utf8"), "written through real Pi");
			// Sequential integration into a dedicated worktree; the user checkout stays untouched.
			const integration = await controller.create("integration", 1, base);
			await controller.assertBase(integration, base);
			await controller.integrate(integration, candidateA.commit, AbortSignal.timeout(30_000));
			const afterA = (
				await exec("git", ["rev-parse", "HEAD"], { cwd: integration.path })
			).stdout.trim();
			await controller.integrate(integration, candidateB.commit, AbortSignal.timeout(30_000));
			assert.equal(await readFile(join(integration.path, "fixture.txt"), "utf8"), "written through real Pi");
			assert.notEqual(afterA, base);
			assert.equal(await controller.head(), base, "controller main checkout must remain unchanged");
			// Corrupted bundle transport is rejected on the controller side (digest + scope).
			const corrupt = { data: candidateA.bundle.data.slice(0, -8) + "AAAAAAAA", sha256: candidateA.bundle.sha256 };
			await assert.rejects(() => controller.importCommit(corrupt, candidateA.commit), /checksum/);
			// Convergent shutdown of both services; PIDs and exit codes recorded for review.
			for (const worker of [one, two]) {
				assert.equal(
					(
						await fetch(`${worker.url}/shutdown`, {
							method: "POST",
							headers: { Authorization: `Bearer ${TOKEN}` },
						})
					).status,
					202,
				);
				const [exit] = await Promise.race([onceExit(worker.child), setTimeout(10_000).then(() => [null])]);
				assert.notEqual(exit, null, `worker pid=${worker.pid} must exit within the shutdown budget`);
				assert.equal(worker.child.exitCode, 0);
				console.log(`# K7 worker ${worker.url} pid=${worker.pid} exited code=0`);
			}
		} finally {
			for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
			await rm(root, { recursive: true, force: true }).catch(() => {});
		}
	},
);
function onceExit(child) {
	return new Promise((resolve) => child.once("exit", (code) => resolve([code])));
}
