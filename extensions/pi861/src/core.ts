/**
 * Pi861 platform primitives. No providers, network calls or timers at import.
 * Host adapters own authentication; callers never choose their own authority.
 */
import { createHash, randomUUID } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Mode = "direct" | "fixed" | "dynamic";
export type GoalStatus = "draft" | "active" | "paused" | "blocked" | "completed" | "cancelled";
export type TaskStatus = "pending" | "running" | "review" | "completed" | "blocked" | "cancelled";
export type MemoryKind = "preference" | "working" | "decision" | "lesson" | "evidence";
export type MemoryStatus = "candidate" | "confirmed" | "withdrawn";

export class PlatformError extends Error {
	readonly code: string;
	constructor(code: string, message: string) {
		super(message);
		this.name = "PlatformError";
		this.code = code;
	}
}

export function requireCondition(condition: unknown, code: string, message: string): asserts condition {
	if (!condition) throw new PlatformError(code, message);
}

export function nonempty(value: unknown, name: string, max = 20_000): string {
	requireCondition(
		typeof value === "string" && value.trim().length > 0 && value.length <= max,
		"INVALID_INPUT",
		`${name} must be a nonempty string of at most ${max} characters`,
	);
	return value.trim();
}

export function positive(value: number, name: string): number {
	requireCondition(Number.isSafeInteger(value) && value > 0, "INVALID_INPUT", `${name} must be a positive integer`);
	return value;
}

export function clone<T>(value: T): T {
	return structuredClone(value);
}

export function digest(value: unknown): string {
	const canonical = (input: unknown): unknown => {
		if (Array.isArray(input)) return input.map(canonical);
		if (input && typeof input === "object") {
			return Object.fromEntries(
				Object.entries(input)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, item]) => [key, canonical(item)]),
			);
		}
		return input;
	};
	return createHash("sha256")
		.update(JSON.stringify(canonical(value)))
		.digest("hex");
}

export function id(prefix: string): string {
	return `${prefix}_${randomUUID()}`;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new PlatformError("CANCELLED", "Operation cancelled");
}

export function normalizeScope(scope: string): string {
	nonempty(scope, "write scope", 2048);
	const normalized = scope.replaceAll("\\", "/").replace(/\/$/, "");
	requireCondition(
		!normalized.startsWith("/") &&
			!normalized.includes(":") &&
			!normalized.split("/").some((part) => part === ".." || part === "." || part === ""),
		"INVALID_SCOPE",
		"Write scopes must be normalized relative paths; use * for the whole workspace",
	);
	return normalized;
}

export function overlaps(a: string, b: string): boolean {
	return a === "*" || b === "*" || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export interface Authority {
	principalId: string;
	projectId: string;
	agentId: string;
	role: string;
	/** Supplied by trusted host configuration, never by a model tool argument. */
	grants: string[];
	readableScopes: string[];
	writableScopes: string[];
}

export interface Evidence {
	id: string;
	kind: "test" | "artifact" | "review";
	reference: string;
	passed: boolean;
	/** A host-generated verifier identity, not an assistant claim. */
	verifier: string;
}

export interface TaskSpec {
	id: string;
	title: string;
	instructions: string;
	dependsOn: string[];
	writeScopes: string[];
	role: string;
	skillIds: string[];
	minimumTier: number;
	requiredCapabilities: string[];
	acceptance: string[];
	/** User-approved verifier keys, resolved to commands by trusted config. */
	checks: string[];
	mode?: Mode;
}
export interface Task extends TaskSpec {
	status: TaskStatus;
	attempt: number;
	maxAttempts: number;
	lease?: { token: string; workerId: string; expiresAt: number };
	result?: string;
	evidence: Evidence[];
	blockedReason?: string;
	artifact?: string;
}

export interface Goal {
	id: string;
	objective: string;
	status: GoalStatus;
	planRevision: number;
	planValidated: boolean;
	tasks: Task[];
	maxConcurrent: number;
	maxAttempts: number;
	attemptsStarted: number;
	createdAt: number;
	updatedAt: number;
	notes: string[];
}

export interface MemoryRecord {
	id: string;
	key: string;
	scope: string;
	kind: MemoryKind;
	text: string;
	overview: string;
	abstract: string;
	sourceIds: string[];
	status: MemoryStatus;
	revision: number;
	createdAt: number;
	updatedAt: number;
	expiresAt?: number;
	replaces?: string;
}

export interface SourceEvent {
	id: string;
	origin: "user" | "tool" | "assistant" | "memory";
	text: string;
	scope: string;
	createdAt: number;
}
export interface MemoryReceipt {
	fingerprint: string;
	recordId: string;
	revision: number;
	status: "committed";
}
export interface BudgetRecord {
	requests: number;
	chargedTokens: number;
	reservations: Record<string, { ceiling: number; settled: boolean }>;
}
export interface EffectRecord {
	id: string;
	taskId: string;
	attemptToken: string;
	tool: string;
	argumentsHash: string;
	status: "started" | "completed" | "unknown";
	updatedAt: number;
}
export interface PlatformState {
	version: 1;
	projectId: string;
	revision: number;
	focusedGoalId?: string;
	goals: Goal[];
	memory: MemoryRecord[];
	memoryHistory: MemoryRecord[];
	sources: SourceEvent[];
	receipts: Record<string, MemoryReceipt>;
	/** Content signatures suppress ingestion of withdrawn source/key/text. */
	withdrawals: string[];
	budgets: Record<string, BudgetRecord>;
	effects: Record<string, EffectRecord>;
}
export function emptyState(projectId: string): PlatformState {
	return {
		version: 1,
		projectId: nonempty(projectId, "projectId", 200),
		revision: 0,
		goals: [],
		memory: [],
		memoryHistory: [],
		sources: [],
		receipts: {},
		withdrawals: [],
		budgets: {},
		effects: {},
	};
}

export function validateState(value: unknown, projectId: string): asserts value is PlatformState {
	requireCondition(value !== null && typeof value === "object", "CORRUPT_STATE", "Invalid state document");
	const state = value as Partial<PlatformState>;
	requireCondition(
		state.version === 1 &&
			state.projectId === projectId &&
			Number.isSafeInteger(state.revision) &&
			(state.revision ?? -1) >= 0 &&
			Array.isArray(state.goals) &&
			Array.isArray(state.memory) &&
			Array.isArray(state.memoryHistory) &&
			Array.isArray(state.sources) &&
			Array.isArray(state.withdrawals) &&
			state.receipts !== null &&
			typeof state.receipts === "object" &&
			!Array.isArray(state.receipts) &&
			!!state.budgets &&
			typeof state.budgets === "object" &&
			!!state.effects &&
			typeof state.effects === "object",
		"CORRUPT_STATE",
		"State version, project or shape mismatch",
	);
}

/** Serializes only short in-process critical sections; never hold while calling a model. */
export class Mutex {
	private tail: Promise<void> = Promise.resolve();
	async run<T>(action: () => Promise<T> | T): Promise<T> {
		const previous = this.tail;
		let release!: () => void;
		this.tail = new Promise<void>((resolve) => {
			release = resolve;
		});
		await previous;
		try {
			return await action();
		} finally {
			release();
		}
	}
}
