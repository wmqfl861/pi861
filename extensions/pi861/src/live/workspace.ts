import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { digest } from "../memory.ts";
import { normalizeScope } from "../scheduler.ts";

const execute = promisify(execFile);
export interface CheckCommand {
	id: string;
	command: string;
	args: string[];
	timeoutMs?: number;
	env?: Record<string, string>;
}
export interface Workspace {
	path: string;
	baseCommit: string;
	branch: string;
}
/**
 * Full execution identity (R3.11): goal/run/task/attempt. Reusing a planner taskId in a later
 * goal or run must not collide with a surviving workspace path or branch.
 */
export interface TaskIdentity {
	goalId: string;
	runId: string;
	taskId: string;
	attempt: number;
}
const IDENTITY_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,95}$/;

/** Isolated Git state and explicit path checks; a worktree is not an OS security sandbox. */
export class Workspaces {
	private readonly repository: string;
	private readonly root: string;
	constructor(repository: string, root: string) {
		this.repository = realpathSync(resolve(repository));
		this.root = resolve(root);
		const relation = relative(this.repository, this.root);
		if (!relation || (!relation.startsWith("..") && !isAbsolute(relation)))
			throw new Error("Worktrees must be outside the source working tree");
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		this.root = realpathSync(this.root);
		const physical = relative(this.repository, this.root);
		if (!physical || (!physical.startsWith("..") && !isAbsolute(physical)))
			throw new Error("Worktree root resolves inside the source working tree");
	}
	async head(): Promise<string> {
		return (await execute("git", ["rev-parse", "HEAD"], { cwd: this.repository })).stdout.trim();
	}
	/** Legacy two-dimension identity (taskId/attempt only); kept for the coordinator-owned runtime wiring until Phase B migrates it. */
	async create(taskId: string, attempt: number, baseCommit: string): Promise<Workspace> {
		return this.provision([taskId, attempt], baseCommit);
	}
	/** Goal-scoped workspace identity: digest derives from goal/run/task/attempt so taskId reuse cannot collide. */
	async createTask(identity: TaskIdentity, baseCommit: string): Promise<Workspace> {
		for (const token of [identity.goalId, identity.runId, identity.taskId]) {
			if (typeof token !== "string" || !IDENTITY_TOKEN.test(token))
				throw new Error("Goal, run and task identity must be short slug-like tokens");
		}
		return this.provision([identity.goalId, identity.runId, identity.taskId, identity.attempt], baseCommit);
	}
	private async provision(parts: unknown[], baseCommit: string): Promise<Workspace> {
		if (!/^[a-f0-9]{40,64}$/.test(baseCommit)) throw new Error("Pinned commit required");
		const attempt = parts[parts.length - 1];
		if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1)
			throw new Error("Valid attempt required");
		const id = digest(parts).slice(0, 24),
			path = join(this.root, id),
			branch = `pi861/task-${id}`;
		if (existsSync(path)) throw new Error("Task workspace already exists; reconcile before reuse");
		await execute("git", ["worktree", "add", "-b", branch, path, baseCommit], {
			cwd: this.repository,
			maxBuffer: 1_048_576,
		});
		return { path, branch, baseCommit };
	}
	async changed(workspace: Workspace, scopes: string[]): Promise<string[]> {
		const allowed = scopes.map(normalizeScope);
		const tracked = (
			await execute("git", ["diff", "--name-only", "-z", workspace.baseCommit, "--"], { cwd: workspace.path })
		).stdout;
		const untracked = (
			await execute("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: workspace.path })
		).stdout;
		const names = [...new Set(`${tracked}${untracked}`.split("\0").filter(Boolean))];
		for (const name of names) {
			const path = normalizeScope(name);
			if (!allowed.some((scope) => scope === "." || path === scope || path.startsWith(`${scope}/`)))
				throw new Error(`Task changed an unreserved path: ${path}`);
			if (existsSync(join(workspace.path, path)) && lstatSync(join(workspace.path, path)).isSymbolicLink())
				throw new Error("Task produced a symlink; requires explicit review");
		}
		return names;
	}
	async check(workspace: Workspace, checks: CheckCommand[], signal: AbortSignal): Promise<string[]> {
		const evidence: string[] = [];
		for (const check of checks) {
			signal.throwIfAborted();
			const result = await this.runCommand(
				check.command,
				check.args,
				workspace.path,
				signal,
				check.timeoutMs ?? 120_000,
				{
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					PI861_WORKSPACE: workspace.path,
					...check.env,
				},
			);
			evidence.push(`check:${check.id}:passed:sha256:${digest({ stdout: result.stdout, stderr: result.stderr })}`);
		}
		return evidence;
	}
	async commit(workspace: Workspace, paths: string[], taskId: string): Promise<string> {
		if (paths.length) {
			await execute("git", ["add", "--", ...paths], { cwd: workspace.path, maxBuffer: 1_048_576 });
			await execute(
				"git",
				[
					"-c",
					"user.name=Pi861 Worker",
					"-c",
					"user.email=pi861-worker@localhost",
					"commit",
					"-m",
					`feat: candidate for task ${taskId.slice(0, 80)}`,
				],
				{ cwd: workspace.path, maxBuffer: 1_048_576 },
			);
		}
		return (await execute("git", ["rev-parse", "HEAD"], { cwd: workspace.path })).stdout.trim();
	}
	async exportCommit(commit: string, exclude?: string): Promise<{ data: string; sha256: string }> {
		if (!/^[a-f0-9]{40,64}$/.test(commit) || (exclude && !/^[a-f0-9]{40,64}$/.test(exclude)))
			throw new Error("Invalid transfer commit");
		if (commit === exclude) return { data: "", sha256: createHash("sha256").update("").digest("hex") };
		const id = randomUUID(),
			ref = `refs/pi861-transfers/${id}`,
			file = join(this.root, `${id}.bundle`);
		await execute("git", ["update-ref", ref, commit], { cwd: this.repository });
		try {
			await execute("git", ["bundle", "create", file, ref, ...(exclude ? [`^${exclude}`] : [])], {
				cwd: this.repository,
				maxBuffer: 1_048_576,
			});
			const bytes = readFileSync(file);
			if (bytes.length > 33_554_432)
				throw new Error("Transfer bundle exceeds 32 MiB; use an operator-managed artifact transport");
			return { data: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") };
		} finally {
			rmSync(file, { force: true });
			await execute("git", ["update-ref", "-d", ref, commit], { cwd: this.repository });
		}
	}
	async importCommit(bundle: { data: string; sha256: string }, commit: string): Promise<void> {
		if (!/^[a-f0-9]{40,64}$/.test(commit) || bundle.data.length > 44_739_244)
			throw new Error("Invalid transfer object");
		const bytes = Buffer.from(bundle.data, "base64");
		if (createHash("sha256").update(bytes).digest("hex") !== bundle.sha256)
			throw new Error("Transfer checksum mismatch");
		if (!bytes.length) {
			await execute("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: this.repository });
			return;
		}
		const file = join(this.root, `${randomUUID()}.bundle`);
		writeFileSync(file, bytes, { mode: 0o600 });
		try {
			await execute("git", ["bundle", "verify", file], { cwd: this.repository, maxBuffer: 1_048_576 });
			await execute(
				"git",
				["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-write-fetch-head", file, commit],
				{ cwd: this.repository, maxBuffer: 1_048_576 },
			);
		} finally {
			rmSync(file, { force: true });
		}
	}

	/** Integrates into a dedicated worktree, never the user's main checkout. */
	async integrate(workspace: Workspace, commit: string, signal: AbortSignal): Promise<void> {
		if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid candidate commit");
		await this.runCommand(
			"git",
			[
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=Pi861 Integrator",
				"-c",
				"user.email=pi861-integrator@localhost",
				"merge",
				"--no-ff",
				"--no-edit",
				commit,
			],
			workspace.path,
			signal,
			120_000,
		);
	}
	/** The mutex survives a crashed owner. An operator must confirm process convergence before clearing it. */
	async withIntegrationLock<T>(workspace: Workspace, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
		const gitPath = (
			await execute("git", ["rev-parse", "--git-path", "pi861-integration.lock"], { cwd: workspace.path })
		).stdout.trim();
		const lock = resolve(workspace.path, gitPath);
		while (true) {
			signal.throwIfAborted();
			try {
				mkdirSync(lock, { mode: 0o700 });
				break;
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
				await sleep(100, undefined, { signal });
			}
		}
		try {
			writeFileSync(
				join(lock, "owner.json"),
				JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }),
				{ mode: 0o600 },
			);
			if (await this.locked(workspace)) throw new Error("Git index remains locked; reconcile the old process");
			return await work();
		} finally {
			rmSync(lock, { recursive: true });
		}
	}
	async assertBase(workspace: Workspace, expected: string): Promise<void> {
		const head = (await execute("git", ["rev-parse", "HEAD"], { cwd: workspace.path })).stdout.trim();
		const dirty = (await execute("git", ["status", "--porcelain"], { cwd: workspace.path })).stdout;
		if (head !== expected || dirty.trim())
			throw new Error("Integration workspace diverged from verified base; reconcile before merging");
	}
	/** Wait for close even after abort, including the owned process tree, before releasing the mutex. */
	private async runCommand(
		command: string,
		args: string[],
		cwd: string,
		signal: AbortSignal,
		timeoutMs: number,
		env: NodeJS.ProcessEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
	): Promise<{ stdout: string; stderr: string }> {
		signal.throwIfAborted();
		return new Promise((resolve, reject) => {
			const child = spawn(command, args, {
				cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
				shell: false,
			});
			let stdout = "",
				stderr = "",
				error: Error | undefined,
				termination: Promise<void> | undefined;
			const terminate = (): void => {
				if (termination) return;
				error ??= new Error("Command interrupted; workspace preserved");
				if (process.platform === "win32" && child.pid) {
					termination = execute("taskkill", ["/PID", String(child.pid), "/T", "/F"]).then(
						() => {},
						() => {
							child.kill();
						},
					);
				} else {
					try {
						if (child.pid) process.kill(-child.pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
					termination = Promise.resolve();
				}
			};
			const timer = setTimeout(terminate, timeoutMs);
			signal.addEventListener("abort", terminate, { once: true });
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString();
				if (Buffer.byteLength(stdout) > 4_194_304) terminate();
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString();
				if (Buffer.byteLength(stderr) > 4_194_304) terminate();
			});
			child.on("error", (failure) => {
				error = failure;
			});
			child.once("close", (code) => {
				clearTimeout(timer);
				signal.removeEventListener("abort", terminate);
				void (termination ?? Promise.resolve()).then(() => {
					if (error || code !== 0) reject(error ?? new Error(`Trusted command failed with exit ${code}`));
					else resolve({ stdout, stderr });
				});
			});
			if (signal.aborted) terminate();
		});
	}
	/**
	 * Best-effort probe for an unresolved git index lock (integration lease takeover grace, R3.9).
	 * Windows has no lsof/fuser; this plus the lease grace window and generation rejection is the
	 * three-layer defence against taking over while an old git process still writes.
	 */
	async locked(workspace: Workspace): Promise<boolean> {
		const relative = (
			await execute("git", ["rev-parse", "--git-path", "index.lock"], { cwd: workspace.path })
		).stdout.trim();
		return existsSync(resolve(workspace.path, relative));
	}
}
