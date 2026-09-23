import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { formatScope } from "../contracts/identity.ts";
import { type MemoryRecord, validateMemoryRecord } from "../contracts/memory.ts";
import { digest, LocalMemory, type MemoryItem, type MemorySnapshot } from "../memory.ts";
import { recordFingerprints, toRecord } from "../memory-records.ts";
import type { SqlConnection, SqlPool } from "../postgres.ts";
import { validateExtractionOutput } from "./extraction.ts";
import type { LayeredMemoryState } from "./layered-memory.ts";

const TABLES = [
	"pi861_memory_items",
	"pi861_memory_versions",
	"pi861_memory_receipts",
	"pi861_memory_tombstones",
	"pi861_memory_outbox",
] as const;
const V3_TABLES = [
	"pi861_schema_migrations",
	"pi861_memory_legacy_receipts",
	"pi861_memory_imports",
	"pi861_memory_projections",
	"pi861_memory_jobs",
	"pi861_memory_events",
] as const;
interface MemoryBackup {
	format: 2;
	createdAt: number;
	schemaDigest: string;
	schemaVersion: "memory-v1" | "memory-v3";
	tables: Record<string, Record<string, unknown>[]>;
	sources: MemoryMigrationSource[];
}
export interface MemoryMigrationSource {
	/** Stable operator-owned source identity; never a model-selected database key. */
	id: string;
	state: MemorySnapshot | LayeredMemoryState;
}
export interface MemoryMigrationOptions {
	backupPath: string;
	writersStopped: true;
	sources?: MemoryMigrationSource[];
	runtimeSources?: { tenantId: string; stateKey: string; id: string }[];
}
export interface MemoryMigrationResult {
	version: "memory-v3";
	records: number;
	digest: string;
	backupPath: string;
	replayed: boolean;
}

function convert(body: unknown): MemoryRecord {
	if (!body || typeof body !== "object") throw new Error("Invalid legacy memory body");
	if ("purpose" in body) {
		const record = body as MemoryRecord;
		validateMemoryRecord(record);
		return structuredClone(record);
	}
	return toRecord(body as MemoryItem);
}

/** Offline, operator-only migration. Stop every old writer first; backup is written and fsynced
 * before conversions. The original runtime JSONB source is retained as an archive, never dual-written.
 * Restore the backup into a fresh schema using restoreMemoryBackup; switch writers only after verification.
 */
export async function migrateMemory(pool: SqlPool, options: MemoryMigrationOptions): Promise<MemoryMigrationResult> {
	if (options.writersStopped !== true || !isAbsolute(options.backupPath))
		throw new Error("Migration requires stopped writers and an absolute backup path");
	const schema = readFileSync(new URL("../../sql/memory-v3.sql", import.meta.url), "utf8");
	const schemaDigest = digest(schema);
	const connection = await pool.connect();
	try {
		await connection.query("BEGIN");
		await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('pi861.memory.migration',0))");
		const ledger = await connection.query("SELECT to_regclass('pi861_schema_migrations') AS present");
		const previous = ledger.rows[0]?.present
			? await connection.query("SELECT digest FROM pi861_schema_migrations WHERE version='memory-v3'")
			: { rows: [] };
		if (previous.rows[0] && previous.rows[0].digest !== schemaDigest)
			throw new Error("Memory schema migration digest mismatch");
		// FORCE RLS must not silently hide rows from the migration/backup account.
		const role = await connection.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user");
		if (!role.rows[0]?.rolsuper && !role.rows[0]?.rolbypassrls)
			throw new Error("Migration account must have explicitly provisioned BYPASSRLS; never use the runtime account");
		const backupTables = previous.rows.length ? [...TABLES, ...V3_TABLES] : [...TABLES];
		await connection.query(`LOCK TABLE ${backupTables.join(",")} IN ACCESS EXCLUSIVE MODE`);
		const tables: Record<string, Record<string, unknown>[]> = {};
		for (const table of backupTables) tables[table] = (await connection.query(`SELECT * FROM ${table}`)).rows;
		const sources = structuredClone(options.sources ?? []);
		if ((options.runtimeSources ?? []).length) tables.pi861_runtime_state = [];
		for (const source of options.runtimeSources ?? []) {
			const found = await connection.query(
				"SELECT * FROM pi861_runtime_state WHERE tenant_id=$1 AND state_key=$2 FOR UPDATE",
				[source.tenantId, source.stateKey],
			);
			if (!found.rows[0]) throw new Error(`Missing runtime memory source ${source.id}`);
			tables.pi861_runtime_state?.push(found.rows[0]);
			const state = found.rows[0].body as LayeredMemoryState;
			if (state.memory?.tenantId !== source.tenantId) throw new Error("Runtime memory source tenant mismatch");
			sources.push({ id: source.id, state });
		}
		const backup: MemoryBackup = JSON.parse(
			JSON.stringify({
				format: 2,
				createdAt: Date.now(),
				schemaDigest,
				schemaVersion: previous.rows.length ? "memory-v3" : "memory-v1",
				tables,
				sources,
			}),
		);
		const envelope = JSON.stringify({ digest: digest(backup), backup });
		const fd = openSync(options.backupPath, "wx", 0o600);
		try {
			writeFileSync(fd, envelope, "utf8");
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		await connection.query(schema.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, ""));
		for (const table of ["pi861_memory_items", "pi861_memory_versions"]) {
			for (const row of tables[table] ?? []) {
				const record = convert(row.body);
				if (
					formatScope(record.scope) !== row.scope_key ||
					record.id !== row.memory_id ||
					record.revision !== Number(row.revision)
				)
					throw new Error("Legacy row identity mismatch");
				await connection.query(
					`UPDATE ${table} SET body=$5::jsonb WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3 AND revision=$4`,
					[row.tenant_id, row.scope_key, row.memory_id, row.revision, JSON.stringify(record)],
				);
			}
		}
		for (const source of sources) await importSource(connection, source);
		await connection.query(
			"INSERT INTO pi861_memory_legacy_receipts(tenant_id,principal_id,request_id,scope_key,intent_hash) SELECT tenant_id,principal_id,request_id,scope_key,intent_hash FROM pi861_memory_receipts ON CONFLICT DO NOTHING",
		);
		const rows = await connection.query(
			"SELECT tenant_id, scope_key, memory_id, body FROM pi861_memory_items ORDER BY tenant_id, scope_key, memory_id",
		);
		for (const row of rows.rows) {
			const record = convert(row.body);
			await connection.query(
				"UPDATE pi861_memory_items SET fingerprint=$4 WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3",
				[row.tenant_id, row.scope_key, row.memory_id, recordFingerprints(record)[0]],
			);
			if (record.status === "withdrawn")
				for (const fingerprint of recordFingerprints(record)) {
					await connection.query(
						"INSERT INTO pi861_memory_tombstones(tenant_id,scope_key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
						[row.tenant_id, row.scope_key, fingerprint],
					);
				}
			await connection.query(
				"INSERT INTO pi861_memory_events(tenant_id,scope_key,memory_id,revision,action,event_digest) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
				[
					row.tenant_id,
					row.scope_key,
					row.memory_id,
					record.revision,
					record.status === "withdrawn" ? "withdraw" : "put",
					digest([
						"pi861.memory.event",
						row.tenant_id,
						row.scope_key,
						row.memory_id,
						record.revision,
						record.status === "withdrawn" ? "withdraw" : "put",
					]),
				],
			);
		}
		const verified = await connection.query(
			"SELECT tenant_id, scope_key, memory_id, body FROM pi861_memory_items ORDER BY tenant_id, scope_key, memory_id",
		);
		const expected = digest(rows.rows);
		if (digest(verified.rows) !== expected) throw new Error("Migration count/digest verification failed");
		await connection.query("ALTER TABLE pi861_memory_items VALIDATE CONSTRAINT pi861_scope_canonical");
		await connection.query(
			"INSERT INTO pi861_schema_migrations(version,name,digest) VALUES('memory-v3','authoritative memory records',$1) ON CONFLICT(version) DO NOTHING",
			[schemaDigest],
		);
		await connection.query("COMMIT");
		return {
			version: "memory-v3",
			records: rows.rows.length,
			digest: expected,
			backupPath: options.backupPath,
			replayed: Boolean(previous.rows.length),
		};
	} catch (error) {
		await connection.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

async function importSource(connection: SqlConnection, source: MemoryMigrationSource): Promise<void> {
	if (!source.id) throw new Error("Migration source identity is required");
	const layered = "memory" in source.state ? source.state : undefined;
	const snapshot = layered ? layered.memory : (source.state as MemorySnapshot);
	const scopes = [...new Set(snapshot.items.map((item) => item.scope))];
	new LocalMemory(
		{ tenantId: snapshot.tenantId, principalId: "migration", readScopes: scopes, writeScopes: scopes },
		snapshot,
	);
	const sourceDigest = digest(source.state);
	const prior = await connection.query("SELECT digest FROM pi861_memory_imports WHERE source_id=$1", [source.id]);
	if (prior.rows[0]) {
		if (prior.rows[0].digest !== sourceDigest)
			throw new Error("Migration source identity reused with different content");
		return;
	}
	for (const item of snapshot.items) {
		const record = toRecord(item);
		const existing = await connection.query(
			"SELECT body FROM pi861_memory_items WHERE tenant_id=$1 AND scope_key=$2 AND memory_id=$3",
			[snapshot.tenantId, item.scope, item.id],
		);
		if (existing.rows[0] && digest(convert(existing.rows[0].body)) !== digest(record))
			throw new Error(`Migration identity conflict: ${item.scope}/${item.id}`);
		await connection.query(
			"INSERT INTO pi861_memory_items(tenant_id,scope_key,memory_id,revision,body,fingerprint) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING",
			[snapshot.tenantId, item.scope, item.id, item.revision, JSON.stringify(record), recordFingerprints(record)[0]],
		);
		await connection.query(
			"INSERT INTO pi861_memory_versions(tenant_id,scope_key,memory_id,revision,body) VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT DO NOTHING",
			[snapshot.tenantId, item.scope, item.id, item.revision, JSON.stringify(record)],
		);
		const projection = layered?.projections[digest([item.scope, item.id])];
		if (projection && projection.sourceRevision === item.revision && item.status !== "withdrawn") {
			validateExtractionOutput(projection, item.full);
			await connection.query(
				"INSERT INTO pi861_memory_projections(tenant_id,scope_key,memory_id,source_revision,abstract,overview,facts,model_id) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) ON CONFLICT DO NOTHING",
				[
					snapshot.tenantId,
					item.scope,
					item.id,
					item.revision,
					projection.abstract,
					projection.overview,
					JSON.stringify(projection.facts),
					projection.model,
				],
			);
		}
	}
	// Legacy tombstone hashes are retained verbatim; current reads/writes check them too.
	for (const scope of scopes)
		for (const fingerprint of snapshot.tombstones)
			await connection.query(
				"INSERT INTO pi861_memory_tombstones(tenant_id,scope_key,fingerprint) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
				[snapshot.tenantId, scope, fingerprint],
			);
	for (const entry of snapshot.receipts) {
		const priorReceipt = await connection.query(
			"SELECT intent_hash,receipt FROM pi861_memory_receipts WHERE tenant_id=$1 AND principal_id=$2 AND request_id=$3",
			[snapshot.tenantId, entry.principalId, entry.requestId],
		);
		if (
			priorReceipt.rows[0] &&
			(priorReceipt.rows[0].intent_hash !== entry.hash ||
				digest(priorReceipt.rows[0].receipt) !== digest(entry.receipt))
		)
			throw new Error("Migration receipt conflict");
		await connection.query(
			"INSERT INTO pi861_memory_receipts(tenant_id,principal_id,request_id,scope_key,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING",
			[
				snapshot.tenantId,
				entry.principalId,
				entry.requestId,
				entry.receipt.scope,
				entry.hash,
				JSON.stringify(entry.receipt),
			],
		);
	}
	for (const job of layered?.jobs ?? []) {
		const item = snapshot.items.find((item) => item.id === job.memoryId && item.scope === job.scope);
		const state =
			!item || item.status === "withdrawn" || item.revision !== job.revision
				? "obsolete"
				: job.state === "running"
					? "queued"
					: job.state;
		await connection.query(
			"INSERT INTO pi861_memory_jobs(tenant_id,job_id,scope_key,memory_id,source_revision,state,attempts,failures,failure_class,next_attempt_at,requeues,last_error) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10::double precision/1000),$11,$12) ON CONFLICT DO NOTHING",
			[
				snapshot.tenantId,
				job.id,
				job.scope,
				job.memoryId,
				job.revision,
				state,
				job.attempts,
				job.failures ?? 0,
				job.failureClass ?? null,
				job.nextAttemptAt ?? null,
				job.requeues ?? 0,
				job.lastError ?? null,
			],
		);
	}
	await connection.query("INSERT INTO pi861_memory_imports(source_id,digest) VALUES($1,$2)", [
		source.id,
		sourceDigest,
	]);
}

/** Restores a verified backup into an EMPTY matching schema; never overwrites a live database.
 * Local/session sources are returned for operator restoration; runtime JSONB sources restore in SQL.
 */
export async function restoreMemoryBackup(pool: SqlPool, backupPath: string): Promise<MemoryMigrationSource[]> {
	if (!isAbsolute(backupPath)) throw new Error("Backup path must be absolute");
	const parsed = JSON.parse(readFileSync(backupPath, "utf8")) as { digest: string; backup: MemoryBackup };
	if (parsed.backup.format !== 2 || digest(parsed.backup) !== parsed.digest)
		throw new Error("Memory backup digest mismatch");
	const { backup } = parsed;
	if (!["memory-v1", "memory-v3"].includes(backup.schemaVersion)) throw new Error("Unsupported memory backup schema");
	const allowed = new Set<string>([...TABLES, ...V3_TABLES, "pi861_runtime_state"]);
	if (Object.keys(backup.tables).some((table) => !allowed.has(table))) throw new Error("Unknown backup table");
	const connection = await pool.connect();
	try {
		await connection.query("BEGIN");
		const role = await connection.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user");
		if (!role.rows[0]?.rolsuper && !role.rows[0]?.rolbypassrls)
			throw new Error("Restore requires the migration account");
		const v3 = (await connection.query("SELECT to_regclass('pi861_memory_events') AS present")).rows[0]?.present;
		if (Boolean(v3) !== (backup.schemaVersion === "memory-v3"))
			throw new Error("Backup and target schema versions differ");
		await connection.query(`LOCK TABLE ${Object.keys(backup.tables).join(",")} IN ACCESS EXCLUSIVE MODE`);
		for (const [table, rows] of Object.entries(backup.tables)) {
			if ((await connection.query(`SELECT 1 FROM ${table} LIMIT 1`)).rows.length)
				throw new Error("Restore requires an empty schema");
			// Omit generated columns (scope_kind/purpose) from v3 item restores.
			const columns = (
				await connection.query(
					"SELECT attname FROM pg_attribute WHERE attrelid=$1::regclass AND attnum>0 AND NOT attisdropped AND attgenerated='' ORDER BY attnum",
					[table],
				)
			).rows.map((row) => String(row.attname));
			const names = columns.map((column) => `"${column.replaceAll('"', '""')}"`).join(",");
			await connection.query(
				`INSERT INTO ${table} (${names}) SELECT ${names} FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
				[JSON.stringify(rows)],
			);
			const restored = (await connection.query(`SELECT ${names} FROM ${table}`)).rows;
			const expected = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
			if (
				digest(restored.map((row) => digest(JSON.parse(JSON.stringify(row)))).sort()) !==
				digest(expected.map((row) => digest(row)).sort())
			)
				throw new Error("Restored memory count/digest mismatch");
		}
		if (v3)
			await connection.query(
				"SELECT setval(pg_get_serial_sequence('pi861_memory_events','sequence'),coalesce(max(sequence),1),count(*)>0) FROM pi861_memory_events",
			);
		await connection.query("COMMIT");
		return structuredClone(backup.sources);
	} catch (error) {
		await connection.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}
