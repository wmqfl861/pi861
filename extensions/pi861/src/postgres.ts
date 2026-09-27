import { randomUUID } from "node:crypto";
import { formatScope } from "./contracts/identity.ts";
import { type AssemblyMode, type MemoryRecord, planWithdrawal, validateMemoryRecord } from "./contracts/memory.ts";
import { IdempotencyConflict, VersionConflict } from "./contracts/storage.ts";
import { abortable } from "./live/deadline.ts";
import {
	classifyExtractionFailure,
	DEFAULT_BACKOFF_BASE_MS,
	DEFAULT_BACKOFF_CAP_MS,
	DEFAULT_MAX_EXTRACTION_ATTEMPTS,
	type EnrichmentJobView,
	type ExtractionFailureClass,
	failureBackoffMs,
	type MemoryExtractor,
	validateExtractionOutput,
	withheldFailureText,
} from "./live/extraction.ts";
import {
	checkPrincipal,
	contextPack,
	digest,
	type MemoryBackend,
	type MemoryInput,
	type MemoryItem,
	type MemoryPrincipal,
	type MemoryReceipt,
	type MemoryWrite,
	requireWrite,
	validateMemory,
} from "./memory.ts";
import {
	assembleRecords,
	type MemoryRecordWrite,
	putContentDigest,
	putRecordContentDigest,
	recordFingerprints,
	toItem,
	toRecord,
	withdrawContentDigest,
} from "./memory-records.ts";

/** Compatible with an adapter around pg.Pool; no driver or secret is exposed to an LLM. */
export interface SqlConnection {
	query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
	release(): void;
}
export interface SqlPool {
	connect(): Promise<SqlConnection>;
}

export interface MemoryChangeEvent {
	sequence: number;
	scope: string;
	id: string;
	revision: number;
	withdrawn: boolean;
}
export interface ProjectionBody {
	sourceRevision: number;
	abstract: string;
	overview: string;
	facts: { text: string; quote: string }[];
	model: string;
	createdAt: number;
}
export interface AssemblyOptions {
	mode?: AssemblyMode;
	maxBytes?: number;
	fetchLimit?: number;
}

/**
 * PostgreSQL authoritative memory service over the C6 record model. Items, versions,
 * tombstones, receipts, change events, projections and extraction jobs commit in one
 * transaction (C4: persist before receipt, outbox appended atomically); an ambiguous
 * commit is adjudicated through reconcile() with the original requestId.
 */
export class PostgresMemory implements MemoryBackend {
	private readonly pool: SqlPool;
	private readonly principal: MemoryPrincipal;
	constructor(pool: SqlPool, principal: MemoryPrincipal) {
		checkPrincipal(principal);
		this.pool = pool;
		this.principal = structuredClone(principal);
	}
	/** Refuse old schemas or privileged runtime credentials before host registration. */
	async ready(): Promise<void> {
		await this.transaction(async (connection) => {
			const schema = await connection.query("SELECT version FROM pi861_schema_migrations WHERE version='memory-v3'");
			if (!schema.rows.length) throw new Error("Run the explicit memory-v3 migration before starting the runtime");
			const role = await connection.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user");
			if (!role.rows[0] || role.rows[0].rolsuper || role.rows[0].rolbypassrls)
				throw new Error("Memory runtime requires a non-superuser NOBYPASSRLS account");
		});
	}
	private async transaction<T>(fn: (connection: SqlConnection) => Promise<T>): Promise<T> {
		const connection = await this.pool.connect();
		try {
			await connection.query("BEGIN");
			await connection.query(
				"SELECT set_config('pi861.tenant_id', $1, true), set_config('pi861.principal_id', $2, true), " +
					"set_config('pi861.read_scopes', $3, true), set_config('pi861.write_scopes', $4, true), " +
					"set_config('statement_timeout', '10000', true), set_config('lock_timeout', '5000', true)",
				[
					this.principal.tenantId,
					this.principal.principalId,
					JSON.stringify(this.principal.readScopes),
					JSON.stringify(this.principal.writeScopes),
				],
			);
			const result = await fn(connection);
			await connection.query("COMMIT");
			return result;
		} catch (error) {
			await connection.query("ROLLBACK").catch(() => {});
			throw error; // Caller retains requestId after an ambiguous COMMIT response.
		} finally {
			connection.release();
		}
	}
	private async mutation<T>(fn: (connection: SqlConnection) => Promise<T>): Promise<T> {
		return this.transaction(async (connection) => {
			// Serialize event allocation through commit within one tenant: identity sequences
			// alone can commit out of order and make a delta cursor skip a late transaction.
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify(["pi861.memory.commit", this.principal.tenantId]),
			]);
			return fn(connection);
		});
	}
	private storedRecord(row: { body?: unknown } | undefined): MemoryRecord | undefined {
		if (!row?.body || typeof row.body !== "object") return undefined;
		const body = row.body as Partial<MemoryRecord>;
		if (
			typeof body.id !== "string" ||
			typeof body.purpose !== "string" ||
			!body.scope ||
			typeof body.scope !== "object"
		)
			throw new Error("Legacy kernel memory body; run the pi861 v3 record-model migration first");
		validateMemoryRecord(row.body as MemoryRecord);
		return structuredClone(row.body as MemoryRecord);
	}
	/** Projection overlay: derived summaries replace the stored segments only while bound to the current revision. */
	private overlay(
		record: MemoryRecord,
		projection: { p_abstract?: unknown; p_overview?: unknown; source_revision?: unknown } | undefined,
	): MemoryRecord {
		if (!projection || Number(projection.source_revision) !== record.revision) return record;
		const abstract = typeof projection.p_abstract === "string" ? projection.p_abstract : record.abstract;
		const overview = typeof projection.p_overview === "string" ? projection.p_overview : record.overview;
		return {
			...record,
			abstract,
			overview: `${overview}\n[Generated from revision ${record.revision}; original source: ${record.provenance[0]?.ref ?? "unknown"}]`,
		};
	}
	private readonly projectionJoin =
		"LEFT JOIN pi861_memory_projections p ON p.tenant_id=i.tenant_id AND p.scope_key=i.scope_key AND p.memory_id=i.memory_id";
	private readonly projectionColumns = "i.body, p.abstract AS p_abstract, p.overview AS p_overview, p.source_revision";

	async get(scope: string, id: string): Promise<MemoryItem | undefined> {
		const record = await this.getRecord(scope, id);
		return record ? toItem(record) : undefined;
	}
	async getRecord(scope: string, id: string): Promise<MemoryRecord | undefined> {
		if (!this.principal.readScopes.includes(scope)) return undefined;
		return this.transaction(async (connection) => {
			const result = await connection.query(
				`SELECT i.body, p.abstract AS p_abstract, p.overview AS p_overview, p.source_revision FROM pi861_memory_items i ${this.projectionJoin} ` +
					"WHERE i.tenant_id=$1 AND i.scope_key=$2 AND i.memory_id=$3 AND i.body->>'status' <> 'withdrawn'",
				[this.principal.tenantId, scope, id],
			);
			const row = result.rows[0];
			const record = this.storedRecord(row);
			return record ? this.overlay(record, row) : undefined;
		});
	}
	/**
	 * Keyword retrieval baseline: 'simple' tsvector ANDs the query terms, a parameterized
	 * strpos conjunction is the substring fallback that carries CJK text, code symbols and
	 * file paths; ranking prefers lexical rank, then earliest substring position, then
	 * recency. pgvector remains an unbuilt enhancement and is refused at configuration.
	 */
	async search(query: string, limit = 8): Promise<MemoryItem[]> {
		if (!query.trim() || query.length > 2000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("Invalid memory query");
		}
		const words = [...new Set(query.trim().toLowerCase().split(/\s+/))].slice(0, 8);
		if (!words.length) throw new Error("Invalid memory query");
		const substring = words
			.map((_word, index) => `strpos(lower(coalesce(i.body->>'full','')), lower($${4 + index})) > 0`)
			.join(" AND ");
		return this.transaction(async (connection) => {
			const result = await connection.query(
				`SELECT ${this.projectionColumns}, ` +
					"ts_rank(to_tsvector('simple', coalesce(i.body->>'full','')), plainto_tsquery('simple', $3)) AS rank, " +
					"(CASE " +
					words
						.map(
							(_word, index) =>
								`WHEN strpos(lower(coalesce(i.body->>'full','')), lower($${4 + index})) > 0 THEN strpos(lower(coalesce(i.body->>'full','')), lower($${4 + index}))`,
						)
						.join(" ") +
					" ELSE 2147483647 END) AS first_pos " +
					`FROM pi861_memory_items i ${this.projectionJoin} ` +
					"WHERE i.tenant_id=$1 AND i.scope_key=ANY($2::text[]) AND i.body->>'status' <> 'withdrawn' AND " +
					"(to_tsvector('simple', coalesce(i.body->>'full','')) @@ plainto_tsquery('simple', $3) OR " +
					substring +
					") " +
					`ORDER BY rank DESC, first_pos, i.updated_at DESC, i.memory_id LIMIT $${4 + words.length}`,
				[this.principal.tenantId, this.principal.readScopes, query.trim(), ...words, limit],
			);
			return result.rows.map((row) => toItem(this.overlay(this.storedRecord(row) as MemoryRecord, row)));
		});
	}
	private async mutate(
		requestId: string,
		scope: string,
		id: string,
		expectedRevision: number | null,
		item: MemoryInput | undefined,
	): Promise<MemoryReceipt> {
		requireWrite(this.principal, scope);
		const contentDigest = item
			? putContentDigest(scope, id, expectedRevision, item)
			: withdrawContentDigest(scope, id, expectedRevision ?? 0);
		return this.mutation(async (connection) => {
			// Fixed ordering prevents receipt races followed by scope-write races.
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify([this.principal.tenantId, this.principal.principalId, requestId]),
			]);
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify([this.principal.tenantId, scope]),
			]);
			const stored = await connection.query(
				"SELECT intent_hash, receipt FROM pi861_memory_receipts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3",
				[this.principal.tenantId, this.principal.principalId, requestId],
			);
			const replay = stored.rows[0];
			if (replay) {
				const migratedReplay = await connection.query(
					"SELECT intent_hash FROM pi861_memory_legacy_receipts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3",
					[this.principal.tenantId, this.principal.principalId, requestId],
				);
				const hashes = [contentDigest];
				if (migratedReplay.rows.length) {
					hashes.push(digest({ requestId, scope, id, expectedRevision, item: item ?? null }));
					hashes.push(
						item
							? digest({ operation: "put", input: { requestId, expectedRevision, item } })
							: digest({ operation: "withdraw", requestId, scope, id, expectedRevision }),
					);
				}
				if (!hashes.includes(String(replay.intent_hash))) throw new IdempotencyConflict(requestId);
				return structuredClone(replay.receipt as MemoryReceipt);
			}
			const result = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 FOR UPDATE",
				[this.principal.tenantId, scope, id],
			);
			const previous = this.storedRecord(result.rows[0]);
			if ((previous?.revision ?? null) !== expectedRevision) {
				throw new VersionConflict(expectedRevision ?? 0, previous?.revision ?? 0);
			}
			const now = Date.now();
			let record: MemoryRecord;
			if (item) {
				const fingerprints = recordFingerprints(
					toRecord({ ...item, revision: (previous?.revision ?? 0) + 1, updatedAt: now, status: item.status }),
				);
				const suppressed = await connection.query(
					"SELECT fingerprint FROM pi861_memory_tombstones WHERE tenant_id=$1 AND scope_key=$2 AND fingerprint=ANY($3::text[])",
					[this.principal.tenantId, scope, fingerprints],
				);
				if (suppressed.rows.length || previous?.status === "withdrawn")
					throw new Error("Withdrawn memory requires explicit restoration");
				record = toRecord({
					...item,
					revision: (previous?.revision ?? 0) + 1,
					updatedAt: now,
					status: item.status,
				});
			} else {
				if (!previous) throw new Error("Memory not found");
				record = { ...previous, status: "withdrawn", revision: previous.revision + 1, updatedAt: now };
			}
			await this.upsertItem(connection, record);
			await this.appendEvent(connection, record, item ? "put" : "withdraw");
			if (item) {
				// Fresh user/tool provenance schedules extraction; superseded work is obsoleted in the same commit.
				if (record.provenance.some((entry) => entry.sourceKind === "user" || entry.sourceKind === "tool")) {
					await connection.query(
						"INSERT INTO pi861_memory_jobs(tenant_id,job_id,scope_key,memory_id,source_revision,max_attempts) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,job_id) DO NOTHING",
						[
							this.principal.tenantId,
							digest([formatScope(record.scope), record.id, record.revision]),
							scope,
							id,
							record.revision,
							DEFAULT_MAX_EXTRACTION_ATTEMPTS,
						],
					);
				}
				await connection.query(
					"UPDATE pi861_memory_jobs SET state='obsolete', finished_at=clock_timestamp(), lease_token=NULL, lease_expires_at=NULL WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 AND source_revision <> $4 AND state <> 'done'",
					[this.principal.tenantId, scope, id, record.revision],
				);
			} else {
				// Withdrawal fingerprints cover scope, full text and provenance only, so the
				// withdrawn record carries the same fingerprints as its pre-withdrawal source.
				for (const fingerprint of recordFingerprints(record)) {
					await connection.query(
						"INSERT INTO pi861_memory_tombstones(tenant_id,scope_key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
						[this.principal.tenantId, scope, fingerprint],
					);
				}
				await connection.query(
					"DELETE FROM pi861_memory_projections WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3",
					[this.principal.tenantId, scope, id],
				);
				await connection.query(
					"UPDATE pi861_memory_jobs SET state='obsolete', finished_at=clock_timestamp() WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3",
					[this.principal.tenantId, scope, id],
				);
				await this.invalidateDependents(connection, record, record);
			}
			const receipt: MemoryReceipt = { requestId, state: "committed", id, scope, revision: record.revision };
			await connection.query(
				"INSERT INTO pi861_memory_receipts(tenant_id,principal_id,request_id,scope_key,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
				[
					this.principal.tenantId,
					this.principal.principalId,
					requestId,
					scope,
					contentDigest,
					JSON.stringify(receipt),
				],
			);
			return receipt;
		});
	}
	/**
	 * Record-level put (P2-M consumer surface): stores the complete C6 record, so
	 * multi-entry provenance chains (adoption) and cross-record derivedFrom links
	 * survive. Withdrawal of any upstream record then propagates to these chains
	 * through the frozen planner. The item facade cannot express either shape.
	 */
	async putRecord(input: MemoryRecordWrite): Promise<MemoryReceipt> {
		validateMemoryRecord(input.record);
		if (input.record.status === "withdrawn") throw new Error("Use withdraw for record-level removal");
		const scope = formatScope(input.record.scope);
		requireWrite(this.principal, scope);
		const id = input.record.id;
		if (!input.requestId || input.requestId.length > 200) throw new Error("Invalid record write request");
		const contentDigest = putRecordContentDigest(scope, id, input.expectedRevision, input.record);
		return this.mutation(async (connection) => {
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify([this.principal.tenantId, this.principal.principalId, input.requestId]),
			]);
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify([this.principal.tenantId, scope]),
			]);
			const stored = await connection.query(
				"SELECT intent_hash, receipt FROM pi861_memory_receipts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3",
				[this.principal.tenantId, this.principal.principalId, input.requestId],
			);
			const replay = stored.rows[0];
			if (replay) {
				if (String(replay.intent_hash) !== contentDigest) throw new IdempotencyConflict(input.requestId);
				return structuredClone(replay.receipt as MemoryReceipt);
			}
			const result = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 FOR UPDATE",
				[this.principal.tenantId, scope, id],
			);
			const previous = this.storedRecord(result.rows[0]);
			if ((previous?.revision ?? null) !== input.expectedRevision)
				throw new VersionConflict(input.expectedRevision ?? 0, previous?.revision ?? 0);
			// Derivation links must reference live records within the read scopes; a
			// withdrawn or missing source never legitimizes a new derivative.
			for (const link of input.record.derivedFrom) {
				if (!this.principal.readScopes.includes(link.scope))
					throw new Error(`Derivation source scope is not readable: ${link.scope}`);
				const found = await connection.query(
					"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3",
					[this.principal.tenantId, link.scope, link.id],
				);
				const target = this.storedRecord(found.rows[0]);
				if (!target) throw new Error(`Unknown derivation source: ${link.scope}/${link.id}`);
				if (target.status === "withdrawn")
					throw new Error(`Derivation source is withdrawn: ${link.scope}/${link.id}`);
				if (target.revision < link.revision)
					throw new Error(`Derivation revision is in the future: ${link.scope}/${link.id}`);
			}
			const candidate: MemoryRecord = structuredClone({
				...input.record,
				revision: (previous?.revision ?? 0) + 1,
				updatedAt: Date.now(),
			});
			validateMemoryRecord(candidate);
			const fingerprints = recordFingerprints(candidate);
			const suppressed = await connection.query(
				"SELECT fingerprint FROM pi861_memory_tombstones WHERE tenant_id=$1 AND scope_key=$2 AND fingerprint=ANY($3::text[])",
				[this.principal.tenantId, scope, fingerprints],
			);
			if (suppressed.rows.length || previous?.status === "withdrawn")
				throw new Error("Withdrawn memory requires explicit restoration");
			await this.upsertItem(connection, candidate);
			await this.appendEvent(connection, candidate, "put");
			if (candidate.provenance.some((entry) => entry.sourceKind === "user" || entry.sourceKind === "tool")) {
				await connection.query(
					"INSERT INTO pi861_memory_jobs(tenant_id,job_id,scope_key,memory_id,source_revision,max_attempts) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,job_id) DO NOTHING",
					[
						this.principal.tenantId,
						digest([scope, candidate.id, candidate.revision]),
						scope,
						id,
						candidate.revision,
						DEFAULT_MAX_EXTRACTION_ATTEMPTS,
					],
				);
			}
			await connection.query(
				"UPDATE pi861_memory_jobs SET state='obsolete', finished_at=clock_timestamp(), lease_token=NULL, lease_expires_at=NULL WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 AND source_revision <> $4 AND state <> 'done'",
				[this.principal.tenantId, scope, id, candidate.revision],
			);
			const receipt: MemoryReceipt = {
				requestId: input.requestId,
				state: "committed",
				id,
				scope,
				revision: candidate.revision,
			};
			await connection.query(
				"INSERT INTO pi861_memory_receipts(tenant_id,principal_id,request_id,scope_key,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
				[
					this.principal.tenantId,
					this.principal.principalId,
					input.requestId,
					scope,
					contentDigest,
					JSON.stringify(receipt),
				],
			);
			return receipt;
		});
	}

	private async upsertItem(connection: SqlConnection, record: MemoryRecord): Promise<void> {
		const scope = formatScope(record.scope);
		await connection.query(
			"INSERT INTO pi861_memory_items(tenant_id,scope_key,memory_id,revision,body,fingerprint) " +
				"VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,scope_key,memory_id) " +
				"DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body,fingerprint=EXCLUDED.fingerprint,updated_at=clock_timestamp()",
			[
				this.principal.tenantId,
				scope,
				record.id,
				record.revision,
				JSON.stringify(record),
				recordFingerprints(record)[0],
			],
		);
		await connection.query(
			"INSERT INTO pi861_memory_versions(tenant_id,scope_key,memory_id,revision,body) VALUES($1,$2,$3,$4,$5::jsonb)",
			[this.principal.tenantId, scope, record.id, record.revision, JSON.stringify(record)],
		);
	}
	private async appendEvent(
		connection: SqlConnection,
		record: MemoryRecord,
		action: "put" | "withdraw" | "projection",
	): Promise<void> {
		await connection.query(
			"INSERT INTO pi861_memory_events(tenant_id,scope_key,memory_id,revision,action,event_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,event_digest) DO NOTHING",
			[
				this.principal.tenantId,
				formatScope(record.scope),
				record.id,
				record.revision,
				action,
				digest([
					"pi861.memory.event",
					this.principal.tenantId,
					formatScope(record.scope),
					record.id,
					record.revision,
					action,
				]),
			],
		);
	}
	/**
	 * C6 withdrawal propagation, transitive by contract: records derived (directly or
	 * through a chain) from the withdrawn source are withdrawn in the same transaction.
	 * The frozen planWithdrawal walks the derivedFrom closure recursively, so fetching
	 * every live record that participates in any derivation chain and delegating to it
	 * invalidates dependents-of-dependents, summaries (projections), pending extraction
	 * jobs and appends the withdraw events that index and cache consumers drain.
	 */
	private async invalidateDependents(
		connection: SqlConnection,
		_source: MemoryRecord,
		withdrawn: MemoryRecord,
	): Promise<void> {
		const dependents = await connection.query(
			"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=ANY($2::text[]) AND body->'derivedFrom' <> '[]'::jsonb AND body->>'status' <> 'withdrawn'",
			[this.principal.tenantId, this.principal.readScopes],
		);
		const plan = planWithdrawal(
			withdrawn,
			dependents.rows.map((row) => this.storedRecord(row) as MemoryRecord),
		);
		for (const link of plan.invalidDerivatives) {
			const found = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 FOR UPDATE",
				[this.principal.tenantId, link.scope, link.id],
			);
			const derivative = this.storedRecord(found.rows[0]);
			if (!derivative || derivative.revision !== link.revision) continue;
			const next: MemoryRecord = {
				...derivative,
				status: "withdrawn",
				revision: derivative.revision + 1,
				updatedAt: Date.now(),
			};
			await this.upsertItem(connection, next);
			for (const fingerprint of recordFingerprints(derivative)) {
				await connection.query(
					"INSERT INTO pi861_memory_tombstones(tenant_id,scope_key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
					[this.principal.tenantId, link.scope, fingerprint],
				);
			}
			await connection.query(
				"DELETE FROM pi861_memory_projections WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3",
				[this.principal.tenantId, link.scope, link.id],
			);
			await connection.query(
				"UPDATE pi861_memory_jobs SET state='obsolete', finished_at=clock_timestamp() WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3",
				[this.principal.tenantId, link.scope, link.id],
			);
			await this.appendEvent(connection, next, "withdraw");
		}
	}
	async put(input: MemoryWrite): Promise<MemoryReceipt> {
		validateMemory(input);
		return this.mutate(input.requestId, input.item.scope, input.item.id, input.expectedRevision, input.item);
	}
	async withdraw(requestId: string, scope: string, id: string, expectedRevision: number): Promise<MemoryReceipt> {
		if (!requestId || !id || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
			throw new Error("Invalid withdrawal");
		}
		return this.mutate(requestId, scope, id, expectedRevision, undefined);
	}
	/**
	 * C4 unknown-commit adjudication: after an ambiguous COMMIT response, the caller
	 * re-presents the requestId; the database is the single truth, so a stored receipt
	 * means committed and no row means not committed. A digest mismatch is a conflict.
	 */
	async reconcile(
		requestId: string,
		expectedDigest?: string,
	): Promise<{ state: "committed"; receipt: MemoryReceipt } | { state: "notCommitted" }> {
		if (!requestId || requestId.length > 200) throw new Error("Invalid reconciliation request");
		return this.mutation(async (connection) => {
			const stored = await connection.query(
				"SELECT intent_hash, receipt FROM pi861_memory_receipts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3",
				[this.principal.tenantId, this.principal.principalId, requestId],
			);
			const row = stored.rows[0];
			if (!row) return { state: "notCommitted" as const };
			if (expectedDigest !== undefined && row.intent_hash !== expectedDigest)
				throw new IdempotencyConflict(requestId);
			return { state: "committed" as const, receipt: structuredClone(row.receipt as MemoryReceipt) };
		});
	}
	/** SQL-pushed pagination over one readable scope, projection overlay included. */
	async list(scope: string, afterId = "", limit = 50): Promise<{ items: MemoryItem[]; nextId?: string }> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid page limit");
		if (!this.principal.readScopes.includes(scope)) return { items: [] };
		return this.transaction(async (connection) => {
			const result = await connection.query(
				`SELECT ${this.projectionColumns} FROM pi861_memory_items i ${this.projectionJoin} ` +
					"WHERE i.tenant_id=$1 AND i.scope_key=$2 AND i.body->>'status' <> 'withdrawn' AND i.memory_id > $3 " +
					"ORDER BY i.memory_id LIMIT $4",
				[this.principal.tenantId, scope, afterId, limit + 1],
			);
			const items = result.rows
				.slice(0, limit)
				.map((row) => toItem(this.overlay(this.storedRecord(row) as MemoryRecord, row)));
			return { items, ...(result.rows.length > limit ? { nextId: items.at(-1)?.id } : {}) };
		});
	}
	/** SQL-pushed incremental window over the monotonic event feed. */
	async delta(
		afterSequence = 0,
		limit = 50,
	): Promise<{ changes: MemoryChangeEvent[]; cursor: number; hasMore: boolean }> {
		if (
			!Number.isSafeInteger(afterSequence) ||
			afterSequence < 0 ||
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 100
		) {
			throw new Error("Invalid memory cursor");
		}
		return this.transaction(async (connection) => {
			const result = await connection.query(
				"SELECT sequence, scope_key, memory_id, revision, action FROM pi861_memory_events WHERE tenant_id=$1 AND sequence > $2 " +
					"AND scope_key = ANY($3::text[]) ORDER BY sequence LIMIT $4",
				[this.principal.tenantId, afterSequence, this.principal.readScopes, limit + 1],
			);
			const rows = result.rows.slice(0, limit);
			const changes: MemoryChangeEvent[] = rows.map((row) => ({
				sequence: Number(row.sequence),
				scope: String(row.scope_key),
				id: String(row.memory_id),
				revision: Number(row.revision),
				withdrawn: row.action === "withdraw",
			}));
			return { changes, cursor: changes.at(-1)?.sequence ?? afterSequence, hasMore: result.rows.length > limit };
		});
	}
	async pack(query: string, maxBytes = 6000): Promise<ReturnType<typeof contextPack>> {
		const found = await this.search(query, 12);
		return contextPack(found, { level: 1, maxBytes });
	}
	/** Necessary-state assembly delegated to the C6 packer over SQL-fetched records. */
	async assemble(options: AssemblyOptions = {}): Promise<ReturnType<typeof assembleRecords>> {
		const maxBytes = options.maxBytes ?? 6000;
		const fetchLimit = options.fetchLimit ?? 1000;
		if (
			!Number.isSafeInteger(maxBytes) ||
			maxBytes < 1 ||
			!Number.isSafeInteger(fetchLimit) ||
			fetchLimit < 1 ||
			fetchLimit > 10_000
		) {
			throw new Error("Invalid assembly options");
		}
		const mode = options.mode ?? "startup";
		const purposes =
			mode === "event-recall"
				? ["constraint", "working", "project", "experience", "evidence"]
				: ["constraint", "working", "project"];
		const records = await this.transaction(async (connection) => {
			const result = await connection.query(
				`SELECT ${this.projectionColumns} FROM pi861_memory_items i ${this.projectionJoin} ` +
					"WHERE i.tenant_id=$1 AND i.scope_key=ANY($2::text[]) AND i.body->>'status' <> 'withdrawn' AND i.purpose = ANY($3::text[]) " +
					"ORDER BY CASE i.purpose WHEN 'constraint' THEN 0 WHEN 'working' THEN 1 ELSE 2 END, i.memory_id, i.scope_key LIMIT $4",
				[this.principal.tenantId, this.principal.readScopes, purposes, fetchLimit],
			);
			return result.rows.map((row) => this.overlay(this.storedRecord(row) as MemoryRecord, row));
		});
		return assembleRecords(records, { mode, maxBytes, readableScopes: this.principal.readScopes });
	}
	async listJobs(): Promise<EnrichmentJobView[]> {
		return this.transaction(async (connection) => {
			const result = await connection.query(
				"SELECT job_id, scope_key, memory_id, source_revision, state, attempts, failures, failure_class, next_attempt_at, last_error, requeues, lease_expires_at " +
					"FROM pi861_memory_jobs WHERE tenant_id=$1 AND scope_key=ANY($2::text[]) ORDER BY created_at, job_id",
				[this.principal.tenantId, this.principal.readScopes],
			);
			return result.rows.map(jobView);
		});
	}
	/** Manual recovery path for jobs parked in the terminal failed state. */
	async requeueJob(jobId: string): Promise<EnrichmentJobView> {
		if (!jobId) throw new Error("Invalid job identity");
		return this.transaction(async (connection) => {
			const result = await connection.query(
				"UPDATE pi861_memory_jobs SET state='queued', failures=0, failure_class=NULL, next_attempt_at=NULL, finished_at=NULL, requeues=requeues+1 " +
					"WHERE tenant_id=$1 AND job_id=$2 AND state='failed' AND scope_key=ANY($3::text[]) RETURNING " +
					"job_id, scope_key, memory_id, source_revision, state, attempts, failures, failure_class, next_attempt_at, last_error, requeues, lease_expires_at",
				[this.principal.tenantId, jobId, this.principal.writeScopes],
			);
			const row = result.rows[0];
			if (!row) {
				const known = await connection.query(
					"SELECT state FROM pi861_memory_jobs WHERE tenant_id=$1 AND job_id=$2 AND scope_key=ANY($3::text[])",
					[this.principal.tenantId, jobId, this.principal.readScopes],
				);
				if (!known.rows[0]) throw new Error("Unknown enrichment job");
				throw new Error("Only failed enrichment jobs can be requeued");
			}
			return jobView(row);
		});
	}
	/**
	 * Extraction loop over the durable job table: the claim and the commit are separate
	 * transactions and the model call runs between them, outside any storage lock; the
	 * commit revalidates the source revision, withdrawal state and the lease token.
	 */
	async enrich(
		extractor: MemoryExtractor,
		options: {
			signal: AbortSignal;
			maxJobs?: number;
			timeoutMs?: number;
			maxAttempts?: number;
			backoffBaseMs?: number;
			backoffCapMs?: number;
			classifyFailure?: (error: unknown) => ExtractionFailureClass;
		},
	): Promise<{ completed: number; failed: number; obsolete: number }> {
		const max = options.maxJobs ?? 4,
			timeoutMs = options.timeoutMs ?? 60_000;
		const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_EXTRACTION_ATTEMPTS;
		const baseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS,
			capMs = options.backoffCapMs ?? DEFAULT_BACKOFF_CAP_MS;
		if (
			!Number.isInteger(max) ||
			max < 1 ||
			max > 100 ||
			timeoutMs < 1 ||
			!Number.isInteger(maxAttempts) ||
			maxAttempts < 1 ||
			maxAttempts > 100 ||
			!Number.isInteger(baseMs) ||
			baseMs < 0 ||
			!Number.isInteger(capMs) ||
			capMs < 1 ||
			baseMs > capMs
		) {
			throw new Error("Invalid enrichment budget");
		}
		const stats = { completed: 0, failed: 0, obsolete: 0 };
		for (let index = 0; index < max; index++) {
			options.signal.throwIfAborted();
			const work = await this.transaction(async (connection) => {
				const claimed = await connection.query(
					"UPDATE pi861_memory_jobs SET state='running', attempts=attempts+1, lease_token=$3, " +
						"lease_expires_at=clock_timestamp()+($4::bigint * interval '1 millisecond'), next_attempt_at=NULL, max_attempts=$5 " +
						"WHERE tenant_id=$1 AND job_id=(SELECT job_id FROM pi861_memory_jobs WHERE tenant_id=$1 AND scope_key=ANY($2::text[]) " +
						"AND ((state='queued' AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp())) " +
						"OR (state='running' AND lease_expires_at<=clock_timestamp())) " +
						"ORDER BY created_at, job_id LIMIT 1 FOR UPDATE SKIP LOCKED) " +
						"RETURNING job_id, scope_key, memory_id, source_revision, lease_token",
					[this.principal.tenantId, this.principal.writeScopes, randomUUID(), timeoutMs + 5000, maxAttempts],
				);
				const job = claimed.rows[0];
				if (!job) return undefined;
				const found = await connection.query(
					"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3",
					[this.principal.tenantId, job.scope_key, job.memory_id],
				);
				const record = this.storedRecord(found.rows[0]);
				if (!record || record.revision !== Number(job.source_revision) || record.status === "withdrawn") {
					await connection.query(
						"UPDATE pi861_memory_jobs SET state='obsolete', finished_at=clock_timestamp(), lease_token=NULL, lease_expires_at=NULL WHERE tenant_id=$1 AND job_id=$2",
						[this.principal.tenantId, job.job_id],
					);
					return { obsolete: true as const };
				}
				return {
					obsolete: false as const,
					jobId: String(job.job_id),
					token: String(job.lease_token),
					record: structuredClone(record),
				};
			});
			if (!work) break;
			if (work.obsolete) {
				stats.obsolete++;
				continue;
			}
			const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
			try {
				const result = validateExtractionOutput(
					await abortable(
						extractor.extract(
							{
								id: work.record.id,
								revision: work.record.revision,
								text: work.record.full,
								source: {
									kind: work.record.provenance[0]?.sourceKind ?? "tool",
									ref: work.record.provenance[0]?.ref ?? "",
								},
							},
							signal,
						),
						signal,
					),
					work.record.full,
				);
				signal.throwIfAborted();
				const committed = await this.mutation(async (connection) => {
					const lease = await connection.query(
						"SELECT state, lease_token, lease_expires_at FROM pi861_memory_jobs WHERE tenant_id=$1 AND job_id=$2 FOR UPDATE",
						[this.principal.tenantId, work.jobId],
					);
					const found = await connection.query(
						"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3",
						[this.principal.tenantId, formatScope(work.record.scope), work.record.id],
					);
					const current = this.storedRecord(found.rows[0]);
					const held = lease.rows[0];
					if (
						!held ||
						held.state !== "running" ||
						held.lease_token !== work.token ||
						new Date(String(held.lease_expires_at)).getTime() <= Date.now() ||
						!current ||
						current.revision !== work.record.revision ||
						current.status === "withdrawn"
					)
						return false;
					await connection.query(
						"INSERT INTO pi861_memory_projections(tenant_id,scope_key,memory_id,source_revision,abstract,overview,facts,model_id) " +
							"VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(tenant_id,scope_key,memory_id) DO UPDATE SET " +
							"source_revision=EXCLUDED.source_revision, abstract=EXCLUDED.abstract, overview=EXCLUDED.overview, facts=EXCLUDED.facts, model_id=EXCLUDED.model_id, created_at=clock_timestamp()",
						[
							this.principal.tenantId,
							formatScope(work.record.scope),
							work.record.id,
							work.record.revision,
							result.abstract,
							result.overview,
							JSON.stringify(result.facts),
							extractor.modelId,
						],
					);
					await connection.query(
						"UPDATE pi861_memory_jobs SET state='done', lease_token=NULL, lease_expires_at=NULL, finished_at=clock_timestamp() WHERE tenant_id=$1 AND job_id=$2",
						[this.principal.tenantId, work.jobId],
					);
					await this.appendEvent(connection, work.record, "projection");
					return true;
				});
				if (committed) stats.completed++;
				else stats.obsolete++;
			} catch (error) {
				const aborted = options.signal.aborted;
				const failureClass: ExtractionFailureClass = aborted
					? "transient"
					: (options.classifyFailure ?? classifyExtractionFailure)(error);
				const message = error instanceof Error ? error.message : "Extraction failed";
				await this.transaction(async (connection) => {
					if (aborted) {
						await connection.query(
							"UPDATE pi861_memory_jobs SET state='queued', lease_token=NULL, lease_expires_at=NULL WHERE tenant_id=$1 AND job_id=$2 AND state='running' AND lease_token=$3",
							[this.principal.tenantId, work.jobId, work.token],
						);
						return;
					}
					const counted = await connection.query(
						"UPDATE pi861_memory_jobs SET failures=failures+1, failure_class=$3, last_error=$4, lease_token=NULL, lease_expires_at=NULL " +
							"WHERE tenant_id=$1 AND job_id=$2 AND state='running' AND lease_token=$5 RETURNING failures",
						[this.principal.tenantId, work.jobId, failureClass, withheldFailureText(message), work.token],
					);
					const failures = Number(counted.rows[0]?.failures ?? 0);
					if (!counted.rows[0]) return;
					const terminal = failureClass !== "transient" || failures >= maxAttempts;
					if (terminal) {
						await connection.query(
							"UPDATE pi861_memory_jobs SET state='failed', finished_at=clock_timestamp(), next_attempt_at=NULL WHERE tenant_id=$1 AND job_id=$2",
							[this.principal.tenantId, work.jobId],
						);
					} else {
						await connection.query(
							"UPDATE pi861_memory_jobs SET state='queued', finished_at=NULL, next_attempt_at=clock_timestamp()+($3::bigint * interval '1 millisecond') WHERE tenant_id=$1 AND job_id=$2",
							[this.principal.tenantId, work.jobId, failureBackoffMs(failures, baseMs, capMs)],
						);
					}
				});
				if (aborted) throw error;
				stats.failed++;
			}
		}
		return stats;
	}
	/** Migration import: a projection bound to an exact source revision, replay-safe. */
	async importProjection(scope: string, id: string, projection: ProjectionBody): Promise<void> {
		requireWrite(this.principal, scope);
		await this.mutation(async (connection) => {
			const found = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3",
				[this.principal.tenantId, scope, id],
			);
			const record = this.storedRecord(found.rows[0]);
			if (!record || record.status === "withdrawn" || record.revision !== projection.sourceRevision)
				throw new Error("Projection import requires the exact live source revision");
			validateExtractionOutput(projection, record.full);
			await connection.query(
				"INSERT INTO pi861_memory_projections(tenant_id,scope_key,memory_id,source_revision,abstract,overview,facts,model_id) " +
					"VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT(tenant_id,scope_key,memory_id) DO NOTHING",
				[
					this.principal.tenantId,
					scope,
					id,
					record.revision,
					projection.abstract,
					projection.overview,
					JSON.stringify(projection.facts),
					projection.model,
				],
			);
			await this.appendEvent(connection, record, "projection");
		});
	}
}

function jobView(row: Record<string, unknown>): EnrichmentJobView {
	const nextAttempt =
		row.next_attempt_at === null || row.next_attempt_at === undefined
			? undefined
			: new Date(String(row.next_attempt_at)).getTime();
	const expires =
		row.lease_expires_at === null || row.lease_expires_at === undefined
			? undefined
			: new Date(String(row.lease_expires_at)).getTime();
	const failureClass =
		typeof row.failure_class === "string" ? (row.failure_class as EnrichmentJobView["failureClass"]) : undefined;
	return {
		id: String(row.job_id),
		scope: String(row.scope_key),
		memoryId: String(row.memory_id),
		revision: Number(row.source_revision),
		state: row.state as EnrichmentJobView["state"],
		attempts: Number(row.attempts),
		failures: Number(row.failures),
		...(failureClass ? { failureClass } : {}),
		...(nextAttempt !== undefined ? { nextAttemptAt: nextAttempt } : {}),
		lastError: typeof row.last_error === "string" ? row.last_error : undefined,
		requeues: Number(row.requeues),
		...(expires !== undefined ? { expiresAt: expires } : {}),
	};
}
