import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { parseWorkerServiceConfig } from "../src/live/worker-service.ts";
const exec = promisify(execFile);
const SERVICE = fileURLToPath(new URL("./../src/live/worker-service.ts", import.meta.url));
const ENTRY = fileURLToPath(new URL("./../scripts/worker-service.mjs", import.meta.url));
const TOKEN = "same-host-test-" + "x".repeat(32);
// Boundary label: this file covers unit-level config and entry behavior. Two-real-service and
// real-Pi scenarios live in worker-pair.integration.mjs (K7); isolation counter-examples and
// container mode live in worker-isolation.integration.mjs. Same-host containers, separate hosts
// and real model services are separate acceptance items and are intentionally not covered here.
function baseConfig(root) {
	return {
		id: "n1",
		capabilities: ["code"],
		roleIds: ["dev"],
		modelIds: ["fixture"],
		tokenEnv: "PI861_TEST_WORKER_TOKEN",
		repository: join(root ?? tmpdir(), "repo"),
		worktreeRoot: join(root ?? tmpdir(), "trees"),
		statePath: join(root ?? tmpdir(), "state.json"),
		process: { command: "node", args: ["w.js"] },
		checks: [{ id: "verify", command: "node", args: ["-e", "1"] }],
		maxConcurrent: 1,
	};
}
test("config parser enforces trusted absolute paths and env-named tokens", () => {
	const root = join(tmpdir(), "pi861-parse");
	const base = baseConfig(root);
	const valid = JSON.stringify(base);
	const parsed = parseWorkerServiceConfig(valid, { PI861_TEST_WORKER_TOKEN: TOKEN });
	assert.equal(parsed.id, "n1");
	assert.equal(parsed.process.waitForSettled, false);
	assert.deepEqual(parsed.isolation, { mode: "trusted-local" });
	assert.throws(() => parseWorkerServiceConfig(valid, {}), /environment variable/);
	for (const field of ["repository", "worktreeRoot", "statePath"]) {
		const bad = { ...base, [field]: "relative/path" };
		assert.throws(
			() => parseWorkerServiceConfig(JSON.stringify(bad), { PI861_TEST_WORKER_TOKEN: TOKEN }),
			/absolute/,
		);
	}
	const noChecks = { ...base };
	delete noChecks.checks;
	assert.throws(
		() => parseWorkerServiceConfig(JSON.stringify(noChecks), { PI861_TEST_WORKER_TOKEN: TOKEN }),
		/check/,
	);
});
test("isolation config: trusted-local is explicit and container mode is strictly validated", () => {
	const base = baseConfig(join(tmpdir(), "pi861-iso"));
	const env = { PI861_TEST_WORKER_TOKEN: TOKEN };
	const container = (patch) =>
		parseWorkerServiceConfig(
			JSON.stringify({ ...base, isolation: { mode: "container", container: patch } }),
			env,
		).isolation.container;
	// Honest defaults: non-root, network denied, resource limits present.
	const parsed = container({ image: "node:22-alpine", mounts: [], envAllowlist: [] });
	assert.equal(parsed.userId, "1000:1000");
	assert.equal(parsed.network, "none");
	assert.equal(parsed.memoryBytes, 536_870_912);
	assert.equal(parsed.pidsLimit, 64);
	// Negatives: root user, approved network, token env leak, credential mount, overlapping mount.
	assert.throws(() => container({ image: "x", userId: "0:0" }), /not run as root/);
	assert.throws(() => container({ image: "x", network: "bridge" }), /network must be "none"/);
	assert.throws(
		() => container({ image: "x", envAllowlist: ["PI861_TEST_WORKER_TOKEN"] }),
		/bearer token/,
	);
	assert.throws(
		() => container({ image: "x", mounts: [{ host: "/home/u/.ssh", container: "/ssh" }] }),
		/credential/,
	);
	assert.throws(
		() => container({ image: "x", mounts: [{ host: "/data", container: "/workspace/pkg" }] }),
		/workspace/,
	);
	assert.throws(
		() => container({ image: "x", mounts: [{ host: "/data", container: "/run/docker.sock" }] }),
		/socket|Forbidden/,
	);
	assert.throws(
		() => parseWorkerServiceConfig(JSON.stringify({ ...base, isolation: { mode: "weird" } }), env),
		/isolation.mode/,
	);
	assert.throws(
		() =>
			parseWorkerServiceConfig(
				JSON.stringify({
					...base,
					isolation: { mode: "trusted-local", container: { image: "x" } },
				}),
				env,
			),
		/must not configure a container/,
	);
});
async function sourceRepo(root) {
	const source = join(root, "source");
	await mkdir(source);
	await exec("git", ["init", source]);
	await writeFile(join(source, "README"), "fixture");
	await exec("git", ["add", "README"], { cwd: source });
	await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"], {
		cwd: source,
	});
	return source;
}
async function startWorker(root, name, source) {
	const repoPath = join(root, `clone-${name}`);
	await exec("git", ["clone", source, repoPath]);
	const configPath = join(root, `worker-${name}.json`);
	await writeFile(
		configPath,
		JSON.stringify({
			id: `node-${name}`,
			capabilities: [],
			roleIds: ["dev"],
			modelIds: ["fixture"],
			tokenEnv: "PI861_TEST_WORKER_TOKEN",
			repository: repoPath,
			worktreeRoot: join(root, `trees-${name}`),
			statePath: join(root, `state-${name}.json`),
			process: { command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] },
			checks: [{ id: "verify", command: "node", args: ["-e", "1"] }],
			maxConcurrent: 1,
		}),
	);
	const child = spawn(process.execPath, [ENTRY, configPath], {
		env: { ...process.env, PI861_TEST_WORKER_TOKEN: TOKEN },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let buffer = "";
	for (let i = 0; i < 300; i++) {
		const chunk = child.stdout.read();
		if (chunk) buffer += chunk;
		const line = buffer.split("\n").find((item) => item.includes("worker-listening"));
		if (line) return { child, url: JSON.parse(line).url, configPath };
		await setTimeout(20);
	}
	child.kill();
	throw new Error(`worker ${name} did not announce its URL`);
}
test("production entry starts and honestly reports trusted-local isolation (no OS sandbox)", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-entry-"));
	const children = [];
	try {
		const source = await sourceRepo(root);
		const w1 = await startWorker(root, "entry", source);
		children.push(w1.child);
		const status = await (await fetch(`${w1.url}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
		assert.equal(status.id, "node-entry");
		assert.equal(status.isolation.mode, "trusted-local");
		assert.equal(status.isolation.osSandbox, false);
		assert.equal((await fetch(`${w1.url}/status`)).status, 401);
		// Convergent shutdown over HTTP (the operator path that works on Windows too).
		assert.equal(
			(
				await fetch(`${w1.url}/shutdown`, { method: "POST", headers: { Authorization: `Bearer ${TOKEN}` } })
			).status,
			202,
		);
		const [exit] = await Promise.race([once(w1.child, "exit"), setTimeout(5000).then(() => [null])]);
		assert.notEqual(exit, null, "worker must exit within the shutdown budget");
		assert.equal(w1.child.exitCode, 0);
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	}
});
test("SIGTERM handler converges on POSIX (skipped on Windows: uncatchable there)", async () => {
	if (platform() === "win32") return; // Windows cannot deliver a catchable SIGTERM; POST /shutdown is the operator path.
	const root = await mkdtemp(join(tmpdir(), "pi861-sigterm-"));
	const children = [];
	try {
		const source = await sourceRepo(root);
		const w1 = await startWorker(root, "sig", source);
		children.push(w1.child);
		w1.child.kill("SIGTERM");
		const [exit] = await Promise.race([once(w1.child, "exit"), setTimeout(5000).then(() => [null])]);
		assert.notEqual(exit, null);
		assert.equal(w1.child.exitCode, 0);
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
		await rm(root, { recursive: true, force: true });
	}
});
