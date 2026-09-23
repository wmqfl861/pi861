import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { type ExecutionIdentity, validateExecutionIdentity } from "../contracts/identity.ts";
import { digest } from "../memory.ts";
import { normalizeScope, type TaskRecord } from "../scheduler.ts";
import { record } from "../search.ts";
import type { ExecutionSpec, WorkerIdentity } from "./coordinator.ts";
import type { ProcessSpec } from "./line-process.ts";
import { PiRpcSession } from "./pi-rpc.ts";
import type { StateStore } from "./store.ts";
import type { CheckCommand, Workspace, Workspaces } from "./workspace.ts";

export interface CommitBundle {
	data: string;
	sha256: string;
}
export interface RemoteJobV1 {
	version: 1;
	identity: ExecutionIdentity;
	task: TaskRecord;
	execution: ExecutionSpec;
	baseCommit: string;
	baseBundle: CommitBundle;
}
/**
 * Transitional legacy dispatch without the execution identity chain, still used by the
 * coordinator-owned runtime wiring until the scheduler package (P2-G) migrates it to the
 * versioned protocol (R3.11). The server provisions the legacy two-part workspace identity
 * for these jobs; version 1 with a validated identity is the production protocol.
 */
export interface RemoteJobLegacy {
	task: TaskRecord;
	execution: ExecutionSpec;
	baseCommit: string;
	baseBundle: CommitBundle;
}
export type RemoteJobDispatch = RemoteJobV1 | RemoteJobLegacy;
interface ParsedJob {
	id: string;
	version: 0 | 1;
	identity?: ExecutionIdentity;
	task: TaskRecord;
	execution: ExecutionSpec;
	baseCommit: string;
	baseBundle: CommitBundle;
}
/** Honest isolation capability report (R3.8/R5.11); trusted local is explicitly NOT a sandbox. */
export interface WorkerIsolationReport {
	mode: "trusted-local" | "container";
	osSandbox: boolean;
	container?: { image: string; userId: string; network: string };
}
export class RemoteTransportError extends Error {}
export interface RemoteCandidate {
	commit: string;
	bundle: CommitBundle;
	evidence: string[];
	text: string;
}
interface RemoteJob {
	id: string;
	hash: string;
	state: "queued" | "running" | "done" | "failed" | "unknown";
	result?: RemoteCandidate;
}
export interface RemoteJobs {
	jobs: RemoteJob[];
}
export interface RemoteWorkerConfig {
	url: string;
	token: string;
	allowLoopbackHttp?: boolean;
	pollMs?: number;
	unavailableAfter?: number;
	unavailableCooldownMs?: number;
}
const MAX_BODY = 48_000_000;
function authorized(value: string | undefined, expected: string): boolean {
	if (expected.length < 24 || !value?.startsWith("Bearer ")) return false;
	return timingSafeEqual(
		createHash("sha256").update(value.slice(7)).digest(),
		createHash("sha256").update(expected).digest(),
	);
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
	let size = 0;
	const chunks: Buffer[] = [];
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY) throw new Error("Request too large");
		chunks.push(chunk);
	}
	const parsed = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	if (!parsed) throw new Error("Object required");
	return parsed;
}
function reply(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	response.end(JSON.stringify(value));
}
function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function parseJob(value: Record<string, unknown>): ParsedJob {
	const task = record(value.task),
		lease = record(task?.lease),
		execution = record(value.execution),
		identity = record(value.identity),
		bundle = record(value.baseBundle);
	if (
		typeof value.id !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.id) ||
		!task ||
		typeof task.id !== "string" ||
		typeof task.title !== "string" ||
		task.status !== "running" ||
		typeof task.attempts !== "number" ||
		!strings(task.dependsOn) ||
		!strings(task.writeScopes) ||
		!strings(task.capabilities) ||
		!strings(task.acceptance) ||
		!task.acceptance.length ||
		!strings(task.artifacts) ||
		!strings(task.evidence) ||
		!lease ||
		lease.taskId !== task.id ||
		typeof lease.workerId !== "string" ||
		typeof lease.token !== "string" ||
		lease.attempt !== task.attempts ||
		typeof task.leaseUntil !== "number" ||
		!execution ||
		typeof execution.instructions !== "string" ||
		!execution.instructions.trim() ||
		execution.instructions.length > 100_000 ||
		typeof execution.roleId !== "string" ||
		typeof execution.modelId !== "string" ||
		!strings(execution.checkIds) ||
		!execution.checkIds.length ||
		typeof value.baseCommit !== "string" ||
		!/^[a-f0-9]{40,64}$/.test(value.baseCommit) ||
		!bundle ||
		typeof bundle.data !== "string" ||
		typeof bundle.sha256 !== "string"
	)
		throw new Error("Invalid versioned worker request");
	const common: Omit<ParsedJob, "version" | "identity"> = {
		id: value.id,
		baseCommit: value.baseCommit,
		baseBundle: { data: bundle.data, sha256: bundle.sha256 },
		task: {
			id: task.id,
			title: task.title,
			status: "running",
			attempts: task.attempts,
			dependsOn: task.dependsOn,
			writeScopes: task.writeScopes.map(normalizeScope),
			capabilities: task.capabilities,
			acceptance: task.acceptance,
			artifacts: task.artifacts,
			evidence: task.evidence,
			leaseUntil: task.leaseUntil,
			lease: { taskId: task.id, workerId: lease.workerId, token: lease.token, attempt: task.attempts },
		},
		execution: {
			instructions: execution.instructions,
			roleId: execution.roleId,
			modelId: execution.modelId,
			checkIds: execution.checkIds,
		},
	};
	if (value.version === 1) {
		if (
			!identity ||
			typeof identity.tenantId !== "string" ||
			typeof identity.projectId !== "string" ||
			typeof identity.goalId !== "string" ||
			typeof identity.runId !== "string" ||
			identity.taskId !== task.id ||
			identity.attempt !== task.attempts
		)
			throw new Error("Invalid versioned worker request");
		return {
			version: 1,
			identity: validateExecutionIdentity({
				tenantId: identity.tenantId,
				projectId: identity.projectId,
				goalId: identity.goalId,
				runId: identity.runId,
				taskId: task.id,
				attempt: task.attempts,
			}),
			...common,
		};
	}
	if (value.version !== undefined && value.version !== 0) throw new Error("Unsupported worker protocol version");
	return { version: 0, ...common };
}
/** Fixed operator-owned executor configuration. Requests cannot supply commands, credentials or host paths. */
export class RemoteWorkerServer {
	private readonly state: StateStore<RemoteJobs>;
	private readonly config: {
		token: string;
		identity: WorkerIdentity;
		workspaces: Workspaces;
		checks: CheckCommand[];
		process: (workspace: Workspace, execution: ExecutionSpec) => ProcessSpec;
		maxConcurrent: number;
		timeoutMs?: number;
		waitForSettled?: boolean;
		rpcTimeoutMs?: number;
		onShutdown?: () => Promise<void> | void;
		/** Post-session hook so container-mode deployments can force-remove the task container. */
		onProcessEnd?: (workspace: Workspace) => Promise<void> | void;
		/** Honest isolation capability report surfaced on /status (R3.8/R5.11). */
		isolation?: WorkerIsolationReport;
	};
	private readonly active = new Map<string, AbortController>();
	private readonly running = new Set<Promise<void>>();
	private readonly startedAt = Date.now();
	private lastSeenAt = Date.now();
	private server: Server | undefined;
	constructor(state: StateStore<RemoteJobs>, config: RemoteWorkerServer["config"]) {
		if (config.token.length < 24 || config.maxConcurrent < 1)
			throw new Error("Strong bearer token and positive capacity required");
		this.state = state;
		this.config = config;
	}
	async listen(port = 0, host = "127.0.0.1"): Promise<string> {
		if (this.server) throw new Error("Already listening");
		this.server = createServer((request, response) => {
			void this.handle(request, response).catch(() => {
				if (!response.headersSent)
					reply(response, 400, { error: "Request refused; inspect authorized operator diagnostics" });
				else response.end();
			});
		});
		this.server.requestTimeout = 30_000;
		this.server.headersTimeout = 10_000;
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(port, host, resolve);
		});
		// A crashed producer's state is not proof that its operations never happened.
		await this.state.update((state) => {
			for (const job of state.jobs) if (["queued", "running"].includes(job.state)) job.state = "unknown";
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("Missing listen address");
		return `http://${host}:${address.port}`;
	}
	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!authorized(request.headers.authorization, this.config.token)) {
			reply(response, 401, { error: "Unauthorized" });
			return;
		}
		this.lastSeenAt = Date.now();
		const path = new URL(request.url ?? "/", "http://localhost").pathname;
		if (request.method === "GET" && path === "/status") {
			// Capacity announcement (R3.13): the coordinator reads this for node recovery and tree-wide accounting.
			const jobs = (await this.state.read()).jobs;
			const count = (state: RemoteJob["state"]): number => jobs.filter((job) => job.state === state).length;
			reply(response, 200, {
				id: this.config.identity.id,
				capabilities: this.config.identity.capabilities,
				roleIds: this.config.identity.roleIds,
				modelIds: this.config.identity.modelIds,
				maxConcurrent: this.config.maxConcurrent,
				inFlight: count("queued") + count("running"),
				isolation:
					this.config.isolation ?? { mode: "trusted-local", osSandbox: false },
				jobs: {
					queued: count("queued"),
					running: count("running"),
					done: count("done"),
					failed: count("failed"),
					unknown: count("unknown"),
				},
				startedAt: this.startedAt,
				lastSeenAt: this.lastSeenAt,
			});
			return;
		}
		if (request.method === "POST" && path === "/shutdown") {
			// Operator-initiated convergent shutdown; works on every platform (Windows cannot deliver catchable SIGTERM).
			if (!this.config.onShutdown) {
				reply(response, 501, { error: "Shutdown not configured" });
				return;
			}
			reply(response, 202, { shutdown: true });
			setImmediate(() => {
				void this.config.onShutdown?.();
			});
			return;
		}
		if (request.method === "GET" && path.startsWith("/jobs/")) {
			const id = path.slice(6),
				job = (await this.state.read()).jobs.find((job) => job.id === id);
			reply(response, job ? 200 : 404, job ? { id, state: job.state, result: job.result } : { error: "Not found" });
			return;
		}
		if (request.method === "POST" && path === "/cancel") {
			const input = await body(request);
			this.active.get(String(input.id))?.abort();
			reply(response, 202, { cancellationRequested: true });
			return;
		}
		if (request.method !== "POST" || path !== "/jobs") {
			reply(response, 404, { error: "Not found" });
			return;
		}
		const input = parseJob(await body(request));
		if (
			input.task.lease?.workerId !== this.config.identity.id ||
			input.task.capabilities.some((capability) => !this.config.identity.capabilities.includes(capability)) ||
			!this.config.identity.roleIds.includes(input.execution.roleId) ||
			!this.config.identity.modelIds.includes(input.execution.modelId) ||
			input.execution.checkIds.some((id) => !this.config.checks.some((check) => check.id === id))
		)
			throw new Error("Unapproved task contract");
		const hash = digest(input);
		const accepted = await this.state.update((state) => {
			const prior = state.jobs.find((job) => job.id === input.id);
			if (prior) {
				if (prior.hash !== hash) throw new Error("Idempotency conflict");
				return { fresh: false, state: prior.state };
			}
			if (
				state.jobs.filter((job) => job.state === "running" || job.state === "queued").length >=
					this.config.maxConcurrent ||
				state.jobs.length >= 10_000
			)
				throw new Error("Worker capacity exhausted");
			state.jobs.push({ id: input.id, hash, state: "queued" });
			return { fresh: true, state: "queued" };
		});
		if (accepted.fresh) {
			const controller = new AbortController();
			this.active.set(input.id, controller);
			const running = this.run(input, controller)
				.catch(() => {})
				.finally(() => {
					this.active.delete(input.id);
					this.running.delete(running);
				});
			this.running.add(running);
		}
		reply(response, 202, { id: input.id, state: accepted.state });
	}
	private async run(input: ParsedJob, controller: AbortController): Promise<void> {
		let session: PiRpcSession | undefined;
		try {
			await this.state.update((state) => {
				const job = state.jobs.find((job) => job.id === input.id);
				if (job) job.state = "running";
			});
			await this.config.workspaces.importCommit(input.baseBundle, input.baseCommit);
			controller.signal.throwIfAborted();
			const workspace = input.identity
				? await this.config.workspaces.createTask(input.identity, input.baseCommit)
				: await this.config.workspaces.create(input.task.id, input.task.attempts, input.baseCommit);
			try {
				session = new PiRpcSession(
					this.config.process(workspace, { ...input.execution, writeScopes: input.task.writeScopes }),
					{ waitForSettled: this.config.waitForSettled, rpcTimeoutMs: this.config.rpcTimeoutMs },
				);
				const result = await session.prompt(
					`Task: ${input.task.title}\n\n${input.execution.instructions}\nAllowed write scopes: ${JSON.stringify(input.task.writeScopes)}\nAcceptance: ${JSON.stringify(input.task.acceptance)}\nDo not deploy, change another worktree, commit, or create unmanaged descendants.`,
					controller.signal,
					this.config.timeoutMs ?? 600_000,
				);
				await session.close();
				session = undefined;
				const paths = await this.config.workspaces.changed(workspace, input.task.writeScopes);
				const evidence = await this.config.workspaces.check(
					workspace,
					this.config.checks.filter((check) => input.execution.checkIds.includes(check.id)),
					controller.signal,
				);
				const commit = await this.config.workspaces.commit(workspace, paths, input.task.id);
				const bundle = await this.config.workspaces.exportCommit(commit, input.baseCommit);
				controller.signal.throwIfAborted();
				await this.state.update((state) => {
					const job = state.jobs.find((job) => job.id === input.id);
					if (job) {
						job.state = "done";
						job.result = { commit, bundle, evidence, text: result.text.slice(0, 32_000) };
					}
				});
			} finally {
				await session?.close().catch(() => {});
				session = undefined;
				// Container teardown happens only after full session close, even after abort (R3.9 convergence).
				await this.config.onProcessEnd?.(workspace);
			}
		} catch {
			await this.state.update((state) => {
				const job = state.jobs.find((job) => job.id === input.id);
				if (job) job.state = controller.signal.aborted ? "unknown" : "failed";
			});
		}
	}
	async close(): Promise<void> {
		for (const controller of this.active.values()) controller.abort();
		if (this.server)
			await new Promise<void>((resolve) => {
				this.server?.close(() => resolve());
				this.server?.closeAllConnections();
			});
		this.server = undefined;
		await Promise.allSettled(this.running);
	}
}
export class RemoteWorkerClient {
	private readonly config: RemoteWorkerConfig;
	private consecutiveFailures = 0;
	private unavailableUntil = 0;
	constructor(config: RemoteWorkerConfig) {
		const url = new URL(config.url);
		if (
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			(url.pathname !== "/" && url.pathname !== "") ||
			config.token.length < 24 ||
			(url.protocol !== "https:" &&
				!(
					config.allowLoopbackHttp &&
					url.protocol === "http:" &&
					["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
				))
		)
			throw new Error("Trusted HTTPS worker endpoint required");
		this.config = config;
	}
	/**
	 * Polling doubles as the heartbeat (R3.13): consecutive transport failures mark the node
	 * presumed-lost so the scheduler stops assigning it new leases until the cooldown expires.
	 * Any completed HTTP exchange (even an error status) proves the node is alive and resets the count.
	 */
	available(): boolean {
		return Date.now() >= this.unavailableUntil;
	}
	private noteTransportFailure(): void {
		this.consecutiveFailures++;
		if (this.consecutiveFailures >= (this.config.unavailableAfter ?? 3))
			this.unavailableUntil = Date.now() + (this.config.unavailableCooldownMs ?? 30_000);
	}
	private async request(
		path: string,
		method: string,
		value: unknown,
		signal: AbortSignal,
	): Promise<Record<string, unknown>> {
		let response: Response;
		try {
			response = await fetch(`${this.config.url.replace(/\/$/, "")}${path}`, {
				method,
				redirect: "error",
				headers: { Authorization: `Bearer ${this.config.token}`, "Content-Type": "application/json" },
				...(method === "GET" ? {} : { body: JSON.stringify(value) }),
				signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
			});
		} catch (error) {
			if (signal.aborted) throw error;
			this.noteTransportFailure();
			throw new RemoteTransportError("Worker transport unavailable; execution outcome is unknown", { cause: error });
		}
		this.consecutiveFailures = 0;
		if (!response.ok) throw new Error(`Remote worker HTTP ${response.status}`);
		let size = 0;
		const chunks: Uint8Array[] = [];
		const reader = response.body?.getReader();
		if (!reader) throw new Error("Missing worker response");
		try {
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				size += part.value.byteLength;
				if (size > MAX_BODY) throw new Error("Worker response exceeds limit");
				chunks.push(part.value);
			}
		} finally {
			await reader.cancel().catch(() => {});
		}
		const parsed = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
		if (!parsed) throw new Error("Invalid worker response");
		return parsed;
	}
	async run(input: RemoteJobDispatch, signal: AbortSignal): Promise<RemoteCandidate> {
		const id = digest(
			"version" in input && input.version === 1
				? {
						version: input.version,
						identity: input.identity,
						lease: input.task.lease,
						execution: input.execution,
						baseCommit: input.baseCommit,
					}
				: { task: input.task, execution: input.execution, baseCommit: input.baseCommit },
		);
		const cancel = (): void => {
			void this.request("/cancel", "POST", { id }, AbortSignal.timeout(5000)).catch(() => {});
		};
		signal.addEventListener("abort", cancel, { once: true });
		try {
			// Same ID can be queried after lost acknowledgement; task execution itself is never replayed here.
			try {
				await this.request("/jobs", "POST", { ...input, id }, signal);
			} catch (error) {
				if (signal.aborted) throw error;
				await this.request(`/jobs/${id}`, "GET", null, signal);
			}
			while (true) {
				signal.throwIfAborted();
				const job = await this.request(`/jobs/${id}`, "GET", null, signal);
				if (job.state === "done") {
					const value = record(job.result),
						bundle = record(value?.bundle);
					if (
						!value ||
						typeof value.commit !== "string" ||
						!/^[a-f0-9]{40,64}$/.test(value.commit) ||
						!bundle ||
						typeof bundle.data !== "string" ||
						typeof bundle.sha256 !== "string" ||
						!strings(value.evidence) ||
						typeof value.text !== "string"
					)
						throw new Error("Invalid remote candidate");
					return {
						commit: value.commit,
						bundle: { data: bundle.data, sha256: bundle.sha256 },
						evidence: value.evidence,
						text: value.text,
					};
				}
				if (job.state === "failed" || job.state === "unknown")
					throw new Error("Remote attempt requires reconciliation; no automatic replay");
				await sleep(this.config.pollMs ?? 1000, undefined, { signal });
			}
		} finally {
			signal.removeEventListener("abort", cancel);
		}
	}
}
