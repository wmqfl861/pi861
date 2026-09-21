import { randomUUID } from "node:crypto";

export type TaskStatus = "queued" | "running" | "review" | "done" | "blocked";
export interface TaskSpec {
	id: string;
	title: string;
	dependsOn: string[];
	writeScopes: string[];
	capabilities: string[];
	acceptance: string[];
	priority?: number;
	retrySafe?: boolean;
}
export interface Lease {
	taskId: string;
	workerId: string;
	token: string;
	attempt: number;
}
export interface TaskRecord extends TaskSpec {
	status: TaskStatus;
	attempts: number;
	lease?: Lease;
	leaseUntil?: number;
	artifacts: string[];
	evidence: string[];
	reason?: string;
}
export interface BoardSnapshot { version: number; tasks: TaskRecord[]; }
export interface BoardOptions { maxConcurrent: number; maxAttempts: number; }

/** Path reservations are coordination hints, not an OS sandbox. */
export function normalizeScope(scope: string): string {
	const normalized = scope.replaceAll("\\", "/").replace(/\/+$/, "");
	if (normalized === ".") return ".";
	if (!normalized || normalized.startsWith("/") || normalized.includes(":") ||
		normalized.split("/").some((part) => !part || part === "." || part === "..")) {
		throw new Error("Write scopes must be canonical repository-relative paths");
	}
	return normalized;
}
export function scopesConflict(left: string[], right: string[]): boolean {
	return left.some((a) => right.some((b) => a === "." || b === "." ||
		a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
}
function busy(task: TaskRecord): boolean { return task.status === "running" || task.status === "review"; }

/**
 * Synchronous single-writer coordinator. persist() must commit before returning.
 * Do not put multiple instances over the same file; distributed ownership needs a server/DB transaction.
 */
export class TaskBoard {
	private snapshot: BoardSnapshot;
	private readonly options: BoardOptions;
	private readonly persist: (snapshot: BoardSnapshot) => void;
	constructor(options: BoardOptions, snapshot: BoardSnapshot = { version: 0, tasks: [] },
		persist: (snapshot: BoardSnapshot) => void = () => {}) {
		if (!Number.isSafeInteger(options.maxConcurrent) || options.maxConcurrent < 1 ||
			!Number.isSafeInteger(options.maxAttempts) || options.maxAttempts < 1) throw new Error("Invalid task limits");
		this.options = { ...options };
		if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 0) throw new Error("Invalid board revision");
		this.snapshot = structuredClone(snapshot);
		this.persist = persist;
		this.validate(this.snapshot.tasks);
	}
	get state(): BoardSnapshot { return structuredClone(this.snapshot); }
	private validate(tasks: TaskRecord[]): void {
		const byId = new Map<string, TaskRecord>();
		for (const task of tasks) {
			if (!task.id || !task.title.trim() || byId.has(task.id) || !task.acceptance.length ||
				task.acceptance.some((item) => !item.trim()) ||
				!Number.isSafeInteger(task.attempts) || task.attempts < 0 ||
				!["queued", "running", "review", "done", "blocked"].includes(task.status)) {
				throw new Error("Invalid or duplicate task");
			}
			if (task.writeScopes.some((scope) => normalizeScope(scope) !== scope)) throw new Error("Noncanonical write scope");
			if (busy(task) && (!task.lease || !Number.isFinite(task.leaseUntil))) throw new Error("Missing execution lease");
			byId.set(task.id, task);
		}
		const visiting = new Set<string>();
		const visited = new Set<string>();
		const visit = (id: string): void => {
			if (visiting.has(id)) throw new Error("Dependency cycle");
			if (visited.has(id)) return;
			const task = byId.get(id);
			if (!task) throw new Error(`Unknown dependency: ${id}`);
			visiting.add(id);
			task.dependsOn.forEach(visit);
			visiting.delete(id);
			visited.add(id);
		};
		tasks.forEach((task) => visit(task.id));
	}
	private commit(tasks: TaskRecord[]): void {
		this.validate(tasks);
		const next = { version: this.snapshot.version + 1, tasks };
		this.persist(structuredClone(next));
		this.snapshot = next;
	}
	add(specs: TaskSpec[]): void {
		const records: TaskRecord[] = specs.map((spec) => ({
			...structuredClone(spec), writeScopes: spec.writeScopes.map(normalizeScope),
			status: "queued", attempts: 0, artifacts: [], evidence: [],
		}));
		this.commit([...structuredClone(this.snapshot.tasks), ...records]);
	}
	private owned(tasks: TaskRecord[], lease: Lease, now: number): TaskRecord {
		const task = tasks.find((candidate) => candidate.id === lease.taskId);
		if (!task || !busy(task) || task.lease?.token !== lease.token ||
			task.lease.attempt !== lease.attempt || task.lease.workerId !== lease.workerId ||
			(task.leaseUntil ?? 0) <= now) throw new Error("Stale or expired execution lease");
		return task;
	}
	claim(workerId: string, capabilities: string[], now: number, leaseMs: number): TaskRecord | undefined {
		if (!workerId || !Number.isSafeInteger(leaseMs) || leaseMs <= 0 || !Number.isFinite(now)) {
			throw new Error("Invalid worker or lease");
		}
		const tasks = structuredClone(this.snapshot.tasks);
		const running = tasks.filter(busy);
		if (running.length >= this.options.maxConcurrent || running.some((task) => task.lease?.workerId === workerId)) {
			return undefined;
		}
		const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
		const ready = tasks.filter((task) => task.status === "queued" &&
			task.attempts < this.options.maxAttempts && task.dependsOn.every((id) => done.has(id)) &&
			task.capabilities.every((capability) => capabilities.includes(capability)) &&
			!running.some((active) => scopesConflict(active.writeScopes, task.writeScopes)))
			.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
		const task = ready[0];
		if (!task) return undefined;
		task.attempts++;
		task.status = "running";
		task.leaseUntil = now + leaseMs;
		task.lease = { taskId: task.id, workerId, token: randomUUID(), attempt: task.attempts };
		this.commit(tasks);
		return structuredClone(task);
	}
	heartbeat(lease: Lease, now: number, leaseMs: number): void {
		if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("Invalid heartbeat duration");
		const tasks = structuredClone(this.snapshot.tasks);
		this.owned(tasks, lease, now).leaseUntil = now + leaseMs;
		this.commit(tasks);
	}
	submit(lease: Lease, artifacts: string[], now: number): void {
		if (!artifacts.length || artifacts.some((artifact) => !artifact.trim())) throw new Error("Missing artifacts");
		const tasks = structuredClone(this.snapshot.tasks);
		const task = this.owned(tasks, lease, now);
		if (task.status !== "running") throw new Error("Task already submitted");
		task.status = "review";
		task.artifacts = [...artifacts];
		this.commit(tasks);
	}
	/** Only a trusted verifier/integration service should call accept(). */
	accept(lease: Lease, evidence: string[], now: number): void {
		if (!evidence.length || evidence.some((item) => !item.trim())) throw new Error("Missing verification evidence");
		const tasks = structuredClone(this.snapshot.tasks);
		const task = this.owned(tasks, lease, now);
		if (task.status !== "review") throw new Error("Task has not been submitted");
		task.status = "done";
		task.evidence = [...evidence];
		delete task.lease;
		delete task.leaseUntil;
		delete task.reason;
		this.commit(tasks);
	}
	block(lease: Lease, reason: string, now: number): void {
		const tasks = structuredClone(this.snapshot.tasks);
		const task = this.owned(tasks, lease, now);
		task.status = "blocked";
		task.reason = reason;
		delete task.lease;
		delete task.leaseUntil;
		this.commit(tasks);
	}
	recoverExpired(now: number): number {
		const tasks = structuredClone(this.snapshot.tasks);
		let recovered = 0;
		for (const task of tasks) {
			if (!busy(task) || (task.leaseUntil ?? 0) > now) continue;
			task.status = task.retrySafe && task.attempts < this.options.maxAttempts ? "queued" : "blocked";
			task.reason = task.status === "queued" ? "Lease expired; retry permitted" : "Execution outcome requires reconciliation";
			delete task.lease;
			delete task.leaseUntil;
			recovered++;
		}
		if (recovered) this.commit(tasks);
		return recovered;
	}
}

export interface Worker {
	id: string;
	capabilities: string[];
	run: (task: TaskRecord, signal: AbortSignal) => Promise<string[]>;
}
export interface Verification { accepted: boolean; evidence: string[]; reason?: string; }

/**
 * Completion-driven refill: each independently verified result immediately unlocks dependencies.
 * Workers are injected; no claim that this class provides network transport or process isolation.
 */
export async function drainReadyTasks(
	board: TaskBoard, workers: Worker[],
	verify: (task: TaskRecord, artifacts: string[], signal: AbortSignal) => Promise<Verification>,
	options: { signal: AbortSignal; leaseMs?: number; now?: () => number },
): Promise<BoardSnapshot> {
	if (new Set(workers.map((worker) => worker.id)).size !== workers.length) throw new Error("Duplicate worker id");
	const now = options.now ?? Date.now;
	const leaseMs = options.leaseMs ?? 60_000;
	const running = new Map<string, Promise<void>>();
	const errors: unknown[] = [];
	const run = async (worker: Worker, task: TaskRecord): Promise<void> => {
		const lease = task.lease;
		if (!lease) throw new Error("Claim produced no lease");
		const controller = new AbortController();
		const signal = AbortSignal.any([options.signal, controller.signal]);
		const timer = setInterval(() => {
			try { board.heartbeat(lease, now(), leaseMs); }
			catch (error) { controller.abort(error); }
		}, Math.max(1, Math.floor(leaseMs / 3)));
		let abortListener: (() => void) | undefined;
		const interrupt = new Promise<never>((_resolve, reject) => {
			abortListener = () => reject(signal.reason);
			signal.addEventListener("abort", abortListener, { once: true });
			if (signal.aborted) abortListener();
		});
		try {
			const artifacts = await Promise.race([worker.run(task, signal), interrupt]);
			signal.throwIfAborted();
			board.submit(lease, artifacts, now());
			const result = await Promise.race([verify(task, artifacts, signal), interrupt]);
			signal.throwIfAborted();
			if (result.accepted) board.accept(lease, result.evidence, now());
			else board.block(lease, result.reason ?? "Verification rejected", now());
		} catch (error) {
			// Unknown worker failures are NOT automatically replayed: tools may already have run.
			try { board.block(lease, signal.aborted ? "Interrupted; reconcile before retry" : "Worker or verifier failed", now()); }
			catch (storageError) { errors.push(storageError); }
		} finally {
			clearInterval(timer);
			if (abortListener) signal.removeEventListener("abort", abortListener);
		}
	};
	while (true) {
		if (!options.signal.aborted && errors.length === 0) {
			for (const worker of workers) {
				if (running.has(worker.id)) continue;
				let task: TaskRecord | undefined;
				try { task = board.claim(worker.id, worker.capabilities, now(), leaseMs); }
				catch (error) { errors.push(error); break; }
				if (task) {
					const promise = run(worker, task).finally(() => running.delete(worker.id));
					running.set(worker.id, promise);
				}
			}
		}
		if (running.size === 0) break;
		await Promise.race(running.values());
	}
	if (errors.length) throw new AggregateError(errors, "Coordinator state could not be committed");
	options.signal.throwIfAborted();
	return board.state;
}
