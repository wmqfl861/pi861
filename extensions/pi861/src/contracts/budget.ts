import { randomUUID } from "node:crypto";

/**
 * C3 budget contract: whole-task-tree capacity with reserve-then-settle metering for every
 * actual model attempt - execution, reception, planning, skill compilation, memory distillation,
 * health probes and auxiliary calls. Unknown usage is recorded as unknown with a bounded
 * conservative booking; it is never silently written down as zero.
 */

export type MeteredKind = "execution" | "reception" | "planning" | "skill-compile" | "distill" | "probe" | "auxiliary";

export interface UsageMeasure {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	costUsd: number;
}

export interface BudgetLimits {
	maxTotalCostUsd: number;
	maxAttempts: number;
	maxInputTokens: number;
	maxOutputTokens: number;
}

export interface UsageReservation {
	reservationId: string;
	taskId: string | null;
	kind: MeteredKind;
	estimate: UsageMeasure;
	openedAt: number;
	state: "reserved" | "settled" | "settled-unknown" | "released";
	/** Single-flight key: while one reservation with this key stays open, no other may exist. */
	probeKey?: string;
}

export interface TaskUsageSummary {
	taskId: string;
	parentTaskId: string | null;
	limits?: BudgetLimits;
	attempts: number;
	usage: UsageMeasure;
	unknownSettlements: number;
}

export class BudgetExhausted extends Error {
	readonly scope: string;
	readonly limits: BudgetLimits;
	readonly requested: UsageMeasure;
	constructor(scope: string, limits: BudgetLimits, requested: UsageMeasure) {
		super(`Budget exhausted at ${scope}`);
		this.scope = scope;
		this.limits = { ...limits };
		this.requested = { ...requested };
	}
}

/**
 * A physical probe is already reserved: the caller must wait for the in-flight reservation's
 * settlement instead of booking a second reservation for the same probe. This is the frozen
 * single-flight cost rule - one physical probe bills exactly once (R2.6).
 */
export class ProbeInFlight extends Error {
	readonly probeKey: string;
	constructor(probeKey: string) {
		super(`A probe is already in flight for ${probeKey}`);
		this.probeKey = probeKey;
	}
}

const ZERO_USAGE: UsageMeasure = {
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	costUsd: 0,
};

function validateUsage(usage: UsageMeasure): void {
	for (const value of [
		usage.inputTokens,
		usage.outputTokens,
		usage.cacheReadTokens,
		usage.cacheWriteTokens,
		usage.costUsd,
	]) {
		if (!Number.isFinite(value) || value < 0) throw new Error("Usage measures must be finite and non-negative");
	}
}

function isZero(usage: UsageMeasure): boolean {
	return (
		usage.inputTokens === 0 &&
		usage.outputTokens === 0 &&
		usage.cacheReadTokens === 0 &&
		usage.cacheWriteTokens === 0 &&
		usage.costUsd === 0
	);
}

function addUsage(target: UsageMeasure, addition: UsageMeasure): void {
	target.inputTokens += addition.inputTokens;
	target.outputTokens += addition.outputTokens;
	target.cacheReadTokens += addition.cacheReadTokens;
	target.cacheWriteTokens += addition.cacheWriteTokens;
	target.costUsd += addition.costUsd;
}

function validateLimits(limits: BudgetLimits): void {
	for (const value of [limits.maxTotalCostUsd, limits.maxInputTokens, limits.maxOutputTokens]) {
		if (!Number.isFinite(value) || value < 0) throw new Error("Budget limits must be finite and non-negative");
	}
	if (!Number.isSafeInteger(limits.maxAttempts) || limits.maxAttempts < 1)
		throw new Error("Attempt limit must be a positive integer");
}

interface TaskNode {
	taskId: string;
	parentTaskId: string | null;
	limits?: BudgetLimits;
	attempts: number;
	usage: UsageMeasure;
	unknownSettlements: number;
}

/**
 * Single-owner budget authority for one goal/task tree. registerTask() before reserving against
 * a task; null taskId reserves meter tree-level work (reception, probes, tree-wide planning).
 * Settled usage of a descendant rolls up into every ancestor and the root, so a subtree limit
 * constrains the whole subtree without double counting at the root.
 */
export class TaskTreeBudget {
	private readonly tasks = new Map<string, TaskNode>();
	private readonly reservations = new Map<string, UsageReservation>();
	private readonly rootLimits: BudgetLimits;
	private readonly rootUsage: UsageMeasure = { ...ZERO_USAGE };
	private rootAttempts = 0;
	private rootUnknown = 0;
	private reservationSequence = 0;
	private budgetIdValue: string;

	/** Root budget identity: durable stores key reservations and snapshots by this id. */
	get budgetId(): string {
		return this.budgetIdValue;
	}

	constructor(rootLimits: BudgetLimits, options: { budgetId?: string } = {}) {
		validateLimits(rootLimits);
		if (options.budgetId !== undefined && (!options.budgetId || options.budgetId.length > 200)) {
			throw new Error("Invalid budget identity");
		}
		this.rootLimits = { ...rootLimits };
		this.budgetIdValue = options.budgetId ?? `budget-${randomUUID()}`;
	}

	registerTask(taskId: string, parentTaskId: string | null, subtreeLimits?: BudgetLimits): void {
		if (!taskId || taskId.length > 200 || this.tasks.has(taskId))
			throw new Error("Invalid or duplicate task registration");
		if (parentTaskId !== null && !this.tasks.has(parentTaskId)) throw new Error("Unknown parent task");
		if (subtreeLimits) validateLimits(subtreeLimits);
		this.tasks.set(taskId, {
			taskId,
			parentTaskId,
			limits: subtreeLimits ? { ...subtreeLimits } : undefined,
			attempts: 0,
			usage: { ...ZERO_USAGE },
			unknownSettlements: 0,
		});
	}

	private chainFrom(taskId: string | null): TaskNode[] {
		const chain: TaskNode[] = [];
		let current = taskId === null ? undefined : this.tasks.get(taskId);
		if (taskId !== null && !current) throw new Error("Unknown task; register it before reserving");
		while (current) {
			chain.push(current);
			current = current.parentTaskId === null ? undefined : this.tasks.get(current.parentTaskId);
		}
		return chain;
	}

	private withinScope(nodeId: string | "root", reservation: UsageReservation): boolean {
		if (nodeId === "root") return true;
		if (reservation.taskId === null) return false;
		let current = this.tasks.get(reservation.taskId);
		while (current) {
			if (current.taskId === nodeId) return true;
			current = current.parentTaskId === null ? undefined : this.tasks.get(current.parentTaskId);
		}
		return false;
	}

	/**
	 * Reserves capacity before the request is dispatched; throws BudgetExhausted when any bound
	 * would be crossed. A probe with a probeKey throws ProbeInFlight while an equal probeKey is
	 * still open - shared probes join the in-flight reservation, they never book a second one.
	 */
	reserve(
		taskId: string | null,
		kind: MeteredKind,
		estimate: UsageMeasure,
		now: number,
		options: { probeKey?: string } = {},
	): UsageReservation {
		validateUsage(estimate);
		if (!Number.isFinite(now)) throw new Error("Invalid reservation time");
		if (options.probeKey !== undefined) {
			if (kind !== "probe") throw new Error("Only probe reservations carry a probe key");
			if (!options.probeKey || options.probeKey.length > 200) throw new Error("Invalid probe key");
			for (const reservation of this.reservations.values()) {
				if (reservation.state === "reserved" && reservation.probeKey === options.probeKey) {
					throw new ProbeInFlight(options.probeKey);
				}
			}
		}
		const chain = this.chainFrom(taskId);
		for (const node of chain) {
			const limits = node.limits;
			if (!limits) continue;
			this.checkBounds(`task:${node.taskId}`, limits, node.attempts, node.usage, node.taskId, estimate);
		}
		this.checkBounds("tree", this.rootLimits, this.rootAttempts, this.rootUsage, "root", estimate);
		const reservation: UsageReservation = {
			reservationId: `r-${++this.reservationSequence}`,
			taskId,
			kind,
			estimate: { ...estimate },
			openedAt: now,
			state: "reserved",
			...(options.probeKey !== undefined ? { probeKey: options.probeKey } : {}),
		};
		this.reservations.set(reservation.reservationId, reservation);
		return structuredClone(reservation);
	}

	private checkBounds(
		scope: string,
		limits: BudgetLimits,
		committedAttempts: number,
		committedUsage: UsageMeasure,
		scopeId: string | "root",
		estimate: UsageMeasure,
	): void {
		const held: UsageMeasure = { ...ZERO_USAGE };
		let openAttempts = 0;
		for (const reservation of this.reservations.values()) {
			if (reservation.state !== "reserved" || !this.withinScope(scopeId, reservation)) continue;
			addUsage(held, reservation.estimate);
			openAttempts++;
		}
		const projectedInput =
			committedUsage.inputTokens +
			committedUsage.cacheReadTokens +
			held.inputTokens +
			held.cacheReadTokens +
			estimate.inputTokens +
			estimate.cacheReadTokens;
		const projectedOutput = committedUsage.outputTokens + held.outputTokens + estimate.outputTokens;
		const projectedCost = committedUsage.costUsd + held.costUsd + estimate.costUsd;
		const projectedAttempts = committedAttempts + openAttempts + 1;
		if (
			projectedInput > limits.maxInputTokens ||
			projectedOutput > limits.maxOutputTokens ||
			projectedCost > limits.maxTotalCostUsd ||
			projectedAttempts > limits.maxAttempts
		) {
			throw new BudgetExhausted(scope, limits, estimate);
		}
	}

	private book(reservation: UsageReservation, amount: UsageMeasure, unknown: boolean): void {
		for (const node of this.chainFrom(reservation.taskId)) {
			node.attempts++;
			addUsage(node.usage, amount);
			if (unknown) node.unknownSettlements++;
		}
		this.rootAttempts++;
		addUsage(this.rootUsage, amount);
		if (unknown) this.rootUnknown++;
		reservation.state = unknown ? "settled-unknown" : "settled";
	}

	/** Settles a completed attempt with the provider-reported usage. */
	settle(reservationId: string, actual: UsageMeasure): void {
		const reservation = this.requireReservation(reservationId);
		validateUsage(actual);
		this.book(reservation, actual, false);
	}

	/** Unknown usage books a bounded conservative estimate and stays flagged for reconciliation; never zero. */
	settleUnknown(reservationId: string, conservativeEstimate: UsageMeasure): void {
		const reservation = this.requireReservation(reservationId);
		validateUsage(conservativeEstimate);
		if (isZero(conservativeEstimate)) throw new Error("Unknown usage cannot be booked as zero");
		this.book(reservation, conservativeEstimate, true);
	}

	/** Releases a reservation that was never dispatched; no attempt is consumed. */
	release(reservationId: string): void {
		const reservation = this.requireReservation(reservationId);
		reservation.state = "released";
	}

	private requireReservation(reservationId: string): UsageReservation {
		const reservation = this.reservations.get(reservationId);
		if (!reservation || reservation.state !== "reserved") throw new Error(`No open reservation: ${reservationId}`);
		return reservation;
	}

	get usage(): { attempts: number; usage: UsageMeasure; unknownSettlements: number } {
		return { attempts: this.rootAttempts, usage: { ...this.rootUsage }, unknownSettlements: this.rootUnknown };
	}

	taskSummary(taskId: string): TaskUsageSummary {
		const node = this.tasks.get(taskId);
		if (!node) throw new Error(`Unknown task: ${taskId}`);
		return {
			taskId,
			parentTaskId: node.parentTaskId,
			limits: node.limits ? { ...node.limits } : undefined,
			attempts: node.attempts,
			usage: { ...node.usage },
			unknownSettlements: node.unknownSettlements,
		};
	}

	openReservations(): UsageReservation[] {
		return [...this.reservations.values()]
			.filter((reservation) => reservation.state === "reserved")
			.map((reservation) => structuredClone(reservation));
	}

	exportState(): {
		version: 2;
		budgetId: string;
		rootLimits: BudgetLimits;
		rootAttempts: number;
		rootUsage: UsageMeasure;
		rootUnknown: number;
		tasks: TaskUsageSummary[];
		reservations: UsageReservation[];
	} {
		return {
			version: 2,
			budgetId: this.budgetId,
			rootLimits: { ...this.rootLimits },
			rootAttempts: this.rootAttempts,
			rootUsage: { ...this.rootUsage },
			rootUnknown: this.rootUnknown,
			tasks: [...this.tasks.keys()].map((taskId) => this.taskSummary(taskId)),
			reservations: [...this.reservations.values()].map((reservation) => structuredClone(reservation)),
		};
	}

	restore(snapshot: ReturnType<TaskTreeBudget["exportState"]>): void {
		if (
			snapshot.version !== 2 ||
			typeof snapshot.budgetId !== "string" ||
			!snapshot.budgetId ||
			snapshot.budgetId.length > 200 ||
			!Number.isSafeInteger(snapshot.rootAttempts) ||
			snapshot.rootAttempts < 0 ||
			!Array.isArray(snapshot.tasks) ||
			!Array.isArray(snapshot.reservations)
		)
			throw new Error("Invalid budget snapshot");
		validateLimits(snapshot.rootLimits);
		validateUsage(snapshot.rootUsage);
		const seen = new Set<string>();
		for (const task of snapshot.tasks) {
			if (
				!task.taskId ||
				seen.has(task.taskId) ||
				!Number.isSafeInteger(task.attempts) ||
				task.attempts < 0 ||
				!Number.isSafeInteger(task.unknownSettlements) ||
				task.unknownSettlements < 0 ||
				(task.parentTaskId !== null && !snapshot.tasks.some((other) => other.taskId === task.parentTaskId))
			) {
				throw new Error("Invalid task usage snapshot");
			}
			validateUsage(task.usage);
			if (task.limits) validateLimits(task.limits);
			seen.add(task.taskId);
		}
		const reservations = new Map<string, UsageReservation>();
		let sequence = 0;
		const openProbeKeys = new Set<string>();
		for (const reservation of snapshot.reservations) {
			const match = /^r-([1-9][0-9]*)$/.exec(reservation.reservationId);
			const number = Number(match?.[1]);
			if (
				!Number.isSafeInteger(number) ||
				reservations.has(reservation.reservationId) ||
				!Number.isFinite(reservation.openedAt) ||
				!["reserved", "settled", "settled-unknown", "released"].includes(reservation.state) ||
				!["execution", "reception", "planning", "skill-compile", "distill", "probe", "auxiliary"].includes(
					reservation.kind,
				) ||
				(reservation.taskId !== null && !seen.has(reservation.taskId)) ||
				(reservation.probeKey !== undefined &&
					(reservation.kind !== "probe" ||
						typeof reservation.probeKey !== "string" ||
						!reservation.probeKey ||
						reservation.probeKey.length > 200))
			)
				throw new Error("Invalid reservation snapshot");
			if (reservation.state === "reserved" && reservation.probeKey !== undefined) {
				if (openProbeKeys.has(reservation.probeKey)) throw new Error("Invalid reservation snapshot");
				openProbeKeys.add(reservation.probeKey);
			}
			validateUsage(reservation.estimate);
			reservations.set(reservation.reservationId, structuredClone(reservation));
			sequence = Math.max(sequence, number);
		}
		for (const task of snapshot.tasks) {
			const ancestors = new Set<string>([task.taskId]);
			let parent = task.parentTaskId;
			while (parent !== null) {
				if (ancestors.has(parent)) throw new Error("Invalid cyclic task usage snapshot");
				ancestors.add(parent);
				parent = snapshot.tasks.find((node) => node.taskId === parent)?.parentTaskId ?? null;
			}
		}
		if (
			!Number.isSafeInteger(snapshot.rootUnknown) ||
			snapshot.rootUnknown < 0 ||
			snapshot.rootUnknown > snapshot.rootAttempts
		) {
			throw new Error("Invalid unknown usage snapshot");
		}
		this.tasks.clear();
		this.reservations.clear();
		for (const task of snapshot.tasks) {
			this.tasks.set(task.taskId, {
				taskId: task.taskId,
				parentTaskId: task.parentTaskId,
				limits: task.limits ? { ...task.limits } : undefined,
				attempts: task.attempts,
				usage: { ...task.usage },
				unknownSettlements: task.unknownSettlements,
			});
		}
		Object.assign(this.rootLimits, snapshot.rootLimits);
		Object.assign(this.rootUsage, snapshot.rootUsage);
		this.rootAttempts = snapshot.rootAttempts;
		this.rootUnknown = snapshot.rootUnknown;
		for (const [id, reservation] of reservations) this.reservations.set(id, reservation);
		this.reservationSequence = sequence;
		this.budgetIdValue = snapshot.budgetId;
	}
}

/** R3.1 frozen scheduling defaults; every value is overridable through layered configuration. */
export interface SchedulingDefaults {
	maxConcurrentTasks: number;
	attemptsPerTask: number;
	maxProjectTasks: number;
}

export const DEFAULT_SCHEDULING: SchedulingDefaults = {
	maxConcurrentTasks: 2,
	attemptsPerTask: 2,
	maxProjectTasks: 100,
};

export class CapacityExhausted extends Error {
	readonly taskId: string;
	readonly runningCount: number;
	readonly maxConcurrentTasks: number;
	constructor(taskId: string, runningCount: number, maxConcurrentTasks: number) {
		super(`Task capacity exhausted for ${taskId}`);
		this.taskId = taskId;
		this.runningCount = runningCount;
		this.maxConcurrentTasks = maxConcurrentTasks;
	}
}

export type TaskSlotState = "registered" | "running" | "waiting" | "finished";

export interface TaskSlotSummary {
	taskId: string;
	parentTaskId: string | null;
	state: TaskSlotState;
	since: number;
}

/**
 * C3 task capacity: whole-tree slot accounting. A slot is held only while the task runs; a
 * parent waiting on descendants releases its slot, but every descendant still competes for the
 * same root concurrency cap (R3.6). Finished tasks free their slot and stay counted toward the
 * project task total. The scheduler (P2-G) owns WHEN to start; this contract owns the bound.
 */
export class TaskTreeCapacity {
	private maxConcurrentTasksValue: number;
	private maxProjectTasksValue: number;
	private readonly slots = new Map<string, { parentTaskId: string | null; state: TaskSlotState; since: number }>();

	constructor(options: { maxConcurrentTasks?: number; maxProjectTasks?: number } = {}) {
		const maxConcurrentTasks = options.maxConcurrentTasks ?? DEFAULT_SCHEDULING.maxConcurrentTasks;
		const maxProjectTasks = options.maxProjectTasks ?? DEFAULT_SCHEDULING.maxProjectTasks;
		if (!Number.isSafeInteger(maxConcurrentTasks) || maxConcurrentTasks < 1)
			throw new Error("Invalid concurrency limit");
		if (!Number.isSafeInteger(maxProjectTasks) || maxProjectTasks < 1)
			throw new Error("Invalid project task limit");
		this.maxConcurrentTasksValue = maxConcurrentTasks;
		this.maxProjectTasksValue = maxProjectTasks;
	}

	get maxConcurrentTasks(): number {
		return this.maxConcurrentTasksValue;
	}

	get maxProjectTasks(): number {
		return this.maxProjectTasksValue;
	}

	get runningCount(): number {
		let running = 0;
		for (const slot of this.slots.values()) if (slot.state === "running") running++;
		return running;
	}

	registerTask(taskId: string, parentTaskId: string | null): void {
		if (!taskId || taskId.length > 200 || this.slots.has(taskId))
			throw new Error("Invalid or duplicate task registration");
		if (parentTaskId !== null && !this.slots.has(parentTaskId)) throw new Error("Unknown parent task");
		if (this.slots.size >= this.maxProjectTasksValue) throw new Error("Project task limit reached");
		this.slots.set(taskId, { parentTaskId, state: "registered", since: 0 });
	}

	/** Acquires - or after waiting re-acquires - one of the tree-wide concurrent slots. */
	start(taskId: string, now: number): void {
		const slot = this.require(taskId, now);
		if (slot.state !== "registered" && slot.state !== "waiting")
			throw new Error(`Task ${taskId} cannot start from ${slot.state}`);
		if (this.runningCount >= this.maxConcurrentTasksValue)
			throw new CapacityExhausted(taskId, this.runningCount, this.maxConcurrentTasksValue);
		slot.state = "running";
		slot.since = now;
	}

	/** A parent waiting on descendants releases its slot; descendants still share the root cap. */
	beginWaiting(taskId: string, now: number): void {
		const slot = this.require(taskId, now);
		if (slot.state !== "running") throw new Error(`Only a running task can wait: ${taskId}`);
		slot.state = "waiting";
		slot.since = now;
	}

	finish(taskId: string, now: number): void {
		const slot = this.require(taskId, now);
		if (slot.state === "finished") throw new Error(`Task ${taskId} already finished`);
		slot.state = "finished";
		slot.since = now;
	}

	slotSummary(taskId: string): TaskSlotSummary {
		const slot = this.slots.get(taskId);
		if (!slot) throw new Error(`Unknown task: ${taskId}`);
		return { taskId, parentTaskId: slot.parentTaskId, state: slot.state, since: slot.since };
	}

	exportState(): { version: 1; maxConcurrentTasks: number; maxProjectTasks: number; slots: TaskSlotSummary[] } {
		return {
			version: 1,
			maxConcurrentTasks: this.maxConcurrentTasksValue,
			maxProjectTasks: this.maxProjectTasksValue,
			slots: [...this.slots.keys()].map((taskId) => this.slotSummary(taskId)),
		};
	}

	restore(snapshot: ReturnType<TaskTreeCapacity["exportState"]>): void {
		if (
			snapshot.version !== 1 ||
			!Number.isSafeInteger(snapshot.maxConcurrentTasks) ||
			snapshot.maxConcurrentTasks < 1 ||
			!Number.isSafeInteger(snapshot.maxProjectTasks) ||
			snapshot.maxProjectTasks < 1 ||
			!Array.isArray(snapshot.slots) ||
			snapshot.slots.length > snapshot.maxProjectTasks
		)
			throw new Error("Invalid capacity snapshot");
		const restored = new Map<string, { parentTaskId: string | null; state: TaskSlotState; since: number }>();
		for (const slot of snapshot.slots) {
			if (
				!slot.taskId ||
				slot.taskId.length > 200 ||
				restored.has(slot.taskId) ||
				!["registered", "running", "waiting", "finished"].includes(slot.state) ||
				!Number.isFinite(slot.since) ||
				(slot.state === "registered" && slot.since !== 0)
			)
				throw new Error("Invalid capacity snapshot entry");
			restored.set(slot.taskId, { parentTaskId: slot.parentTaskId, state: slot.state, since: slot.since });
		}
		for (const slot of snapshot.slots) {
			if (slot.parentTaskId !== null && !restored.has(slot.parentTaskId))
				throw new Error("Invalid capacity snapshot entry");
		}
		for (const slot of snapshot.slots) {
			const seen = new Set<string>([slot.taskId]);
			let parent = slot.parentTaskId;
			while (parent !== null) {
				if (seen.has(parent)) throw new Error("Invalid cyclic capacity snapshot");
				seen.add(parent);
				parent = restored.get(parent)?.parentTaskId ?? null;
			}
		}
		let running = 0;
		for (const slot of restored.values()) if (slot.state === "running") running++;
		if (running > snapshot.maxConcurrentTasks) throw new Error("Invalid capacity snapshot: over concurrency");
		this.slots.clear();
		for (const [taskId, slot] of restored) this.slots.set(taskId, slot);
		this.maxConcurrentTasksValue = snapshot.maxConcurrentTasks;
		this.maxProjectTasksValue = snapshot.maxProjectTasks;
	}

	private require(taskId: string, now: number): { parentTaskId: string | null; state: TaskSlotState; since: number } {
		if (!Number.isFinite(now)) throw new Error("Invalid capacity time");
		const slot = this.slots.get(taskId);
		if (!slot) throw new Error(`Unknown task: ${taskId}`);
		return slot;
	}
}
