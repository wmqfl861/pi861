import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { FileStateStore } from "../src/live/store.ts";
import { RemoteWorkerServer, RemoteWorkerClient } from "../src/live/remote-worker.ts";
import { Workspaces } from "../src/live/workspace.ts";
import { PiRpcSession } from "../src/live/pi-rpc.ts";
import { probeContainerRuntime } from "../src/live/container-exec.ts";
import { parseWorkerServiceConfig, runWorkerService } from "../src/live/worker-service.ts";

const exec = promisify(execFile);
const ENTRY = fileURLToPath(new URL("./../scripts/worker-service.mjs", import.meta.url));
const FIXTURES = dirname(fileURLToPath(new URL("./fixtures/pi-worker.mjs", import.meta.url)));
const TOKEN = "isolation-test-" + "x".repeat(32);
const CONTAINER_IMAGE = process.env.PI861_TEST_CONTAINER_IMAGE ?? "docker.1ms.run/library/node:22-alpine";
// K7 counter-examples (continuation plan section 7). Every case here must actually execute; skips
// are never counted as passes. When the OCI environment is genuinely unavailable the container
// tests FAIL with an explicit "R3.8 blocked" message so the gap stays visible instead of silent.

async function sourceRepo(root) {
	const source = join(root, "source");
	await mkdir(source);
	await exec("git", ["init", source]);
	await writeFile(join(source, "README"), "isolation fixture");
	await exec("git", ["add", "README"], { cwd: source });
	await exec("git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-m", "base"], {
		cwd: source,
	});
	return source;
}
const identity = (taskId, patch = {}) => ({
	tenantId: "iso-tenant",
	projectId: "iso-project",
	goalId: "iso-goal",
	runId: "iso-run",
	taskId,
	attempt: 1,
	...patch,
});
const runningTask = (taskId, patch = {}) => ({
	id: taskId,
	title: taskId,
	status: "running",
	attempts: 1,
	dependsOn: [],
	writeScopes: ["a.txt"],
	capabilities: [],
	acceptance: ["a.txt exists"],
	artifacts: [],
	evidence: [],
	leaseUntil: Date.now() + 300_000,
	lease: { taskId, workerId: "node-iso", token: `lease-${taskId}`, attempt: 1 },
	...patch,
});
const execution = (patch = {}) => ({
	instructions: `implement ${"A"}`,
	roleId: "dev",
	modelId: "fixture",
	checkIds: ["verify"],
	...patch,
});
async function postJson(url, path, value, token = TOKEN) {
	return fetch(`${url}${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: JSON.stringify(value),
	});
}
/** Direct POSTs carry the same stable 64-hex id the RemoteWorkerClient derives, so idempotent
 * re-submission after a restart reconciles instead of duplicating the job. */
function withJobId(job) {
	const id = createHash("sha256")
		.update(JSON.stringify({ identity: job.identity, lease: job.task.lease, baseCommit: job.baseCommit }))
		.digest("hex");
	return { ...job, id };
}

test("K7 negatives: forged identity, stale lease and wrong token are rejected", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-iso-neg-"));
	let server;
	try {
		const source = await sourceRepo(root);
		const remote = join(root, "node");
		await exec("git", ["clone", source, remote]);
		const remoteWs = new Workspaces(remote, join(root, "remote-trees"));
		const base = await remoteWs.head();
		const check = {
			id: "verify",
			command: process.execPath,
			args: ["-e", "if(!require('fs').existsSync('a.txt'))process.exit(1)"],
		};
		server = new RemoteWorkerServer(new FileStateStore(join(root, "state.json"), { jobs: [] }), {
			identity: { id: "node-iso", capabilities: [], roleIds: ["dev"], modelIds: ["fixture"] },
			token: TOKEN,
			workspaces: remoteWs,
			maxConcurrent: 1,
			checks: [check],
			process: (workspace) => ({
				command: process.execPath,
				args: [join(FIXTURES, "pi-worker.mjs")],
				cwd: workspace.path,
			}),
		});
		const url = await server.listen();
		const baseBundle = await remoteWs.exportCommit(base);
		const valid = {
			version: 1,
			identity: identity("A"),
			task: runningTask("A"),
			execution: execution(),
			baseCommit: base,
			baseBundle,
		};
		// Wrong or missing bearer token: 401, never processed.
		assert.equal((await fetch(`${url}/status`)).status, 401);
		assert.equal((await postJson(url, "/jobs", valid, "wrong-token-" + "y".repeat(32))).status, 401);
		// Forged identity: taskId must match the task, and parts must be slug-like.
		for (const patch of [
			{ taskId: "B" },
			{ tenantId: "../evil" },
			{ attempt: 2 },
			{ goalId: "" },
		]) {
			const response = await postJson(url, "/jobs", { ...valid, identity: identity("A", patch) });
			assert.equal(response.status, 400, `forged identity ${JSON.stringify(patch)} must be rejected`);
		}
		// Forged capability binding: worker never accepts roles/models/checks/capabilities outside config.
		for (const patch of [
			{ task: runningTask("A", { capabilities: ["root"] }) },
			{ task: runningTask("A", { lease: { taskId: "A", workerId: "node-other", token: "x", attempt: 1 } }) },
			{ execution: execution({ roleId: "admin" }) },
			{ execution: execution({ modelId: "gpt-real" }) },
			{ execution: execution({ checkIds: ["sudo"] }) },
		]) {
			const response = await postJson(url, "/jobs", { ...valid, ...patch });
			assert.equal(response.status, 400, `forged capability ${JSON.stringify(patch)} must be rejected`);
		}
		// Stale lease: lease.attempt must equal the task attempt counter.
		const stale = {
			...valid,
			task: runningTask("A", { attempts: 2, lease: { taskId: "A", workerId: "node-iso", token: "l", attempt: 1 } }),
		};
		assert.equal((await postJson(url, "/jobs", stale)).status, 400);
		// A short token can never even start a server.
		assert.throws(
			() =>
				new RemoteWorkerServer(new FileStateStore(join(root, "s2.json"), { jobs: [] }), {
					identity: { id: "n", capabilities: [], roleIds: ["dev"], modelIds: ["fixture"] },
					token: "short",
					workspaces: remoteWs,
					maxConcurrent: 1,
					checks: [check],
					process: (w) => ({ command: "node", args: ["-e", ""], cwd: w.path }),
				}),
			/Strong bearer token/,
		);
		// Nothing was accepted: capacity untouched, no job state.
		const status = await (await fetch(`${url}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
		assert.equal(status.inFlight, 0);
	} finally {
		await server?.close();
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

test("K7 negative: out-of-scope diff is rejected and never produces a candidate", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-iso-scope-"));
	let server;
	try {
		const source = await sourceRepo(root);
		const remote = join(root, "node");
		await exec("git", ["clone", source, remote]);
		const remoteWs = new Workspaces(remote, join(root, "remote-trees"));
		const base = await remoteWs.head();
		const check = { id: "verify", command: process.execPath, args: ["-e", "process.exit(0)"] };
		server = new RemoteWorkerServer(new FileStateStore(join(root, "state.json"), { jobs: [] }), {
			identity: { id: "node-iso", capabilities: [], roleIds: ["dev"], modelIds: ["fixture"] },
			token: TOKEN,
			workspaces: remoteWs,
			maxConcurrent: 1,
			checks: [check],
			process: (workspace) => ({
				command: process.execPath,
				args: [join(FIXTURES, "pi-worker.mjs")],
				cwd: workspace.path,
			}),
		});
		const url = await server.listen();
		const client = new RemoteWorkerClient({ url, token: TOKEN, allowLoopbackHttp: true, pollMs: 50 });
		// Task Z writes z.txt, but the reservation only covers a.txt: the change must be refused.
		const zBundle = await remoteWs.exportCommit(base);
		await assert.rejects(
			() =>
				client.run(
					{
						version: 1,
						identity: identity("Z"),
						task: runningTask("Z", { title: "Z", writeScopes: ["a.txt"] }),
						execution: execution({ instructions: "implement Z" }),
						baseCommit: base,
						baseBundle: zBundle,
					},
					AbortSignal.timeout(30_000),
				),
			/requires reconciliation|failed/,
		);
		const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
		const job = state.jobs.find((entry) => entry.state === "failed" || entry.state === "unknown");
		assert.ok(job, "out-of-scope task must not be reported done");
		assert.equal(job.result, undefined);
		assert.equal(await remoteWs.head(), base, "worker repository must remain unchanged");
	} finally {
		await server?.close();
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

test("K7 negative: capacity exhausted and heartbeat-loss detection", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-iso-cap-"));
	let server;
	try {
		const source = await sourceRepo(root);
		const remote = join(root, "node");
		await exec("git", ["clone", source, remote]);
		const remoteWs = new Workspaces(remote, join(root, "remote-trees"));
		const base = await remoteWs.head();
		const check = { id: "verify", command: process.execPath, args: ["-e", "process.exit(0)"] };
		await mkdir(join(root, "marks"), { recursive: true });
		server = new RemoteWorkerServer(new FileStateStore(join(root, "state.json"), { jobs: [] }), {
			identity: { id: "node-iso", capabilities: [], roleIds: ["dev"], modelIds: ["fixture"] },
			token: TOKEN,
			workspaces: remoteWs,
			maxConcurrent: 1,
			checks: [check],
			process: (workspace) => ({
				command: process.execPath,
				args: [join(FIXTURES, "pi-worker.mjs")],
				cwd: workspace.path,
				env: { PI861_FIXTURE_DELAY_ONCE: "B:8000", PI861_FIXTURE_MARKDIR: join(root, "marks") },
			}),
		});
		const url = await server.listen();
		const baseBundle = await remoteWs.exportCommit(base);
		// Occupy the single slot with a slow task, then a second dispatch must be refused.
		// The fixture's first-attempt delay keeps the first job durably in "running".
		const slow = {
			version: 1,
			identity: identity("B"),
			task: runningTask("B", { title: "B", writeScopes: ["b.txt"] }),
			execution: execution({ instructions: "implement B" }),
			baseCommit: base,
			baseBundle,
		};
		assert.equal((await postJson(url, "/jobs", withJobId(slow))).status, 202);
		let occupied = false;
		for (let i = 0; i < 300; i++) {
			const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
			if (state.jobs.some((entry) => entry.state === "running")) {
				occupied = true;
				break;
			}
			await setTimeout(20);
		}
		assert.equal(occupied, true, "slow task must occupy the single capacity slot");
		const second = {
			version: 1,
			identity: identity("C"),
			task: runningTask("C", { title: "C", writeScopes: ["c.txt"] }),
			execution: execution({ instructions: "implement C" }),
			baseCommit: base,
			baseBundle,
		};
		const response = await postJson(url, "/jobs", second);
		assert.equal(response.status, 400, "capacity exhaustion must refuse new work");
		// Heartbeat loss (R3.13): consecutive transport failures mark the node presumed-lost;
		// the cooldown gates reassignment instead of hammering a dead node.
		const dead = new RemoteWorkerClient({
			url: "http://127.0.0.1:9",
			token: TOKEN,
			allowLoopbackHttp: true,
			pollMs: 10,
			unavailableAfter: 2,
			unavailableCooldownMs: 400,
		});
		assert.equal(dead.available(), true);
		await assert.rejects(() => dead.run(second, AbortSignal.timeout(5000)));
		await assert.rejects(() => dead.run(second, AbortSignal.timeout(5000)));
		assert.equal(dead.available(), false, "two consecutive transport failures must mark the node unavailable");
		await setTimeout(450);
		assert.equal(dead.available(), true, "cooldown expiry reopens probing");
	} finally {
		await server?.close();
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

test("K7 negative: killed worker never fabricates done; restart marks unfinished work unknown", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-iso-kill-"));
	const children = [];
	try {
		const source = await sourceRepo(root);
		const repoPath = join(root, "clone");
		await exec("git", ["clone", source, repoPath]);
		const configPath = join(root, "worker.json");
		await mkdir(join(root, "marks"), { recursive: true });
		await writeFile(
			configPath,
			JSON.stringify({
				id: "node-kill",
				capabilities: [],
				roleIds: ["dev"],
				modelIds: ["fixture"],
				tokenEnv: "PI861_TEST_WORKER_TOKEN",
				repository: repoPath,
				worktreeRoot: join(root, "trees"),
				statePath: join(root, "state.json"),
				process: {
					command: process.execPath,
					args: [join(FIXTURES, "pi-worker.mjs")],
					env: { PI861_FIXTURE_DELAY_ONCE: "B:8000", PI861_FIXTURE_MARKDIR: join(root, "marks") },
				},
				checks: [{ id: "verify", command: process.execPath, args: ["-e", "process.exit(0)"] }],
				maxConcurrent: 1,
			}),
		);
		const start = async () => {
			const child = spawn(process.execPath, [ENTRY, configPath], {
				env: { ...process.env, PI861_TEST_WORKER_TOKEN: TOKEN },
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.push(child);
			let buffer = "";
			for (let i = 0; i < 300; i++) {
				const chunk = child.stdout.read();
				if (chunk) buffer += chunk;
				const line = buffer.split("\n").find((item) => item.includes("worker-listening"));
				if (line) return { child, url: JSON.parse(line).url };
				await setTimeout(20);
			}
			throw new Error("worker did not announce its URL");
		};
		const first = await start();
		const remoteWs = new Workspaces(repoPath, join(root, "controller-trees"));
		const base = await remoteWs.head();
		const job = {
			version: 1,
			identity: identity("B"),
			task: runningTask("B", {
				title: "B",
				writeScopes: ["b.txt"],
				lease: { taskId: "B", workerId: "node-kill", token: "lease-B", attempt: 1 },
			}),
			execution: execution({ instructions: "implement B" }),
			baseCommit: base,
			baseBundle: await remoteWs.exportCommit(base),
		};
		assert.equal((await postJson(first.url, "/jobs", withJobId(job))).status, 202);
		// Wait until the job is durably running, then hard-kill the service.
		for (let i = 0; i < 300; i++) {
			const state = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
			if (state.jobs.some((entry) => entry.state === "running")) break;
			await setTimeout(20);
		}
		first.child.kill("SIGKILL");
		await once(first.child, "exit").catch(() => {});
		const killed = JSON.parse(readFileSync(join(root, "state.json"), "utf8"));
		assert.ok(killed.jobs.some((entry) => entry.state !== "done"), "durable state must not show fabricated done");
		// Restart with the same state: unfinished work converges to unknown, never replayed.
		const second = await start();
		const status = await (await fetch(`${second.url}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json();
		assert.equal(status.jobs.unknown >= 1, true);
		const resubmit = await postJson(second.url, "/jobs", withJobId(job));
		if (resubmit.status !== 202)
			console.log(`# K7 restart resubmit body: ${await resubmit.text()}`);
		assert.equal(resubmit.status, 202);
		assert.equal((await resubmit.json()).state, "unknown");
	} finally {
		for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

test("K7 negative: git index still locked or diverged base blocks integration handover", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-iso-git-"));
	try {
		const source = await sourceRepo(root);
		const ws = new Workspaces(source, join(root, "trees"));
		const base = await ws.head();
		const integration = await ws.create("integrate", 1, base);
		// Simulate an old git process still holding the index: handover must refuse, not merge.
		const lockPath = (
			await exec("git", ["rev-parse", "--git-path", "index.lock"], { cwd: integration.path })
		).stdout.trim();
		const lock = isAbsolute(lockPath) ? lockPath : join(integration.path, lockPath);
		await mkdir(dirname(lock), { recursive: true });
		await writeFile(lock, "stale lock");
		await assert.rejects(
			() => ws.withIntegrationLock(integration, AbortSignal.timeout(2000), async () => "merged"),
			/Git index remains locked/,
		);
		await rm(lock, { force: true });
		// The lock cleared, handover proceeds; a diverged base is still refused.
		assert.equal(
			await ws.withIntegrationLock(integration, AbortSignal.timeout(10_000), async () => "merged"),
			"merged",
		);
		await writeFile(join(integration.path, "README"), "dirty divergence");
		await assert.rejects(() => ws.assertBase(integration, base), /diverged/);
	} finally {
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

test("K7 negative: rpcTimeoutMs is actually enforced against a slow child", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-iso-rpc-"));
	let session;
	let healthy;
	try {
		const slowResponder = [
			"let buf='';",
			"process.stdin.on('data',c=>{buf+=c;",
			"while(buf.includes('\\n')){const i=buf.indexOf('\\n');const line=buf.slice(0,i);buf=buf.slice(i+1);",
			"if(!line.trim())continue;const r=JSON.parse(line);",
			"setTimeout(()=>process.stdout.write(JSON.stringify({type:'response',id:r.id,success:true,data:{}})+'\\n'),600);}});",
		].join("");
		session = new PiRpcSession(
			{ command: process.execPath, args: ["-e", slowResponder], cwd: root },
			{ rpcTimeoutMs: 100 },
		);
		await assert.rejects(() => session.command("get_state", {}, AbortSignal.timeout(5000)));
		await session.close();
		session = undefined;
		// The same child under a generous timeout answers, proving the deadline is the differentiator.
		healthy = new PiRpcSession(
			{ command: process.execPath, args: ["-e", slowResponder], cwd: root },
			{ rpcTimeoutMs: 5000 },
		);
		assert.equal(typeof (await healthy.command("get_state", {}, AbortSignal.timeout(10_000))), "object");
	} finally {
		await session?.close().catch(() => {});
		await healthy?.close().catch(() => {});
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});

/** Inline container probe: speaks the minimal RPC protocol after checking isolation invariants. */
const PROBE_CODE = [
	"const fs=require('fs'),net=require('net');",
	"const report={uid:process.getuid?process.getuid():null};",
	"try{fs.readFileSync('/host-credentials/secret-token.txt');report.hostSecret='READABLE';}catch(e){report.hostSecret=String((e&&e.code)||e);}",
	"try{fs.writeFileSync('/etc/pi861-probe','x');report.rootfs='WROTE-ROOT';}catch(e){report.rootfs=String((e&&e.code)||e);}",
	"try{fs.writeFileSync('/tmp/pi861-probe','x');fs.unlinkSync('/tmp/pi861-probe');report.tmp='ok';}catch(e){report.tmp=String((e&&e.code)||e);}",
	"const finish=n=>{report.net=n;try{fs.writeFileSync('probe.json',JSON.stringify(report));}catch(e){}",
	" const lines=[],box={v:''};const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');",
	" const pump=()=>{while(lines.length){const line=lines.shift();if(!line.trim())continue;let r;try{r=JSON.parse(line);}catch{continue;}",
	"  out({type:'response',id:r.id,command:r.type,success:true});",
	"  if(r.type==='prompt')setTimeout(()=>{out({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'probe complete'}],stopReason:'stop',usage:{input:1,output:1}}});out({type:'agent_end',messages:[{role:'assistant',stopReason:'stop'}]});},100);}};",
	" process.stdin.on('data',c=>{box.v+=c;while(box.v.includes('\\n')){const i=box.v.indexOf('\\n');lines.push(box.v.slice(0,i));box.v=box.v.slice(i+1);}pump();});};",
	"const s=net.connect({host:'93.184.216.34',port:443});s.setTimeout(2000);",
	"s.on('connect',()=>{s.destroy();finish('CONNECTED');});",
	"s.on('timeout',()=>{s.destroy();finish('TIMEOUT');});",
	"s.on('error',e=>finish(String((e&&e.code)||e)));",
].join("");

async function containerConfig(root, name, processSpec, extra) {
	const source = join(root, "source");
	const repoPath = join(root, `clone-${name}`);
	await exec("git", ["clone", source, repoPath]);
	return {
		id: `node-${name}`,
		capabilities: [],
		roleIds: ["dev"],
		modelIds: ["fixture"],
		tokenEnv: "PI861_TEST_WORKER_TOKEN",
		repository: repoPath,
		worktreeRoot: join(root, `trees-${name}`),
		statePath: join(root, `state-${name}.json`),
		process: processSpec,
		checks: [
			{
				id: "verify",
				command: process.execPath,
				args: ["-e", `if(!require('fs').existsSync('${extra.checkFile}'))process.exit(1)`],
			},
		],
		maxConcurrent: 1,
		isolation: {
			mode: "container",
			container: {
				image: CONTAINER_IMAGE,
				userId: "1000:1000",
				network: "none",
				memoryBytes: 268_435_456,
				cpus: 1,
				pidsLimit: 64,
				mounts: [{ host: FIXTURES, container: "/fixture" }],
				envAllowlist: ["PI861_FIXTURE_*"],
				namePrefix: "pi861-p2w",
			},
		},
	};
}

test("K7 container isolation: real OCI execution, denied network and credentials, honest reporting", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi861-iso-ctr-"));
	const handles = [];
	const env = { ...process.env, PI861_TEST_WORKER_TOKEN: TOKEN };
	try {
		// Gate: no docker/Linux daemon or missing local image BLOCKS R3.8 - fail, never skip.
		const probe = await probeContainerRuntime({
			image: CONTAINER_IMAGE,
			userId: "1000:1000",
			network: "none",
			memoryBytes: 268_435_456,
			cpus: 1,
			pidsLimit: 64,
			tmpfsBytes: 67_108_864,
			mounts: [],
			envAllowlist: [],
			namePrefix: "pi861-p2w",
		}).catch((error) => {
			throw new Error(`R3.8 blocked: container environment unavailable (${error.message})`);
		});
		console.log(`# K7 container runtime: os=${probe.serverOs} version=${probe.serverVersion} image=${probe.imageId}`);
		const source = await sourceRepo(root);
		// Startup honesty: a container-mode worker with a missing image must refuse to serve
		// (no silent trusted-local fallback while claiming isolation).
		const missingImageConfig = await containerConfig(
			root,
			"missing",
			{ command: "node", args: ["/fixture/pi-worker.mjs"] },
			{ checkFile: "a.txt" },
		);
		missingImageConfig.isolation.container.image = "localhost/pi861/nonexistent:absent";
		await assert.rejects(
			() => runWorkerService(parseWorkerServiceConfig(JSON.stringify(missingImageConfig), env), { env }),
			/not available locally/,
		);
		// 1) Real protocol fixture executes inside the container; artifacts flow back and verify.
		const fixtureConfig = await containerConfig(
			root,
			"ctr",
			{ command: "node", args: ["/fixture/pi-worker.mjs"] },
			{ checkFile: "a.txt" },
		);
		const fixtureWorker = await runWorkerService(parseWorkerServiceConfig(JSON.stringify(fixtureConfig), env), {
			env,
		});
		handles.push(fixtureWorker);
		const status = await (
			await fetch(`${fixtureWorker.url}/status`, { headers: { Authorization: `Bearer ${TOKEN}` } })
		).json();
		assert.equal(status.isolation.mode, "container");
		assert.equal(status.isolation.osSandbox, true);
		assert.equal(status.isolation.container.image, CONTAINER_IMAGE);
		const remoteWs = new Workspaces(source, join(root, "controller-trees"));
		const base = await remoteWs.head();
		const client = new RemoteWorkerClient({
			url: fixtureWorker.url,
			token: TOKEN,
			allowLoopbackHttp: true,
			pollMs: 100,
		});
		const candidate = await client.run(
			{
				version: 1,
				identity: identity("A"),
				task: runningTask("A", {
					lease: { taskId: "A", workerId: "node-ctr", token: "lease-A", attempt: 1 },
				}),
				execution: execution(),
				baseCommit: base,
				baseBundle: await remoteWs.exportCommit(base),
			},
			AbortSignal.timeout(120_000),
		);
		await remoteWs.importCommit(candidate.bundle, candidate.commit);
		const inspect = await remoteWs.create("inspect-ctr", 1, candidate.commit);
		assert.equal(await readFile(join(inspect.path, "a.txt"), "utf8"), "A");
		console.log(`# K7 container task commit=${candidate.commit.slice(0, 12)} (fixture inside OCI container)`);
		// 2) Isolation probe: uid, host credentials, network, read-only rootfs, writable scopes.
		await writeFile(join(root, "secret-token.txt"), "not-for-containers");
		const probeConfig = await containerConfig(
			root,
			"probe",
			{ command: "node", args: ["-e", PROBE_CODE] },
			{ checkFile: "probe.json" },
		);
		probeConfig.isolation.container.envAllowlist = [];
		const probeWorker = await runWorkerService(parseWorkerServiceConfig(JSON.stringify(probeConfig), env), {
			env,
		});
		handles.push(probeWorker);
		const probeTask = {
			id: "P",
			title: "P",
			status: "running",
			attempts: 1,
			dependsOn: [],
			writeScopes: ["probe.json"],
			capabilities: [],
			acceptance: ["probe.json exists"],
			artifacts: [],
			evidence: [],
			leaseUntil: Date.now() + 300_000,
			lease: { taskId: "P", workerId: "node-probe", token: "lease-P", attempt: 1 },
		};
		const probeClient = new RemoteWorkerClient({
			url: probeWorker.url,
			token: TOKEN,
			allowLoopbackHttp: true,
			pollMs: 100,
		});
		await probeClient.run(
			{
				version: 1,
				identity: identity("P"),
				task: probeTask,
				execution: { instructions: "run isolation probe", roleId: "dev", modelId: "fixture", checkIds: ["verify"] },
				baseCommit: base,
				baseBundle: await remoteWs.exportCommit(base),
			},
			AbortSignal.timeout(120_000),
		);
		const tree = join(root, "trees-probe");
		const dirs = (await readdir(tree)).map((entry) => join(tree, entry));
		const reportPath = dirs.map((dir) => join(dir, "probe.json")).find((path) => existsSync(path));
		assert.ok(reportPath, "probe report must be written inside the task workspace");
		const report = JSON.parse(readFileSync(reportPath, "utf8"));
		console.log(`# K7 container probe report: ${JSON.stringify(report)}`);
		assert.equal(report.uid, 1000, "container task must run as the non-root uid");
		assert.notEqual(report.hostSecret, "READABLE", "host credentials must be unreadable in the container");
		assert.notEqual(report.net, "CONNECTED", "unapproved network must be denied");
		assert.notEqual(report.rootfs, "WROTE-ROOT", "container root filesystem must be read-only");
		assert.equal(report.tmp, "ok", "tmpfs scratch must stay writable");
	} finally {
		for (const handle of handles) await handle.close().catch(() => {});
		// No task container may outlive the workers (--rm plus explicit force-removal).
		const leaked = await exec("docker", ["ps", "-a", "--filter", "name=pi861-p2w", "--format", "{{.ID}}"])
			.then((result) => result.stdout.trim().split(/\s+/).filter(Boolean))
			.catch(() => []);
		for (const id of leaked) await exec("docker", ["rm", "-f", id]).catch(() => {});
		const remaining = await exec("docker", ["ps", "-a", "--filter", "name=pi861-p2w", "--format", "{{.ID}}"])
			.then((result) => result.stdout.trim())
			.catch(() => "");
		assert.equal(remaining, "", "no pi861-p2w containers may remain after the workers stop");
		await rm(root, { recursive: true, force: true }).catch(() => {});
	}
});
