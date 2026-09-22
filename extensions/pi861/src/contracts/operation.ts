import type { FullToolIdentity } from "./capability.ts";
import { digest } from "./hash.ts";

/**
 * C5 operation contract: side-effecting tool calls run under a stable business operation id with
 * a persistent ledger. Changing a toolCallId never authorizes a re-send: a succeeded operation
 * cannot be re-dispatched, and an unknown outcome (lost receipt, cut stream) must be reconciled
 * before anything is retried.
 */

export type OperationStatus = "prepared" | "dispatched" | "succeeded" | "failed" | "unknown";

export interface BusinessOperation {
	operationId: string;
	tool: FullToolIdentity;
	inputDigest: string;
	status: OperationStatus;
	createdAt: number;
	updatedAt: number;
	resultDigest?: string;
	lastError?: string;
	reconciled: boolean;
}

export class OperationConflict extends Error {
	constructor(operationId: string) {
		super(`Operation id replayed with different content: ${operationId}`);
	}
}

export interface OperationSnapshot {
	version: 1;
	operations: BusinessOperation[];
}

export class OperationLedger {
	private readonly operations = new Map<string, BusinessOperation>();

	/** Idempotent by (operationId, tool, inputDigest); same id with different content is a conflict. */
	prepare(operationId: string, tool: FullToolIdentity, inputDigest: string, now: number): BusinessOperation {
		this.validateIdentity(operationId, inputDigest, now);
		if (!tool.serviceId || !tool.toolName || !tool.accountId || !tool.resourceId || !tool.schemaDigest) {
			throw new Error("Incomplete tool identity for operation");
		}
		const existing = this.operations.get(operationId);
		if (existing) {
			if (digest(existing.tool) !== digest(tool) || existing.inputDigest !== inputDigest)
				throw new OperationConflict(operationId);
			return { ...existing };
		}
		const operation: BusinessOperation = {
			operationId,
			tool: structuredClone(tool),
			inputDigest,
			status: "prepared",
			createdAt: now,
			updatedAt: now,
			reconciled: false,
		};
		this.operations.set(operationId, operation);
		return { ...operation };
	}

	markDispatched(operationId: string, now: number): void {
		this.transition(operationId, "prepared", "dispatched", now);
	}

	markSucceeded(operationId: string, resultDigest: string, now: number): void {
		if (!resultDigest) throw new Error("A succeeded operation records a result digest");
		const operation = this.transition(operationId, "dispatched", "succeeded", now);
		operation.resultDigest = resultDigest;
	}

	markFailed(operationId: string, error: string, now: number): void {
		const operation = this.transition(operationId, "dispatched", "failed", now);
		operation.lastError = error.slice(0, 500);
	}

	/** Dispatch finished without a receipt (stream cut, provider timeout, lost response). */
	markUnknown(operationId: string, reason: string, now: number): void {
		const operation = this.transition(operationId, "dispatched", "unknown", now);
		operation.lastError = reason.slice(0, 500);
	}

	/** Trusted reconciliation path only; resolves an unknown outcome exactly once. */
	reconcile(
		operationId: string,
		outcome:
			| { status: "succeeded"; resultDigest: string }
			| { status: "failed"; error: string }
			| { status: "not-executed" },
		now: number,
	): void {
		const operation = this.require(operationId);
		if (operation.status !== "unknown" || !Number.isFinite(now))
			throw new Error(`Operation is not awaiting reconciliation: ${operationId}`);
		operation.reconciled = true;
		operation.updatedAt = now;
		if (outcome.status === "succeeded") {
			operation.status = "succeeded";
			operation.resultDigest = outcome.resultDigest;
		} else if (outcome.status === "failed") {
			operation.status = "failed";
			operation.lastError = outcome.error.slice(0, 500);
		} else {
			operation.status = "prepared"; // The effect provably never happened; dispatch may be retried.
		}
	}

	/** Only prepared (or reconciled not-executed) operations may be dispatched. */
	canDispatch(operationId: string): boolean {
		return this.operations.get(operationId)?.status === "prepared";
	}

	get(operationId: string): BusinessOperation | undefined {
		const operation = this.operations.get(operationId);
		return operation ? { ...operation } : undefined;
	}

	exportState(): OperationSnapshot {
		return { version: 1, operations: [...this.operations.values()].map((operation) => ({ ...operation })) };
	}

	restore(snapshot: OperationSnapshot): void {
		if (snapshot.version !== 1 || !Array.isArray(snapshot.operations)) throw new Error("Invalid operation snapshot");
		const restored = new Map<string, BusinessOperation>();
		for (const operation of snapshot.operations) {
			if (
				!operation.operationId ||
				restored.has(operation.operationId) ||
				!operation.inputDigest ||
				!Number.isFinite(operation.createdAt) ||
				!Number.isFinite(operation.updatedAt) ||
				!["prepared", "dispatched", "succeeded", "failed", "unknown"].includes(operation.status) ||
				typeof operation.reconciled !== "boolean"
			)
				throw new Error("Invalid operation snapshot entry");
			restored.set(operation.operationId, { ...operation });
		}
		this.operations.clear();
		for (const [operationId, operation] of restored) this.operations.set(operationId, operation);
	}

	private transition(operationId: string, from: OperationStatus, to: OperationStatus, now: number): BusinessOperation {
		const operation = this.require(operationId);
		if (operation.status !== from || !Number.isFinite(now)) {
			throw new Error(`Operation ${operationId} cannot move ${from} -> ${to} from ${operation.status}`);
		}
		operation.status = to;
		operation.updatedAt = now;
		return operation;
	}

	private require(operationId: string): BusinessOperation {
		const operation = this.operations.get(operationId);
		if (!operation) throw new Error(`Unknown operation: ${operationId}`);
		return operation;
	}

	private validateIdentity(operationId: string, inputDigest: string, now: number): void {
		if (!operationId || operationId.length > 200 || !inputDigest || !Number.isFinite(now)) {
			throw new Error("Invalid operation identity");
		}
	}
}
