import { type AdoptionEvent, type AssemblyMode, applyAdoption } from "../contracts/memory.ts";
import { digest, type MemoryItem, type MemoryReceipt, type MemoryWrite } from "../memory.ts";
import { type KernelAssemblyResult, toRecord } from "../memory-records.ts";
import { PersistentResultStore, type ResultDescriptor } from "../result-store.ts";
import {
	CAPTURE_DIRECT_MAX_BYTES,
	type CaptureOutcome,
	looksSensitive,
	planToolCapture,
	type ToolObservation,
} from "./capture.ts";
import type { EnrichmentJobView, ExtractionFailureClass, MemoryExtractor } from "./extraction.ts";
import { MemoryCommitPending, type PendingMemoryState, PendingMemoryWrites } from "./memory-pending.ts";
import type { StateStore } from "./store.ts";

/**
 * P2-M automatic memory governance. One service owns the whole automatic memory
 * lifecycle of a host: lifecycle context assembly (startup/takeover/model-switch/
 * compaction/node-switch install fixed constraints and working state directly),
 * timely capture of tool receipts and user statements, durable distillation over
 * the P2-D job table through the P1-S enrich port, source withdrawal with
 * recursive propagation in the authority, and receipt recovery by requestId.
 * The authority (PostgresMemory behind a StorageSession, or the file-backed
 * LayeredMemory) is the single persistent truth; this service never mints a
 * second local authority.
 */

export interface MemoryChangeView {
	sequence: number;
	scope: string;
	id: string;
	revision: number;
	withdrawn: boolean;
}

export interface DistillOptions {
	signal: AbortSignal;
	maxJobs?: number;
	timeoutMs?: number;
	maxAttempts?: number;
	backoffBaseMs?: number;
	backoffCapMs?: number;
	classifyFailure?: (error: unknown) => ExtractionFailureClass;
}

/** Structural surface satisfied by LayeredMemory and PostgresMemory alike. */
export interface MemoryAuthoritySurface {
	get(scope: string, id: string): Promise<MemoryItem | undefined>;
	put(input: MemoryWrite): Promise<MemoryReceipt>;
	withdraw(requestId: string, scope: string, id: string, expectedRevision: number): Promise<MemoryReceipt>;
	assemble(options?: { mode?: AssemblyMode; maxBytes?: number }): Promise<KernelAssemblyResult>;
	delta(
		afterSequence?: number,
		limit?: number,
	): Promise<{ changes: MemoryChangeView[]; cursor: number; hasMore: boolean }>;
	listJobs(): Promise<EnrichmentJobView[]>;
	requeueJob(jobId: string): Promise<EnrichmentJobView>;
	enrich(
		extractor: MemoryExtractor,
		options: DistillOptions,
	): Promise<{ completed: number; failed: number; obsolete: number }>;
	reconcile?(
		requestId: string,
		expectedDigest?: string,
	): Promise<{ state: "committed"; receipt: MemoryReceipt } | { state: "notCommitted" }>;
}

/** Boot transitions that assemble fixed constraints plus working/project state (R6.3). */
export type LifecycleTransition = Exclude<AssemblyMode, "event-recall">;

/** Record shape the P1-S auxiliary enrich port receives (auxiliary-models.ts AuxiliaryRecordInput). */
export interface DistillationRecord {
	id: string;
	revision: number;
	text: string;
	source: { kind: string; ref: string };
}

/** P1-S enrich port shape (frozen): enrich(context, record, signal). */
export type AuxiliaryEnrich<TContext> = (
	context: TContext,
	record: DistillationRecord,
	signal: AbortSignal,
) => Promise<unknown>;

/** Adapts the P1-S auxiliary port to the MemoryExtractor the authority enrich loop consumes. */
export function auxiliaryExtractor<TContext>(
	modelId: string,
	enrich: AuxiliaryEnrich<TContext>,
	context: TContext,
): MemoryExtractor {
	if (!modelId || typeof enrich !== "function") throw new Error("The enrich port requires a model id and a function");
	return {
		modelId,
		extract: (record, signal) => enrich(context, record, signal),
	};
}

export interface MemoryGovernanceOptions {
	authority: MemoryAuthoritySurface;
	/** Bounded local delivery queue for writes the authority temporarily refused. */
	pending: StateStore<PendingMemoryState>;
	/** Canonical write scope for automatic captures. */
	scope: string;
	/**
	 * Owner identity for durable controlled references - the entitled reader
	 * shared by every node of the agent, so a reference minted on one node
	 * resolves on another. Defaults to a scope-derived identity.
	 */
	owner?: string;
	/** Scopes probed when resolving durable references; defaults to [scope]. */
	resultScopes?: string[];
	resultPageSize?: number;
	assembleMaxBytes?: number;
	pendingCapacity?: number;
}

export interface UserStatementInput {
	sessionId: string;
	/** Monotonic per-session sequence; part of the capture identity. */
	sequence: number;
	text: string;
	kind: "constraint" | "working" | "project";
}

export type MemoryRecoveryOutcome = { state: "committed"; receipt: MemoryReceipt } | { state: "notCommitted" };

export class MemoryGovernanceAlreadyInstalled extends Error {
	constructor() {
		super("A memory governance collector is already installed for this host");
	}
}

function serializeObservation(observation: ToolObservation): { ok: true; payload: string } | { ok: false } {
	try {
		return {
			ok: true,
			payload: JSON.stringify({
				tool: observation.toolName,
				result: observation.result,
				isError: observation.isError === true,
			}),
		};
	} catch {
		return { ok: false };
	}
}

/**
 * The single automatic collector for one host. Hosts install it through
 * attachMemoryGovernance; a second attach fails, so two capture pipelines can
 * never double-record the same session.
 */
export class MemoryGovernance {
	readonly authority: MemoryAuthoritySurface;
	readonly results: PersistentResultStore;
	private readonly pendingQueue: PendingMemoryWrites;
	private readonly scope: string;
	private readonly owner: string;
	private readonly assembleMaxBytes: number;
	private host: { memoryGovernance?: MemoryGovernance } | undefined;

	constructor(options: MemoryGovernanceOptions) {
		this.authority = options.authority;
		this.scope = options.scope;
		this.owner = options.owner ?? `pi861:${options.scope}`;
		this.assembleMaxBytes = options.assembleMaxBytes ?? 6000;
		this.pendingQueue = new PendingMemoryWrites(options.pending, options.authority, options.pendingCapacity ?? 100);
		this.results = new PersistentResultStore(options.authority, {
			scopes: options.resultScopes ?? [options.scope],
			...(options.resultPageSize !== undefined ? { pageSize: options.resultPageSize } : {}),
		});
	}

	// ----- automatic read: lifecycle assembly and event recall (R6.3/R6.4) -----

	/**
	 * Boot transitions install fixed constraints and working/project state directly
	 * through the C6 packer over the authority; no keyword hit is required and
	 * long-term experience stays out until event-recall asks for it.
	 */
	async assembleContext(
		transition: LifecycleTransition,
		options: { maxBytes?: number } = {},
	): Promise<KernelAssemblyResult> {
		return this.authority.assemble({ mode: transition, maxBytes: options.maxBytes ?? this.assembleMaxBytes });
	}

	/** Event recall adds experience and evidence on top of the boot sections. */
	async recallContext(options: { maxBytes?: number } = {}): Promise<KernelAssemblyResult> {
		return this.authority.assemble({ mode: "event-recall", maxBytes: options.maxBytes ?? this.assembleMaxBytes });
	}

	/** Monotonic change feed for index and cache consumers; withdrawals carry withdrawn=true. */
	async changes(
		afterSequence = 0,
		limit = 50,
	): Promise<{ changes: MemoryChangeView[]; cursor: number; hasMore: boolean }> {
		return this.authority.delta(afterSequence, limit);
	}

	/** Replays uncommitted local writes after the authority recovers; never a read path. */
	async flushPending(): Promise<{ committed: number; pending: number }> {
		return this.pendingQueue.flush();
	}

	// ----- automatic write: timely capture (R6.5/R6.6/R6.7) -----

	/**
	 * Persists one tool receipt at tool_execution_end time. Direct captures store
	 * the payload; oversized non-sensitive payloads become durable controlled
	 * references (nothing over the direct limit is ever dropped silently);
	 * sensitive or unserializable payloads keep withholding descriptors only.
	 */
	async captureToolExecutionEnd(observation: ToolObservation): Promise<CaptureOutcome> {
		try {
			const serialized = serializeObservation(observation);
			if (
				serialized.ok &&
				Buffer.byteLength(serialized.payload, "utf8") > CAPTURE_DIRECT_MAX_BYTES &&
				!looksSensitive(serialized.payload)
			) {
				return await this.captureDurableReference(observation, serialized.payload);
			}
			const plan = planToolCapture(observation, this.scope);
			const receipt = await this.pendingQueue.put({
				requestId: plan.requestId,
				expectedRevision: null,
				item: plan.item,
			});
			return {
				status: plan.mode === "direct" ? "captured" : "referenced",
				id: receipt.id,
			};
		} catch (error) {
			if (error instanceof MemoryCommitPending)
				return {
					status: "failed",
					id: digest([observation.sessionId, observation.toolCallId]),
					error: `memory checkpoint uncommitted: ${error.requestId}`,
				};
			const message = error instanceof Error ? error.message : "memory capture failed";
			return {
				status: "failed",
				id: digest([observation.sessionId, observation.toolCallId]),
				error: looksSensitive(message) ? "memory capture failed (details withheld)" : message.slice(0, 300),
			};
		}
	}

	private async captureDurableReference(observation: ToolObservation, payload: string): Promise<CaptureOutcome> {
		const descriptor: ResultDescriptor = {
			kind: "tool",
			scope: this.scope,
			tool: observation.toolName,
			sourceComplete: true,
		};
		const stored = await this.results.store(payload, this.owner, descriptor);
		const id = digest([observation.sessionId, observation.toolCallId]);
		const body = JSON.stringify({
			capture: "tool-reference",
			tool: observation.toolName,
			sessionId: observation.sessionId,
			toolCallId: observation.toolCallId,
			isError: observation.isError === true,
			bytes: Buffer.byteLength(payload, "utf8"),
			contentDigest: digest(payload),
			resultRef: stored.resultRef,
			owner: this.owner,
			durable: true,
		});
		const note = `Tool result stored as a durable controlled reference (${observation.toolName}); original payload retrievable by resultRef from the record body.`;
		const receipt = await this.pendingQueue.put({
			requestId: id,
			expectedRevision: null,
			item: {
				id,
				scope: this.scope,
				kind: "evidence",
				status: "candidate",
				abstract: note,
				overview: note,
				full: body,
				source: { kind: "tool", ref: `pi-session:${observation.sessionId}/tool:${observation.toolCallId}` },
			},
		});
		return { status: "referenced", id: receipt.id };
	}

	/** User statements enter with direct user provenance; user-sourced records may carry confirmed status. */
	async captureUserStatement(input: UserStatementInput): Promise<CaptureOutcome> {
		const id = digest(["pi861.user", input.sessionId, input.sequence]);
		try {
			if (!input.sessionId || !Number.isSafeInteger(input.sequence) || input.sequence < 1)
				throw new Error("Invalid user statement identity");
			if (!input.text.trim() || Buffer.byteLength(input.text, "utf8") > 262_144)
				throw new Error("User statement is empty or over the record limit");
			const receipt = await this.pendingQueue.put({
				requestId: id,
				expectedRevision: null,
				item: {
					id,
					scope: this.scope,
					kind: input.kind,
					status: "confirmed",
					abstract: input.text.slice(0, 200),
					overview: input.text.slice(0, 1000),
					full: input.text,
					source: { kind: "user", ref: `pi-session:${input.sessionId}/user:${input.sequence}` },
				},
			});
			return { status: "captured", id: receipt.id };
		} catch (error) {
			if (error instanceof MemoryCommitPending)
				return { status: "failed", id, error: `memory checkpoint uncommitted: ${error.requestId}` };
			const message = error instanceof Error ? error.message : "memory capture failed";
			return { status: "failed", id, error: message.slice(0, 300) };
		}
	}

	// ----- distillation: P1-S port over the durable job table (R6.8/R6.9) -----

	/**
	 * Runs the durable distillation loop with the P1-S enrich port. Claim and
	 * commit are separate authority transactions with the model call outside any
	 * storage lock; transient failures back off and stay recoverable, permanent
	 * failures park in the terminal failed state for manual requeue.
	 */
	async distill<TContext>(
		enrich: AuxiliaryEnrich<TContext>,
		context: TContext,
		modelId: string,
		options: DistillOptions,
	): Promise<{ completed: number; failed: number; obsolete: number }> {
		return this.authority.enrich(auxiliaryExtractor(modelId, enrich, context), options);
	}

	async distillationJobs(): Promise<EnrichmentJobView[]> {
		return this.authority.listJobs();
	}

	async requeueDistillation(jobId: string): Promise<EnrichmentJobView> {
		return this.authority.requeueJob(jobId);
	}

	// ----- source governance and controlled references (R6.10/R6.11, C7) -----

	/**
	 * Withdraws a source record. The authority propagates recursively (C6
	 * planWithdrawal closure): derivatives, their summaries, pending extraction
	 * jobs and index events are invalidated in the same commit, and tombstones
	 * block the same source from re-entering.
	 */
	async withdrawSource(
		requestId: string,
		scope: string,
		id: string,
		expectedRevision: number,
	): Promise<MemoryReceipt> {
		return this.authority.withdraw(requestId, scope, id, expectedRevision);
	}

	/**
	 * Revokes a durable controlled reference: every chunk record is withdrawn, so
	 * the tombstone is visible on every node and existing references stop reading
	 * immediately and uniformly.
	 */
	async revokeResultReference(requestId: string, resultRef: string): Promise<number> {
		return this.results.revoke(requestId, resultRef, this.owner);
	}

	/** Durable reference reads: windowed, integrity-checked via the record chain. */
	async readResultReference(resultRef: string, offset = 0) {
		return this.results.read(resultRef, this.owner, offset);
	}

	async describeResultReference(resultRef: string): Promise<ResultDescriptor> {
		return this.results.metadata(resultRef, this.owner);
	}

	// ----- adoption (R6.12) -----

	/**
	 * Promotes a candidate to a confirmed project fact using verified provenance
	 * that embeds the C7 acceptance-evidence digest. The event is validated by the
	 * frozen C6 applyAdoption first; branch completion carries no such digest and
	 * can never pass this gate.
	 */
	async adoptFromAcceptance(event: AdoptionEvent): Promise<MemoryReceipt> {
		const current = await this.authority.get(event.scope, event.recordId);
		if (!current) throw new Error("Candidate record not found");
		const adopted = applyAdoption(toRecord(current), event);
		// The item facade carries one source entry; the trusted adoption path mints
		// verified provenance binding the C7 evidence digest. Full multi-entry
		// provenance chains need the record-level write path (P2-D interface request).
		return this.authority.put({
			requestId: digest(["pi861.adoption", event.scope, event.recordId, event.acceptanceEvidenceDigest]),
			expectedRevision: current.revision,
			item: {
				id: adopted.id,
				scope: event.scope,
				kind: adopted.purpose,
				abstract: adopted.abstract,
				overview: adopted.overview,
				full: adopted.full,
				status: "confirmed",
				source: { kind: "verified", ref: `adoption:${event.acceptanceEvidenceDigest}` },
			},
		});
	}

	// ----- C4 receipt recovery (AX8) -----

	/**
	 * Adjudicates an ambiguous commit by requestId. With the P2-D authority the
	 * stored receipt is the single truth; without reconcile support the caller
	 * must flush pending writes (same requestId, immutable payload).
	 */
	async reconcile(requestId: string, expectedDigest?: string): Promise<MemoryRecoveryOutcome> {
		if (!this.authority.reconcile)
			throw new Error("Authority cannot reconcile receipts; flush pending writes instead");
		return this.authority.reconcile(requestId, expectedDigest);
	}

	/** Detaches from the host so a fresh collector can be installed after shutdown. */
	detach(): void {
		if (this.host?.memoryGovernance === this) delete this.host.memoryGovernance;
		this.host = undefined;
	}

	/** @internal set by attachMemoryGovernance */
	bindHost(host: { memoryGovernance?: MemoryGovernance }): void {
		this.host = host;
	}
}

export interface GovernedMemoryHost {
	memoryGovernance?: MemoryGovernance;
}

/**
 * Installs the one governance collector for a host. A second attach fails:
 * the negative keeps a duplicated facade from installing a second capture
 * pipeline over the same authority.
 */
export function attachMemoryGovernance(host: GovernedMemoryHost, options: MemoryGovernanceOptions): MemoryGovernance {
	if (host.memoryGovernance) throw new MemoryGovernanceAlreadyInstalled();
	const governance = new MemoryGovernance(options);
	host.memoryGovernance = governance;
	governance.bindHost(host);
	return governance;
}
