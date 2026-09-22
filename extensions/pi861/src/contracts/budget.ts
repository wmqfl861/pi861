/**
 * C3 budget contract: whole-task-tree capacity with reserve-then-settle metering for every
 * actual model attempt - execution, reception, planning, skill compilation, memory distillation,
 * health probes and auxiliary calls. Unknown usage is recorded as unknown with a bounded
 * conservative booking; it is never silently written down as zero.
 */

export type MeteredKind =
	| "execution"
	| "reception"
	| "planning"
	| "skill-compile"
	| "distill"
	| "probe"
	| "auxiliary";

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

const ZERO_USAGE: UsageMeasure = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };

function validateUsage(usage: UsageMeasure): void {
	for (const value of [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.costUsd]) {
		if (!Number.isFinite(value) || value < 0) throw new Error("Usage measures must be finite and non-negative");
	}
}

function isZero(usage: UsageMeasure): boolean {
	return usage.inputTokens === 0 && usage.outputTokens === 0 && usage.cacheReadTokens === 0 &&
		usage.cacheWriteTokens === 0 && usage.costUsd === 0;
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
	if (!Number.isSafeInteger(limits.maxAttempts) || limits.maxAttempts < 1) throw new Error("Attempt limit must be a positive integer");
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

	constructor(rootLimits: BudgetLimits) {
		validateLimits(rootLimits);
		this.rootLimits = { ...rootLimits };
	}

	registerTask(taskId: string, parentTaskId: string | null, subtreeLimits?: BudgetLimits): void {
		if (!taskId || taskId.length > 200 || this.tasks.has(taskId)) throw new Error("Invalid or duplicate task registration");
		if (parentTaskId !== null && !this.tasks.has(parentTaskId)) throw new Error("Unknown parent task");
		if (subtreeLimits) validateLimits(subtreeLimits);
		this.tasks.set(taskId, {
			taskId, parentTaskId, limits: subtreeLimits ? { ...subtreeLimits } : undefined,
			attempts: 0, usage: { ...ZERO_USAGE }, unknownSettlements: 0,
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

	/** Reserves capacity before the request is dispatched; throws BudgetExhausted when any bound would be crossed. */
	reserve(taskId: string | null, kind: MeteredKind, estimate: UsageMeasure, now: number): UsageReservation {
		validateUsage(estimate);
		if (!Number.isFinite(now)) throw new Error("Invalid reservation time");
		const chain = this.chainFrom(taskId);
		for (const node of chain) {
			const limits = node.limits;
			if (!limits) continue;
			this.checkBounds(`task:${node.taskId}`, limits, node.attempts, node.usage, node.taskId, estimate);
		}
		this.checkBounds("tree", this.rootLimits, this.rootAttempts, this.rootUsage, "root", estimate);
		const reservation: UsageReservation = {
			reservationId: `r-${++this.reservationSequence}`, taskId, kind,
			estimate: { ...estimate }, openedAt: now, state: "reserved",
		};
		this.reservations.set(reservation.reservationId, reservation);
		return { ...reservation };
	}

	private checkBounds(scope: string, limits: BudgetLimits, committedAttempts: number, committedUsage: UsageMeasure,
		scopeId: string | "root", estimate: UsageMeasure): void {
		const held: UsageMeasure = { ...ZERO_USAGE };
		let openAttempts = 0;
		for (const reservation of this.reservations.values()) {
			if (reservation.state !== "reserved" || !this.withinScope(scopeId, reservation)) continue;
			addUsage(held, reservation.estimate);
			openAttempts++;
		}
		const projectedInput = committedUsage.inputTokens + committedUsage.cacheReadTokens + held.inputTokens + held.cacheReadTokens + estimate.inputTokens + estimate.cacheReadTokens;
		const projectedOutput = committedUsage.outputTokens + held.outputTokens + estimate.outputTokens;
		const projectedCost = committedUsage.costUsd + held.costUsd + estimate.costUsd;
		const projectedAttempts = committedAttempts + openAttempts + 1;
		if (projectedInput > limits.maxInputTokens || projectedOutput > limits.maxOutputTokens ||
			projectedCost > limits.maxTotalCostUsd || projectedAttempts > limits.maxAttempts) {
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
			taskId, parentTaskId: node.parentTaskId,
			limits: node.limits ? { ...node.limits } : undefined,
			attempts: node.attempts, usage: { ...node.usage }, unknownSettlements: node.unknownSettlements,
		};
	}

	openReservations(): UsageReservation[] {
		return [...this.reservations.values()].filter((reservation) => reservation.state === "reserved").map((reservation) => ({ ...reservation }));
	}

	exportState(): {
		version: 1;
		rootLimits: BudgetLimits;
		rootAttempts: number;
		rootUsage: UsageMeasure;
		rootUnknown: number;
		tasks: TaskUsageSummary[];
		reservations: UsageReservation[];
	} {
		return {
			version: 1, rootLimits: { ...this.rootLimits }, rootAttempts: this.rootAttempts,
			rootUsage: { ...this.rootUsage }, rootUnknown: this.rootUnknown,
			tasks: [...this.tasks.keys()].map((taskId) => this.taskSummary(taskId)),
			reservations: [...this.reservations.values()].map((reservation) => ({ ...reservation })),
		};
	}

	restore(snapshot: ReturnType<TaskTreeBudget["exportState"]>): void {
		if (snapshot.version !== 1 || !Number.isSafeInteger(snapshot.rootAttempts) || snapshot.rootAttempts < 0 ||
			!Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.reservations)) throw new Error("Invalid budget snapshot");
		validateLimits(snapshot.rootLimits);
		validateUsage(snapshot.rootUsage);
		const seen = new Set<string>();
		for (const task of snapshot.tasks) {
			if (!task.taskId || seen.has(task.taskId) || !Number.isSafeInteger(task.attempts) || task.attempts < 0 ||
				!Number.isSafeInteger(task.unknownSettlements) || task.unknownSettlements < 0 ||
				(task.parentTaskId !== null && !snapshot.tasks.some((other) => other.taskId === task.parentTaskId))) {
				throw new Error("Invalid task usage snapshot");
			}
			validateUsage(task.usage);
			if (task.limits) validateLimits(task.limits);
			seen.add(task.taskId);
		}
		this.tasks.clear();
		this.reservations.clear();
		for (const task of snapshot.tasks) {
			this.tasks.set(task.taskId, {
				taskId: task.taskId, parentTaskId: task.parentTaskId,
				limits: task.limits ? { ...task.limits } : undefined,
				attempts: task.attempts, usage: { ...task.usage }, unknownSettlements: task.unknownSettlements,
			});
		}
		Object.assign(this.rootLimits, snapshot.rootLimits);
		Object.assign(this.rootUsage, snapshot.rootUsage);
		this.rootAttempts = snapshot.rootAttempts;
		this.rootUnknown = snapshot.rootUnknown;
		for (const reservation of snapshot.reservations) {
			if (this.reservations.has(reservation.reservationId) ||
				!["reserved", "settled", "settled-unknown", "released"].includes(reservation.state) ||
				(reservation.taskId !== null && !this.tasks.has(reservation.taskId))) {
				throw new Error("Invalid reservation snapshot");
			}
			validateUsage(reservation.estimate);
			this.reservations.set(reservation.reservationId, { ...reservation });
		}
	}
}
