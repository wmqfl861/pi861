import type { FullToolIdentity } from "../contracts/capability.ts";
import type { BusinessOperation } from "../contracts/operation.ts";
import { digest } from "../memory.ts";
import { McpFailure } from "./mcp.ts";
import type { StateStore } from "./store.ts";

export interface OperationIntent {
	requestId: string;
	operationId?: string;
	principal: string;
	resource: string;
	fingerprint: string;
	readOnly: boolean;
	/** C5 full tool identity (service, tool, account, resource, schema); binds stable business ids to exact content. */
	tool?: FullToolIdentity;
}
export interface OperationReceipt extends OperationIntent {
	state: "dispatched" | "committed" | "unknown" | "not_dispatched" | "failed" | "resolved";
	result?: unknown;
	evidence?: string;
	updatedAt: number;
	/** Receipt state before a trusted reconciliation resolved it; drives the C5 derived view. */
	priorState?: Exclude<OperationReceipt["state"], "resolved">;
}
export interface OperationState {
	receipts: Record<string, OperationReceipt>;
}

/**
 * Durable at-most-once dispatch per intent. Unknown side effects require trusted reconciliation,
 * not timed replay. The receipt log is the persistence; C5's stable business operation view is
 * derived from it (toBusinessOperation / businessSnapshot below), so consumers read statuses in
 * the frozen contract's vocabulary: a succeeded business id is never re-dispatched, an unknown
 * one blocks until reconciliation, and a not-executed one is retryable.
 */
export class OperationJournal {
	private readonly store: StateStore<OperationState>;
	constructor(store: StateStore<OperationState>) {
		this.store = store;
	}
	async run(intent: OperationIntent, dispatch: () => Promise<unknown>): Promise<unknown> {
		if (!intent.requestId || !intent.principal || !intent.resource || !intent.fingerprint)
			throw new Error("Operation identity required");
		if (intent.tool) toolIdentityOf(intent.tool);
		const key = digest([intent.principal, intent.requestId]);
		const admitted = await this.store.update((state) => {
			const prior = state.receipts[key];
			if (prior) {
				if (!sameIntent(prior, intent)) throw new Error("Operation idempotency conflict");
				if (prior.state === "committed") return { cached: true, result: prior.result };
				throw new Error(
					`Operation ${intent.requestId} has ${prior.state} outcome; reconcile or create a reviewed new intent`,
				);
			}
			if (intent.operationId) {
				const related = Object.values(state.receipts).filter(
					(receipt) => receipt.principal === intent.principal && receipt.operationId === intent.operationId,
				);
				if (related.some((receipt) => !sameBusiness(receipt, intent)))
					throw new Error("Business operation idempotency conflict");
				const committed = related.find((receipt) => receipt.state === "committed");
				if (committed) return { cached: true, result: committed.result };
			}
			if (
				!intent.readOnly &&
				Object.values(state.receipts).some(
					(receipt) =>
						receipt.resource === intent.resource &&
						receipt.fingerprint === intent.fingerprint &&
						["unknown", "dispatched"].includes(receipt.state),
				)
			) {
				throw new Error("An equivalent operation has an unresolved outcome; automatic redispatch refused");
			}
			if (Object.keys(state.receipts).length >= 100_000)
				throw new Error("Operation journal capacity reached; operator archival required");
			state.receipts[key] = { ...intent, state: "dispatched", updatedAt: Date.now() };
			return { cached: false, result: undefined };
		});
		if (admitted.cached) return admitted.result;
		try {
			const result = await dispatch();
			if (result === undefined || Buffer.byteLength(JSON.stringify(result)) > 131_072)
				throw new Error("Journal result requires a bounded artifact reference");
			await this.store.update((state) => {
				const receipt = state.receipts[key];
				if (!receipt || receipt.state !== "dispatched") throw new Error("Operation publication state changed");
				receipt.result = result;
				receipt.state = "committed";
				receipt.updatedAt = Date.now();
			});
			return result;
		} catch (error) {
			const failed = error instanceof McpFailure && error.outcome === "reported_error";
			await this.store
				.update((state) => {
					const receipt = state.receipts[key];
					if (receipt?.state === "dispatched") {
						// The server answered with a JSON-RPC error: the effect is decisively failed, not unknown.
						// Everything else (transport loss, timeout, abort) leaves the outcome unknown.
						receipt.state =
							error instanceof McpFailure && error.outcome === "not_dispatched"
								? "not_dispatched"
								: failed
									? "failed"
									: "unknown";
						receipt.updatedAt = Date.now();
					}
				})
				.catch(() => {});
			throw error;
		}
	}
	async list(principal: string): Promise<Omit<OperationReceipt, "result" | "fingerprint">[]> {
		return Object.values((await this.store.read()).receipts)
			.filter((receipt) => receipt.principal === principal)
			.map(({ result: _result, fingerprint: _fingerprint, ...receipt }) => receipt);
	}
	/** Operator-only: evidence describes how the external state was reconciled. Never exposed as a model tool. */
	async resolve(principal: string, requestId: string, evidence: string): Promise<void> {
		if (!evidence.trim() || evidence.length > 4000) throw new Error("Reconciliation evidence required");
		await this.store.update((state) => {
			const receipt = state.receipts[digest([principal, requestId])];
			if (
				!receipt ||
				(receipt.state !== "dispatched" && receipt.state !== "unknown" && receipt.state !== "not_dispatched")
			)
				throw new Error("No unresolved owned operation");
			receipt.priorState = receipt.state;
			receipt.state = "resolved";
			receipt.evidence = evidence;
			receipt.updatedAt = Date.now();
		});
	}
	/**
	 * C5 view for consumers (model/Goal/reference services): stable business operations with the
	 * frozen contract's status vocabulary. Only receipts carrying a C5 tool identity appear; a
	 * business id with any committed receipt is final and succeeded.
	 */
	async businessSnapshot(): Promise<BusinessOperation[]> {
		const receipts = Object.values((await this.store.read()).receipts).filter(
			(receipt) => receipt.operationId && receipt.tool,
		);
		const grouped = new Map<string, OperationReceipt[]>();
		for (const receipt of receipts) {
			const bucket = grouped.get(receipt.operationId ?? "") ?? [];
			bucket.push(receipt);
			grouped.set(receipt.operationId ?? "", bucket);
		}
		return [...grouped.values()]
			.map((bucket) => toBusinessOperation(bucket))
			.filter((operation): operation is BusinessOperation => operation !== undefined);
	}
}

/** Validates and normalizes the C5 tool identity carried by an intent. */
function toolIdentityOf(tool: FullToolIdentity): FullToolIdentity {
	for (const value of [tool.serviceId, tool.toolName, tool.accountId, tool.resourceId, tool.schemaDigest]) {
		if (typeof value !== "string" || !value) throw new Error("Incomplete C5 tool identity");
	}
	return tool;
}

/** undefined and absent tool identities normalize to null so legacy receipts compare equal. */
function toolKey(tool: FullToolIdentity | undefined): string {
	return digest(tool ?? null);
}

function sameIntent(prior: OperationReceipt, intent: OperationIntent): boolean {
	return (
		prior.resource === intent.resource &&
		prior.fingerprint === intent.fingerprint &&
		prior.readOnly === intent.readOnly &&
		prior.operationId === intent.operationId &&
		toolKey(prior.tool) === toolKey(intent.tool)
	);
}

function sameBusiness(receipt: OperationReceipt, intent: OperationIntent): boolean {
	return (
		receipt.resource === intent.resource &&
		receipt.fingerprint === intent.fingerprint &&
		receipt.readOnly === intent.readOnly &&
		toolKey(receipt.tool) === toolKey(intent.tool)
	);
}

/**
 * Derives the C5 BusinessOperation for one stable business id from its receipts. Any committed
 * receipt finalizes the operation as succeeded; otherwise the newest receipt decides the status.
 * A resolved receipt derives to its pre-resolution status with reconciled=true.
 */
export function toBusinessOperation(receipts: OperationReceipt[]): BusinessOperation | undefined {
	const withId = receipts.filter((receipt) => receipt.operationId && receipt.tool);
	if (!withId.length) return undefined;
	const committed = withId.find((receipt) => receipt.state === "committed");
	const decisive =
		committed ?? withId.reduce((newest, receipt) => (receipt.updatedAt > newest.updatedAt ? receipt : newest));
	const status = toBusinessStatus(decisive.state, decisive.priorState);
	return {
		operationId: decisive.operationId ?? "",
		tool: decisive.tool as FullToolIdentity,
		inputDigest: decisive.fingerprint,
		status,
		createdAt: withId.reduce((oldest, receipt) => Math.min(oldest, receipt.updatedAt), decisive.updatedAt),
		updatedAt: decisive.updatedAt,
		resultDigest: committed ? digest(committed.result) : undefined,
		lastError: decisive.evidence,
		reconciled: decisive.state === "resolved",
	};
}

function toBusinessStatus(
	state: OperationReceipt["state"],
	prior?: Exclude<OperationReceipt["state"], "resolved">,
): BusinessOperation["status"] {
	switch (state) {
		case "committed":
			return "succeeded";
		case "dispatched":
			return "dispatched";
		case "unknown":
			return "unknown";
		case "not_dispatched":
			return "prepared";
		case "failed":
			return "failed";
		case "resolved":
			// Reconciliation is terminal for the receipt; the C5 view keeps the prior outcome marked reconciled.
			switch (prior) {
				case "not_dispatched":
					return "prepared";
				case "dispatched":
					return "dispatched";
				default:
					return "unknown";
			}
	}
}
