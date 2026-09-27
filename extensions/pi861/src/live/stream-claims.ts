import type { FullToolIdentity } from "../contracts/capability.ts";
import { OperationLedger } from "../contracts/operation.ts";
import { digest } from "../memory.ts";
import {
	type BindTool,
	businessOperationId,
	type ToolBinding as StreamBinding,
	type StreamToolCall,
} from "./stream-bridge.ts";

/**
 * H-owned C5 stream-claims wiring (P2-B delivery section 7, items 2-3). One ledger
 * instance is shared by every AttemptStreamBridge of a host process; bind resolves
 * each committed tool call to its C5 identity (activated capability bindings carry a
 * stable business identity, native host tools are per-call local intents), and the
 * host settles each claim from the real tool receipt at tool_execution_end. Unknown
 * outcomes block further model dispatch until a trusted reconciliation.
 */

/** Receipt digests bind the observed outcome; host tool results can carry fields canonical() rejects, so fall back to a JSON round-trip. */
function receiptDigest(operationId: string, result: unknown): string {
	try {
		return digest(result);
	} catch {
		try {
			return digest(JSON.parse(JSON.stringify(result)));
		} catch {
			return digest(["unserializable-receipt", operationId]);
		}
	}
}

export interface ResolvedBinding {
	identity: FullToolIdentity;
	/** True when the identity is a stable business identity (blocking discipline applies across attempts). */
	business: boolean;
}

export class StreamClaims {
	private readonly claims = new Map<string, string>();
	private readonly resolve: (toolName: string) => ResolvedBinding | undefined;
	private readonly nativeIdentity: (toolName: string) => FullToolIdentity;
	readonly ledger: OperationLedger;
	constructor(
		resolve: (toolName: string) => ResolvedBinding | undefined,
		nativeIdentity: (toolName: string) => FullToolIdentity,
		/** Injectable for tests; production shares one ledger across bridge instances. */
		ledger: OperationLedger = new OperationLedger(),
	) {
		this.resolve = resolve;
		this.nativeIdentity = nativeIdentity;
		this.ledger = ledger;
	}

	/** Bridge bind callback: resolves the C5 binding and records the claim for settlement. */
	readonly bind: BindTool = (tool: StreamToolCall): StreamBinding => {
		const resolved = this.resolve(tool.name);
		if (tool.name.startsWith("pi861_mcp_") && !resolved)
			throw new Error(`Managed stream tool ${tool.name} has no active capability binding`);
		const binding: StreamBinding = resolved
			? { identity: resolved.identity, inputDigest: digest(tool.arguments) }
			: {
					identity: this.nativeIdentity(tool.name),
					// Native host tools are distinct local intents: the call identity keeps
					// repeated identical invocations from falsely colliding as one business operation.
					inputDigest: digest([tool.id, tool.arguments]),
				};
		this.claims.set(tool.id, businessOperationId(binding));
		return binding;
	};

	/** Settles one claim from the real tool receipt; returns the settled operation id when a claim existed. */
	settle(toolCallId: string, result: unknown, isError: boolean, now = Date.now()): string | undefined {
		const operationId = this.claims.get(toolCallId);
		if (!operationId) return undefined;
		this.claims.delete(toolCallId);
		if (this.ledger.get(operationId)?.status !== "dispatched") return operationId;
		if (isError) this.ledger.markFailed(operationId, "Tool execution reported an error", now);
		else if (result === undefined) this.ledger.markUnknown(operationId, "Tool receipt missing", now);
		else this.ledger.markSucceeded(operationId, receiptDigest(operationId, result), now);
		return operationId;
	}

	/** Claims still dispatched at turn end lost their receipt; they block until reconciliation. */
	markLostReceipts(now = Date.now()): number {
		let lost = 0;
		for (const operationId of new Set(this.claims.values())) {
			if (this.ledger.get(operationId)?.status !== "dispatched") continue;
			this.ledger.markUnknown(operationId, "Tool receipt lost at turn end", now);
			lost++;
		}
		this.claims.clear();
		return lost;
	}

	/** Unsettled operations (dispatched or unknown) pause further model dispatch. */
	unsettled(): number {
		const claimed = new Set(this.claims.values());
		let count = 0;
		for (const operationId of claimed) {
			const status = this.ledger.get(operationId)?.status;
			if (status === "dispatched" || status === "unknown") count++;
		}
		// Unknown operations whose claim mapping is already gone still block until reconciled.
		for (const operation of this.ledger.exportState().operations)
			if (!claimed.has(operation.operationId) && operation.status === "unknown") count++;
		return count;
	}

	/** Trusted reconciliation channel (operator); resolves an unknown outcome exactly once. */
	reconcile(
		operationId: string,
		outcome:
			| { status: "succeeded"; resultDigest: string }
			| { status: "failed"; error: string }
			| { status: "not-executed" },
		now = Date.now(),
	): void {
		this.ledger.reconcile(operationId, outcome, now);
		for (const [toolCallId, claimed] of this.claims) if (claimed === operationId) this.claims.delete(toolCallId);
	}

	/** Operations awaiting reconciliation, for operator surfaces. */
	pending(): { operationId: string; status: string; lastError?: string }[] {
		return this.ledger
			.exportState()
			.operations.filter((operation) => operation.status === "unknown")
			.map((operation) => ({
				operationId: operation.operationId,
				status: operation.status,
				...(operation.lastError !== undefined ? { lastError: operation.lastError } : {}),
			}));
	}
}
