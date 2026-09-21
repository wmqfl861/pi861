import {
	checkPrincipal, contentFingerprint, digest, sourceFingerprint, requireWrite, validateMemory,
	type MemoryBackend, type MemoryInput, type MemoryItem, type MemoryPrincipal, type MemoryReceipt, type MemoryWrite,
} from "./memory.ts";

/** Compatible with an adapter around pg.Pool; no driver or secret is exposed to an LLM. */
export interface SqlConnection {
	query(sql: string, parameters?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
	release(): void;
}
export interface SqlPool { connect(): Promise<SqlConnection>; }

/**
 * PostgreSQL authoritative store. Provision sql/memory-v1.sql separately.
 * All writes, revisions, outbox events and idempotency receipts commit together.
 */
export class PostgresMemory implements MemoryBackend {
	private readonly pool: SqlPool;
	private readonly principal: MemoryPrincipal;
	constructor(pool: SqlPool, principal: MemoryPrincipal) {
		checkPrincipal(principal);
		this.pool = pool;
		this.principal = structuredClone(principal);
	}
	private async transaction<T>(fn: (connection: SqlConnection) => Promise<T>): Promise<T> {
		const connection = await this.pool.connect();
		try {
			await connection.query("BEGIN");
			await connection.query(
				"SELECT set_config('pi861.tenant_id', $1, true), set_config('pi861.principal_id', $2, true), " +
				"set_config('pi861.read_scopes', $3, true), set_config('pi861.write_scopes', $4, true), " +
				"set_config('statement_timeout', '10000', true), set_config('lock_timeout', '5000', true)",
				[this.principal.tenantId, this.principal.principalId,
					JSON.stringify(this.principal.readScopes), JSON.stringify(this.principal.writeScopes)],
			);
			const result = await fn(connection);
			await connection.query("COMMIT");
			return result;
		} catch (error) {
			await connection.query("ROLLBACK").catch(() => {});
			throw error; // Caller retains requestId after an ambiguous COMMIT response.
		} finally { connection.release(); }
	}
	async get(scope: string, id: string): Promise<MemoryItem | undefined> {
		if (!this.principal.readScopes.includes(scope)) return undefined;
		return this.transaction(async (connection) => {
			const result = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 " +
				"AND body->>'status' <> 'withdrawn'",
				[this.principal.tenantId, scope, id],
			);
			return result.rows[0] ? structuredClone(result.rows[0].body as MemoryItem) : undefined;
		});
	}
	async search(query: string, limit = 8): Promise<MemoryItem[]> {
		if (!query.trim() || query.length > 2000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new Error("Invalid memory query");
		}
		return this.transaction(async (connection) => {
			const result = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=ANY($2::text[]) " +
				"AND body->>'status' <> 'withdrawn' AND " +
				"(to_tsvector('simple', coalesce(body->>'full','')) @@ plainto_tsquery('simple',$3) " +
				"OR strpos(lower(body->>'full'),lower($3)) > 0) ORDER BY updated_at DESC, memory_id LIMIT $4",
				[this.principal.tenantId, this.principal.readScopes, query.trim(), limit],
			);
			return result.rows.map((row) => structuredClone(row.body as MemoryItem));
		});
	}
	private async mutate(
		requestId: string, scope: string, id: string, expectedRevision: number | null, item: MemoryInput | undefined,
	): Promise<MemoryReceipt> {
		requireWrite(this.principal, scope);
		const hash = digest({ requestId, scope, id, expectedRevision, item: item ?? null });
		return this.transaction(async (connection) => {
			// Fixed ordering prevents receipt races followed by scope-write races.
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
				[JSON.stringify([this.principal.tenantId, this.principal.principalId, requestId])]);
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
				[JSON.stringify([this.principal.tenantId, scope])]);
			const stored = await connection.query(
				"SELECT intent_hash, receipt FROM pi861_memory_receipts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3",
				[this.principal.tenantId, this.principal.principalId, requestId],
			);
			const replay = stored.rows[0];
			if (replay) {
				if (replay.intent_hash !== hash) throw new Error("Memory idempotency conflict");
				return structuredClone(replay.receipt as MemoryReceipt);
			}
			const result = await connection.query(
				"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 FOR UPDATE",
				[this.principal.tenantId, scope, id],
			);
			const previous = result.rows[0]?.body as MemoryItem | undefined;
			if ((previous?.revision ?? null) !== expectedRevision) throw new Error("Memory revision conflict");
			let next: MemoryItem;
			if (item) {
				const suppressed = await connection.query(
					"SELECT fingerprint FROM pi861_memory_tombstones WHERE tenant_id=$1 AND scope_key=$2 AND fingerprint=ANY($3::text[])",
					[this.principal.tenantId, scope, [contentFingerprint(item), sourceFingerprint(item)]],
				);
				if (suppressed.rows.length || previous?.status === "withdrawn") throw new Error("Withdrawn memory requires explicit restoration");
				next = { ...structuredClone(item), revision: (previous?.revision ?? 0) + 1, updatedAt: Date.now() };
			} else {
				if (!previous) throw new Error("Memory not found");
				next = { ...previous, status: "withdrawn", revision: previous.revision + 1, updatedAt: Date.now() };
				for (const fingerprint of [contentFingerprint(previous), sourceFingerprint(previous)]) {
					await connection.query(
						"INSERT INTO pi861_memory_tombstones(tenant_id,scope_key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
						[this.principal.tenantId, scope, fingerprint],
					);
				}
			}
			await connection.query(
				"INSERT INTO pi861_memory_items(tenant_id,scope_key,memory_id,revision,body,fingerprint) " +
				"VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(tenant_id,scope_key,memory_id) " +
				"DO UPDATE SET revision=EXCLUDED.revision,body=EXCLUDED.body,fingerprint=EXCLUDED.fingerprint,updated_at=clock_timestamp()",
				[this.principal.tenantId, scope, id, next.revision, JSON.stringify(next), contentFingerprint(next)],
			);
			await connection.query(
				"INSERT INTO pi861_memory_versions(tenant_id,scope_key,memory_id,revision,body) VALUES($1,$2,$3,$4,$5::jsonb)",
				[this.principal.tenantId, scope, id, next.revision, JSON.stringify(next)],
			);
			await connection.query(
				"INSERT INTO pi861_memory_outbox(tenant_id,scope_key,memory_id,revision,action) VALUES($1,$2,$3,$4,$5)",
				[this.principal.tenantId, scope, id, next.revision, item ? "index" : "withdraw"],
			);
			const receipt: MemoryReceipt = { requestId, state: "committed", id, scope, revision: next.revision };
			await connection.query(
				"INSERT INTO pi861_memory_receipts(tenant_id,principal_id,request_id,scope_key,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
				[this.principal.tenantId, this.principal.principalId, requestId, scope, hash, JSON.stringify(receipt)],
			);
			return receipt;
		});
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
}
