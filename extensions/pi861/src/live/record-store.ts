import { formatScope } from "../contracts/identity.ts";
import { type MemoryRecord, planWithdrawal, validateMemoryRecord } from "../contracts/memory.ts";
import { IdempotencyConflict, VersionConflict } from "../contracts/storage.ts";
import { checkPrincipal, type MemoryPrincipal, type MemoryReceipt, requireWrite } from "../memory.ts";
import {
	type MemoryRecordWrite,
	putRecordContentDigest,
	recordFingerprints,
	withdrawContentDigest,
} from "../memory-records.ts";
import type { StateStore } from "./store.ts";

/**
 * P2-D file/state-backed authoritative record store (the local counterpart of
 * PostgresMemory's record-level path). It stores COMPLETE C6 records - multi-entry
 * provenance chains and cross-record derivedFrom links - and withdrawal propagates
 * through the same frozen planWithdrawal closure the database path uses, so both
 * authorities implement identical recursive semantics. Single writer per StateStore:
 * the whole operation runs inside the store's storage lock; external work stays out.
 */
export interface RecordStoreState {
	version: 1;
	records: MemoryRecord[];
	receipts: { requestId: string; hash: string; receipt: MemoryReceipt }[];
	tombstones: string[];
}

export function emptyRecordStoreState(): RecordStoreState {
	return { version: 1, records: [], receipts: [], tombstones: [] };
}

function liveRecord(state: RecordStoreState, scope: string, id: string): MemoryRecord | undefined {
	return state.records.find((record) => formatScope(record.scope) === scope && record.id === id);
}

/** Same derivation rules as the database path: readable, existing, live, not future. */
function validateDerivations(state: RecordStoreState, record: MemoryRecord, readScopes: string[]): void {
	for (const link of record.derivedFrom) {
		if (!readScopes.includes(link.scope)) throw new Error(`Derivation source scope is not readable: ${link.scope}`);
		const target = liveRecord(state, link.scope, link.id);
		if (!target) throw new Error(`Unknown derivation source: ${link.scope}/${link.id}`);
		if (target.status === "withdrawn") throw new Error(`Derivation source is withdrawn: ${link.scope}/${link.id}`);
		if (target.revision < link.revision)
			throw new Error(`Derivation revision is in the future: ${link.scope}/${link.id}`);
	}
}

export class RecordMemory {
	private readonly store: StateStore<RecordStoreState>;
	private readonly principal: MemoryPrincipal;
	constructor(store: StateStore<RecordStoreState>, principal: MemoryPrincipal) {
		checkPrincipal(principal);
		this.store = store;
		this.principal = structuredClone(principal);
	}

	/** Record-level put: full provenance chain and derivedFrom are preserved verbatim. */
	async putRecord(input: MemoryRecordWrite): Promise<MemoryReceipt> {
		validateMemoryRecord(input.record);
		if (input.record.status === "withdrawn") throw new Error("Use withdraw for record-level removal");
		const scope = formatScope(input.record.scope);
		requireWrite(this.principal, scope);
		if (!input.requestId || input.requestId.length > 200) throw new Error("Invalid record write request");
		const id = input.record.id;
		const contentDigest = putRecordContentDigest(scope, id, input.expectedRevision, input.record);
		return this.store.update((state) => {
			if (state.version !== 1) throw new Error("Unsupported record store version");
			const replay = state.receipts.find((entry) => entry.requestId === input.requestId);
			if (replay) {
				if (replay.hash !== contentDigest) throw new IdempotencyConflict(input.requestId);
				return replay.receipt;
			}
			const previous = liveRecord(state, scope, id);
			if ((previous?.revision ?? null) !== input.expectedRevision)
				throw new VersionConflict(input.expectedRevision ?? 0, previous?.revision ?? 0);
			validateDerivations(state, input.record, this.principal.readScopes);
			const candidate: MemoryRecord = structuredClone({
				...input.record,
				revision: (previous?.revision ?? 0) + 1,
				updatedAt: Date.now(),
			});
			validateMemoryRecord(candidate);
			if (
				previous?.status === "withdrawn" ||
				recordFingerprints(candidate).some((fingerprint) => state.tombstones.includes(fingerprint))
			)
				throw new Error("Withdrawn memory requires explicit restoration");
			state.records = state.records.filter((record) => formatScope(record.scope) !== scope || record.id !== id);
			state.records.push(candidate);
			const receipt: MemoryReceipt = {
				requestId: input.requestId,
				state: "committed",
				id,
				scope,
				revision: candidate.revision,
			};
			state.receipts.push({ requestId: input.requestId, hash: contentDigest, receipt });
			return receipt;
		});
	}

	/** Withdrawal propagates transitively through derivedFrom via the frozen planner. */
	async withdraw(requestId: string, scope: string, id: string, expectedRevision: number): Promise<MemoryReceipt> {
		requireWrite(this.principal, scope);
		if (
			!requestId ||
			requestId.length > 200 ||
			!id ||
			!Number.isSafeInteger(expectedRevision) ||
			expectedRevision < 1
		)
			throw new Error("Invalid withdrawal");
		const contentDigest = withdrawContentDigest(scope, id, expectedRevision);
		return this.store.update((state) => {
			if (state.version !== 1) throw new Error("Unsupported record store version");
			const replay = state.receipts.find((entry) => entry.requestId === requestId);
			if (replay) {
				if (replay.hash !== contentDigest) throw new IdempotencyConflict(requestId);
				return replay.receipt;
			}
			const previous = liveRecord(state, scope, id);
			if (!previous || previous.revision !== expectedRevision)
				throw new VersionConflict(expectedRevision, previous?.revision ?? 0);
			if (previous.status === "withdrawn") throw new Error("Memory already withdrawn");
			const withdrawn: MemoryRecord = {
				...previous,
				status: "withdrawn",
				revision: previous.revision + 1,
				updatedAt: Date.now(),
			};
			state.records = state.records.filter((record) => formatScope(record.scope) !== scope || record.id !== id);
			state.records.push(withdrawn);
			for (const fingerprint of recordFingerprints(previous)) state.tombstones.push(fingerprint);
			// Same closure as the database: candidates are every live record in the
			// readable scopes that participates in any derivation chain.
			const candidates = state.records.filter(
				(record) =>
					record.derivedFrom.length > 0 &&
					record.status !== "withdrawn" &&
					this.principal.readScopes.includes(formatScope(record.scope)),
			);
			const plan = planWithdrawal(
				withdrawn,
				candidates.map((record) => structuredClone(record)),
			);
			for (const link of plan.invalidDerivatives) {
				const derivative = liveRecord(state, link.scope, link.id);
				if (!derivative || derivative.revision !== link.revision || derivative.status === "withdrawn") continue;
				const next: MemoryRecord = {
					...derivative,
					status: "withdrawn",
					revision: derivative.revision + 1,
					updatedAt: Date.now(),
				};
				state.records = state.records.filter(
					(record) => formatScope(record.scope) !== link.scope || record.id !== link.id,
				);
				state.records.push(next);
				for (const fingerprint of recordFingerprints(derivative)) state.tombstones.push(fingerprint);
			}
			const receipt: MemoryReceipt = { requestId, state: "committed", id, scope, revision: withdrawn.revision };
			state.receipts.push({ requestId, hash: contentDigest, receipt });
			return receipt;
		});
	}

	/** Live record view; withdrawn records are absent, matching the database read path. */
	async getRecord(scope: string, id: string): Promise<MemoryRecord | undefined> {
		if (!this.principal.readScopes.includes(scope)) return undefined;
		const state = await this.store.read();
		const record = liveRecord(state, scope, id);
		return record && record.status !== "withdrawn" ? structuredClone(record) : undefined;
	}

	async read(): Promise<RecordStoreState> {
		return this.store.read();
	}
}
