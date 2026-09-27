/**
 * Startable RemoteWorker deployment entry (R3.13, Phase A module-internal; runtime/package wiring stays with the coordinator agent).
 *
 * Production entry: node extensions/pi861/scripts/worker-service.mjs /absolute/path/to/worker.config.json
 * (this module also runs directly: node --experimental-strip-types src/live/worker-service.ts <config>).
 *
 * Trusted JSON config schema (identity and capabilities come ONLY from this file, never from requests):
 * {
 *   "id": "node-1",                        // worker identity
 *   "capabilities": ["code"],              // capability whitelist
 *   "roleIds": ["dev"],                    // role whitelist
 *   "modelIds": ["fixture"],               // model whitelist
 *   "tokenEnv": "PI861_WORKER_TOKEN",      // NAME of the env var holding the bearer token (>= 24 chars; never inline secrets)
 *   "repository": "/abs/path/repo",        // this node's own checkout (independent of the coordinator's)
 *   "worktreeRoot": "/abs/path/trees",     // task worktrees live here, outside the repository working tree
 *   "statePath": "/abs/path/state.json",   // durable job state for restart reconciliation
 *   "process": { "command": "node", "args": ["worker.js"], "waitForSettled": false, "rpcTimeoutMs": 30000 },
 *   "checks": [{ "id": "verify", "command": "node", "args": ["-e", "..."] }],
 *   "maxConcurrent": 1,
 *   "host": "127.0.0.1", "port": 0,        // optional listen address; defaults to loopback with an ephemeral port
 *   "isolation": {                          // R3.8 isolation mode declaration
 *     "mode": "trusted-local",              // honest no-OS-sandbox mode (default)
 *     // OR
 *     "mode": "container",
 *     "container": {                        // Linux OCI container task execution
 *       "image": "<local image ref>", "userId": "1000:1000", "network": "none",
 *       "memoryBytes": 536870912, "cpus": 1, "pidsLimit": 64,
 *       "mounts": [{ "host": "/abs", "container": "/abs" }],   // extra READ-ONLY mounts; credentials denied
 *       "envAllowlist": ["TRACE", "PI861_*"],                  // tokenEnv can never be included
 *       "namePrefix": "pi861-worker"
 *     }
 *   }
 * }
 *
 * In container mode the `process` command/args are CONTAINER-viewport paths (only the task workspace
 * is mounted writable at /workspace; extra mounts are read-only), and startup refuses to serve when
 * the OCI runtime is unreachable, non-Linux or lacks the image locally - there is no silent fallback
 * to trusted-local (R3.8/R5.11 stay blocked rather than falsely passing).
 *
 * Startup self-checks: repository resolves to a git HEAD, worktree root lies outside the source working
 * tree, the token is present and strong, checks and process spec are non-empty.
 * Shutdown: SIGTERM/SIGINT stop intake, abort in-flight jobs to `unknown` and converge (POSIX);
 * POST /shutdown does the same on any platform, which is how Windows operators converge gracefully.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { record } from "../search.ts";
import {
	type ContainerExecutionOptions,
	containerLaunch,
	forceRemoveContainer,
	parseContainerExecutionOptions,
	probeContainerRuntime,
} from "./container-exec.ts";
import { RemoteWorkerServer, type WorkerIsolationReport } from "./remote-worker.ts";
import { FileStateStore } from "./store.ts";
import { type CheckCommand, Workspaces } from "./workspace.ts";

interface WorkerServiceConfig {
	id: string;
	capabilities: string[];
	roleIds: string[];
	modelIds: string[];
	tokenEnv: string;
	repository: string;
	worktreeRoot: string;
	statePath: string;
	process: {
		command: string;
		args: string[];
		waitForSettled?: boolean;
		rpcTimeoutMs?: number;
		/** Trusted extra env for the task process (e.g. HOME/PI861_CONFIG for the Pi host). */
		env?: Record<string, string>;
	};
	checks: CheckCommand[];
	maxConcurrent: number;
	host?: string;
	port?: number;
	isolation: { mode: "trusted-local" | "container"; container?: ContainerExecutionOptions };
}

function nonEmptyStrings(value: unknown, field: string, allowEmpty = false): string[] {
	if (
		!Array.isArray(value) ||
		(!allowEmpty && !value.length) ||
		value.some((item) => typeof item !== "string" || !item.trim())
	)
		throw new Error(`Config field ${field} must be a string list`);
	return value as string[];
}
export function parseWorkerServiceConfig(raw: string, env: NodeJS.ProcessEnv = process.env): WorkerServiceConfig {
	const parsed = record(JSON.parse(raw));
	if (!parsed) throw new Error("Worker config must be a JSON object");
	const id = typeof parsed.id === "string" ? parsed.id.trim() : "";
	if (!id) throw new Error("Worker config requires an id");
	const tokenEnv = typeof parsed.tokenEnv === "string" ? parsed.tokenEnv.trim() : "";
	if (!tokenEnv || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv))
		throw new Error("Worker config requires tokenEnv naming an environment variable");
	if (!env[tokenEnv]) throw new Error(`Missing bearer token in environment variable ${tokenEnv}`);
	const repository = typeof parsed.repository === "string" ? parsed.repository : "";
	const worktreeRoot = typeof parsed.worktreeRoot === "string" ? parsed.worktreeRoot : "";
	const statePath = typeof parsed.statePath === "string" ? parsed.statePath : "";
	if (!isAbsolute(repository) || !isAbsolute(worktreeRoot) || !isAbsolute(statePath))
		throw new Error("Repository, worktreeRoot and statePath must be absolute paths");
	const proc = record(parsed.process);
	if (
		!proc ||
		typeof proc.command !== "string" ||
		!proc.command.trim() ||
		!Array.isArray(proc.args) ||
		proc.args.some((arg) => typeof arg !== "string")
	)
		throw new Error("Worker config requires a process spec (command + string args)");
	if (!Array.isArray(parsed.checks) || !parsed.checks.length)
		throw new Error("Worker config requires at least one trusted check command");
	const checks: CheckCommand[] = [];
	for (const item of parsed.checks) {
		const check = record(item);
		if (
			!check ||
			typeof check.id !== "string" ||
			!check.id.trim() ||
			typeof check.command !== "string" ||
			!check.command.trim() ||
			!Array.isArray(check.args) ||
			check.args.some((arg) => typeof arg !== "string")
		)
			throw new Error("Every check needs an id, command and string args");
		checks.push({
			id: check.id,
			command: check.command,
			args: check.args,
			timeoutMs: typeof check.timeoutMs === "number" ? check.timeoutMs : undefined,
		});
	}
	if (
		typeof parsed.maxConcurrent !== "number" ||
		!Number.isSafeInteger(parsed.maxConcurrent) ||
		parsed.maxConcurrent < 1
	)
		throw new Error("maxConcurrent must be a positive integer");
	if (
		proc.rpcTimeoutMs !== undefined &&
		(typeof proc.rpcTimeoutMs !== "number" ||
			!Number.isSafeInteger(proc.rpcTimeoutMs) ||
			proc.rpcTimeoutMs < 1 ||
			proc.rpcTimeoutMs > 2_147_483_647)
	)
		throw new Error("Invalid RPC timeout");
	const processEnv: Record<string, string> = {};
	if (proc.env !== undefined) {
		if (!proc.env || typeof proc.env !== "object" || Array.isArray(proc.env))
			throw new Error("process.env must be a string map");
		for (const [key, value] of Object.entries(proc.env as Record<string, unknown>)) {
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string")
				throw new Error("process.env must be a map of env names to strings");
			if (key === tokenEnv)
				throw new Error("process.env must not forward the worker bearer token env");
			processEnv[key] = value;
		}
	}
	if (
		parsed.port !== undefined &&
		(typeof parsed.port !== "number" || !Number.isSafeInteger(parsed.port) || parsed.port < 0 || parsed.port > 65535)
	)
		throw new Error("Invalid worker port");
	let isolation: WorkerServiceConfig["isolation"] = { mode: "trusted-local" };
	if (parsed.isolation !== undefined) {
		const section = record(parsed.isolation);
		if (!section || (section.mode !== "trusted-local" && section.mode !== "container"))
			throw new Error('isolation.mode must be "trusted-local" or "container"');
		if (section.mode === "trusted-local") {
			if (section.container !== undefined) throw new Error("trusted-local mode must not configure a container");
			isolation = { mode: "trusted-local" };
		} else {
			isolation = {
				mode: "container",
				container: parseContainerExecutionOptions(section.container, tokenEnv, { namePrefix: "pi861-worker" }),
			};
		}
	}
	return {
		id,
		capabilities: nonEmptyStrings(parsed.capabilities, "capabilities", true),
		roleIds: nonEmptyStrings(parsed.roleIds, "roleIds"),
		modelIds: nonEmptyStrings(parsed.modelIds, "modelIds"),
		tokenEnv,
		repository,
		worktreeRoot,
		statePath,
		process: {
			command: proc.command,
			args: proc.args,
			waitForSettled: proc.waitForSettled === true,
			rpcTimeoutMs: typeof proc.rpcTimeoutMs === "number" ? proc.rpcTimeoutMs : undefined,
			...(Object.keys(processEnv).length ? { env: processEnv } : {}),
		},
		checks,
		maxConcurrent: parsed.maxConcurrent,
		host: typeof parsed.host === "string" ? parsed.host : undefined,
		port: typeof parsed.port === "number" && Number.isSafeInteger(parsed.port) ? parsed.port : undefined,
		isolation,
	};
}

export interface WorkerServiceHandle {
	server: RemoteWorkerServer;
	url: string;
	config: WorkerServiceConfig;
	/** Convergent shutdown: stop intake, abort in-flight jobs to unknown, wait for the tail, then exit the process. */
	close(): Promise<void>;
	/** Resolves once a convergent shutdown has completed. */
	closed: Promise<void>;
}
export async function runWorkerService(
	config: WorkerServiceConfig,
	hooks: { env?: NodeJS.ProcessEnv; stdout?: (line: string) => void } = {},
): Promise<WorkerServiceHandle> {
	const env = hooks.env ?? process.env;
	const token = env[config.tokenEnv] ?? "";
	if (token.length < 24) throw new Error(`Bearer token from ${config.tokenEnv} must be at least 24 characters`);
	const workspaces = new Workspaces(config.repository, config.worktreeRoot);
	// Self-check: the configured repository must resolve to a real git HEAD before serving work.
	await workspaces.head();
	const container = config.isolation.container;
	let runtimeProbe: { serverVersion: string; imageId: string } | undefined;
	if (config.isolation.mode === "container" && container) {
		// Fail closed: serving without a verified Linux OCI runtime would silently claim isolation.
		const probe = await probeContainerRuntime(container);
		runtimeProbe = { serverVersion: probe.serverVersion, imageId: probe.imageId };
	}
	const state = new FileStateStore(config.statePath, { jobs: [] });
	let closeRequested = false;
	let closedResolve: () => void = () => {};
	const closed = new Promise<void>((resolve) => {
		closedResolve = resolve;
	});
	const close = async (): Promise<void> => {
		if (closeRequested) return;
		closeRequested = true;
		try {
			await server.close();
		} finally {
			closedResolve();
		}
	};
	const isolationReport: WorkerIsolationReport = container
		? {
				mode: "container",
				osSandbox: true,
				container: { image: container.image, userId: container.userId, network: container.network },
			}
		: { mode: "trusted-local", osSandbox: false };
	const containersByWorkspace = new Map<string, Set<string>>();
	const removeContainers = async (workspacePath: string): Promise<void> => {
		const names = containersByWorkspace.get(workspacePath);
		if (!names) return;
		containersByWorkspace.delete(workspacePath);
		await Promise.all([...names].map((name) => forceRemoveContainer(name)));
	};
	// Operator-initiated convergent shutdown (POST /shutdown) and POSIX signals share one path.
	const server = new RemoteWorkerServer(state, {
		token,
		identity: {
			id: config.id,
			capabilities: config.capabilities,
			roleIds: config.roleIds,
			modelIds: config.modelIds,
		},
		workspaces,
		checks: config.checks,
		maxConcurrent: config.maxConcurrent,
		process: (workspace) => {
			if (!container)
				return {
					command: config.process.command,
					args: config.process.args,
					cwd: workspace.path,
					...(config.process.env ? { env: config.process.env } : {}),
				};
			// Container mode: the config's command/args are container-viewport paths.
			const launch = containerLaunch(
				{ command: config.process.command, args: config.process.args, workspaceHostPath: workspace.path },
				{ ...container, envAllowlist: [...container.envAllowlist, ...Object.keys(config.process.env ?? {})] },
				{ ...env, ...(config.process.env ?? {}) },
			);
			const names = containersByWorkspace.get(workspace.path) ?? new Set<string>();
			names.add(launch.containerName);
			containersByWorkspace.set(workspace.path, names);
			return launch.spec;
		},
		waitForSettled: config.process.waitForSettled,
		rpcTimeoutMs: config.process.rpcTimeoutMs,
		onShutdown: close,
		onProcessEnd: (workspace) => removeContainers(workspace.path),
		isolation: isolationReport,
	});
	const url = await server.listen(config.port ?? 0, config.host ?? "127.0.0.1");
	(
		hooks.stdout ??
		((line: string): void => {
			process.stdout.write(`${line}\n`);
		})
	)(
		JSON.stringify({
			type: "worker-listening",
			id: config.id,
			url,
			isolation: isolationReport,
			...(runtimeProbe ? { containerRuntime: runtimeProbe } : {}),
		}),
	);
	return { server, url, config, close, closed };
}

/** Operator main for the production entry script (scripts/worker-service.mjs). */
export async function workerServiceMain(): Promise<void> {
	const configPath = process.argv[2] ?? process.env.PI861_WORKER_CONFIG ?? "";
	if (!configPath || !isAbsolute(configPath)) {
		process.stderr.write("Usage: worker-service <absolute-config.json> (or PI861_WORKER_CONFIG)\n");
		process.exit(2);
		return;
	}
	const config = parseWorkerServiceConfig(readFileSync(resolve(configPath), "utf8"));
	const handle = await runWorkerService(config);
	const stop = (): void => {
		process.removeListener("SIGTERM", stop);
		process.removeListener("SIGINT", stop);
		void handle.close().catch(() => {});
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	await handle.closed;
	process.exit(0);
}
const invokedDirectly =
	process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly)
	void workerServiceMain().catch((error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	});
