import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { IdempotencyConflict, type OutboxOutcome, VersionConflict } from "../contracts/storage.ts";
import {
	BudgetExhausted,
	type BudgetLimits,
	type MeteredKind,
	ProbeInFlight,
	TaskTreeBudget,
	type UsageMeasure,
	type UsageReservation,
} from "../contracts/budget.ts";
import { type PersistentLease, issueLease, leaseValid } from "../contracts/lifecycle.ts";
import { digest } from "../contracts/hash.ts";
import { isValidScope } from "../contracts/identity.ts";
import {
	type MemoryInput,
	type MemoryItem,
	type MemoryPrincipal,
	type MemoryReceipt,
	type MemoryWrite,
	checkPrincipal,
} from "../memory.ts";
import { type MemoryMigrationResult, type MemoryMigrationSource, migrateMemory } from "./memory-migration.ts";
import { type EnrichmentJobView, type MemoryExtractor } from "./extraction.ts";
import { PostgresMemory, type SqlConnection, type SqlPool } from "../postgres.ts";

/**
 * P2-D trusted storage service. Workers hold no database credentials: they present a
 * bearer token, the server resolves it through the pi861_service_principals
 * directory and every operation runs with the tenant/scopes recorded there. A caller
 * can never widen its own authorization by self-asserting tenant, role or scope
 * values - those fields are simply not accepted from the wire.
 */

export class ServiceAuthenticationError extends Error {}
export class LeaseNotHeld extends Error {}
export class StorageSchemaError extends Error {}

export interface ServicePrincipalIdentity extends MemoryPrincipal {}

function scopeList(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || !value.length || !value.every((entry) => typeof entry === "string"))
		throw new StorageSchemaError(`Service principal ${field} must be a non-empty scope list`);
	const scopes = value as string[];
	if (!scopes.every(isValidScope)) throw new StorageSchemaError(`Service principal ${field} contains an invalid scope`);
	return scopes;
}

function rowIdentity(row: Record<string, unknown>): ServicePrincipalIdentity {
	const identity: ServicePrincipalIdentity = {
		principalId: String(row.principal_id),
		tenantId: String(row.tenant_id),
		readScopes: scopeList(row.read_scopes, "read scopes"),
		writeScopes: scopeList(row.write_scopes, "write scopes"),
	};
	checkPrincipal(identity);
	return identity;
}

/** Token digests use this domain so a raw token never appears in the directory table. */
export function serviceTokenDigest(token: string): string {
	if (!token || token.length > 4096) throw new ServiceAuthenticationError("Invalid service token");
	return digest(["pi861.service.token", token]);
}

/**
 * Server-side identity directory over pi861_service_principals (no RLS: lookups run
 * before any tenant GUC exists; isolation is by grant). The pool MUST connect with
 * the dedicated service identity role: SELECT on the directory table only, no
 * access to tenant data tables. Provisioning happens operator-side.
 */
export class ServicePrincipalDirectory {
	private readonly pool: SqlPool;
	constructor(pool: SqlPool) {
		this.pool = pool;
	}
	async resolve(token: string): Promise<ServicePrincipalIdentity> {
		const connection = await this.pool.connect();
		try {
			const found = await connection.query(
				"SELECT principal_id, tenant_id, read_scopes, write_scopes, disabled_at FROM pi861_service_principals WHERE token_digest=$1",
				[serviceTokenDigest(token)],
			);
			const row = found.rows[0];
			if (!row || row.disabled_at) throw new ServiceAuthenticationError("Unknown or disabled service principal");
			return rowIdentity(row);
		} finally {
			connection.release();
		}
	}
}

/** Operator-side provisioning of a service principal; stores only the token digest. */
export async function provisionServicePrincipal(
	pool: SqlPool,
	principal: ServicePrincipalIdentity & { token: string },
): Promise<void> {
	checkPrincipal(principal);
	if (!principal.token || principal.token.length > 4096) throw new ServiceAuthenticationError("Invalid service token");
	const connection = await pool.connect();
	try {
		await connection.query("BEGIN");
		await connection.query(
			"INSERT INTO pi861_service_principals(principal_id,token_digest,tenant_id,read_scopes,write_scopes) VALUES($1,$2,$3,$4::jsonb,$5::jsonb) " +
				"ON CONFLICT (principal_id) DO UPDATE SET token_digest=EXCLUDED.token_digest, tenant_id=EXCLUDED.tenant_id, " +
				"read_scopes=EXCLUDED.read_scopes, write_scopes=EXCLUDED.write_scopes, disabled_at=NULL",
			[
				principal.principalId,
				serviceTokenDigest(principal.token),
				principal.tenantId,
				JSON.stringify(principal.readScopes),
				JSON.stringify(principal.writeScopes),
			],
		);
		await connection.query("COMMIT");
	} catch (error) {
		await connection.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

export interface MemoryReconciliation {
	state: "committed" | "notCommitted";
	receipt?: MemoryReceipt;
	/** Current authoritative record for the receipt scope/id; the complete recovery snapshot. */
	record?: MemoryItem;
}

export interface ClaimedStorageEvent {
	sequence: number;
	scope: string;
	id: string;
	revision: number;
	action: "put" | "withdraw" | "projection";
	eventDigest: string;
	state: "pending" | "dispatched" | "failed";
	attempts: number;
}

/**
 * One authenticated session. Every method derives its tenant context from the
 * server-resolved identity; the C4 memory semantics (requestId+contentDigest
 * idempotency, CAS, persist-before-receipt, atomic outbox) come from PostgresMemory.
 */
export class StorageSession {
	private readonly pool: SqlPool;
	private readonly memoryBackend: PostgresMemory;
	readonly identity: ServicePrincipalIdentity;
	constructor(pool: SqlPool, identity: ServicePrincipalIdentity) {
		this.pool = pool;
		this.identity = identity;
		this.memoryBackend = new PostgresMemory(pool, identity);
	}
	/** Read-only view of the underlying record backend for trusted in-process hosts. */
	get memory(): PostgresMemory {
		return this.memoryBackend;
	}

	async put(input: MemoryWrite): Promise<MemoryReceipt> {
		return this.memoryBackend.put(input);
	}
	async withdraw(requestId: string, scope: string, id: string, expectedRevision: number): Promise<MemoryReceipt> {
		return this.memoryBackend.withdraw(requestId, scope, id, expectedRevision);
	}
	async get(scope: string, id: string): Promise<MemoryItem | undefined> {
		return this.memoryBackend.get(scope, id);
	}
	async search(query: string, limit?: number): Promise<MemoryItem[]> {
		return this.memoryBackend.search(query, limit ?? 8);
	}
	async list(scope: string, afterId?: string, limit?: number) {
		return this.memoryBackend.list(scope, afterId ?? "", limit ?? 50);
	}
	async delta(afterSequence?: number, limit?: number) {
		return this.memoryBackend.delta(afterSequence ?? 0, limit ?? 50);
	}
	async listJobs(): Promise<EnrichmentJobView[]> {
		return this.memoryBackend.listJobs();
	}
	async requeueJob(jobId: string): Promise<EnrichmentJobView> {
		return this.memoryBackend.requeueJob(jobId);
	}
	/** Distillation loop; the model call runs outside any storage transaction (C4/G5). */
	async enrich(
		extractor: MemoryExtractor,
		options: { signal: AbortSignal; maxJobs?: number; timeoutMs?: number },
	): Promise<{ completed: number; failed: number; obsolete: number }> {
		return this.memoryBackend.enrich(extractor, options);
	}

	/**
	 * C4 unknown-commit adjudication with a complete snapshot: after an ambiguous
	 * COMMIT the caller re-presents the requestId; the database receipt is the single
	 * truth and the committed record travels with it.
	 */
	async reconcile(requestId: string, expectedDigest?: string): Promise<MemoryReconciliation> {
		const outcome = await this.memoryBackend.reconcile(requestId, expectedDigest);
		if (outcome.state === "notCommitted") return { state: "notCommitted" };
		const record = await this.memoryBackend.get(outcome.receipt.scope, outcome.receipt.id);
		return { state: "committed", receipt: outcome.receipt, ...(record ? { record } : {}) };
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
					this.identity.tenantId,
					this.identity.principalId,
					JSON.stringify(this.identity.readScopes),
					JSON.stringify(this.identity.writeScopes),
				],
			);
			const result = await fn(connection);
			await connection.query("COMMIT");
			return result;
		} catch (error) {
			await connection.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			connection.release();
		}
	}

	// ----- C3 budget transactions: the frozen contract authority, durably and atomically -----

	async createBudget(rootLimits: BudgetLimits, budgetId?: string): Promise<{ budgetId: string }> {
		const budget = new TaskTreeBudget(rootLimits, budgetId === undefined ? {} : { budgetId });
		return this.transaction(async (connection) => {
			const inserted = await connection.query(
				"INSERT INTO pi861_budgets(tenant_id,budget_id,store_version,snapshot) VALUES($1,$2,1,$3::jsonb) ON CONFLICT (tenant_id,budget_id) DO NOTHING RETURNING budget_id",
				[this.identity.tenantId, budget.budgetId, JSON.stringify(budget.exportState())],
			);
			if (!inserted.rows[0]) throw new StorageSchemaError(`Budget already exists: ${budget.budgetId}`);
			return { budgetId: budget.budgetId };
		});
	}

	private async budgetTransaction<T>(budgetId: string, fn: (budget: TaskTreeBudget) => T): Promise<T> {
		return this.transaction(async (connection) => {
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify(["pi861.budget", this.identity.tenantId, budgetId]),
			]);
			const selected = await connection.query(
				"SELECT snapshot FROM pi861_budgets WHERE tenant_id=$1 AND budget_id=$2 FOR UPDATE",
				[this.identity.tenantId, budgetId],
			);
			const row = selected.rows[0];
			if (!row?.snapshot || typeof row.snapshot !== "object")
				throw new StorageSchemaError(`Unknown budget: ${budgetId}`);
			const budget = new TaskTreeBudget(NEVER_EXHAUSTED_LIMITS);
			budget.restore(row.snapshot as ReturnType<TaskTreeBudget["exportState"]>);
			const result = fn(budget);
			await connection.query(
				"UPDATE pi861_budgets SET store_version=store_version+1, snapshot=$3::jsonb, updated_at=clock_timestamp() WHERE tenant_id=$1 AND budget_id=$2",
				[this.identity.tenantId, budgetId, JSON.stringify(budget.exportState())],
			);
			return result;
		});
	}

	registerBudgetTask(budgetId: string, taskId: string, parentTaskId: string | null, subtreeLimits?: BudgetLimits): Promise<void> {
		return this.budgetTransaction(budgetId, (budget) => budget.registerTask(taskId, parentTaskId, subtreeLimits));
	}
	reserveBudget(
		budgetId: string,
		taskId: string | null,
		kind: MeteredKind,
		estimate: UsageMeasure,
		options: { probeKey?: string } = {},
	): Promise<UsageReservation> {
		return this.budgetTransaction(budgetId, (budget) =>
			budget.reserve(taskId, kind, estimate, Date.now(), options),
		);
	}
	settleBudget(budgetId: string, reservationId: string, actual: UsageMeasure): Promise<void> {
		return this.budgetTransaction(budgetId, (budget) => budget.settle(reservationId, actual));
	}
	/** Unknown usage books a conservative estimate and stays flagged; it is never written down to zero. */
	settleBudgetUnknown(budgetId: string, reservationId: string, conservativeEstimate: UsageMeasure): Promise<void> {
		return this.budgetTransaction(budgetId, (budget) => budget.settleUnknown(reservationId, conservativeEstimate));
	}
	releaseBudget(budgetId: string, reservationId: string): Promise<void> {
		return this.budgetTransaction(budgetId, (budget) => budget.release(reservationId));
	}
	async budgetUsage(
		budgetId: string,
	): Promise<{ attempts: number; usage: UsageMeasure; unknownSettlements: number; openReservations: UsageReservation[] }> {
		const budget = await this.loadBudget(budgetId);
		return { ...budget.usage, openReservations: budget.openReservations() };
	}
	async budgetTaskSummary(budgetId: string, taskId: string) {
		const budget = await this.loadBudget(budgetId);
		return budget.taskSummary(taskId);
	}
	private async loadBudget(budgetId: string): Promise<TaskTreeBudget> {
		return this.transaction(async (connection) => {
			const selected = await connection.query(
				"SELECT snapshot FROM pi861_budgets WHERE tenant_id=$1 AND budget_id=$2",
				[this.identity.tenantId, budgetId],
			);
			const snapshot = selected.rows[0]?.snapshot;
			if (!snapshot || typeof snapshot !== "object") throw new StorageSchemaError(`Unknown budget: ${budgetId}`);
			const budget = new TaskTreeBudget(NEVER_EXHAUSTED_LIMITS);
			budget.restore(snapshot as ReturnType<TaskTreeBudget["exportState"]>);
			return budget;
		});
	}

	// ----- C2 persistent leases: monotonic generations, DB-clock expiry, fenced commits -----

	async acquireLease(purpose: string, owner: string, leaseMs: number): Promise<PersistentLease> {
		if (!purpose || purpose.length > 200 || !owner || !Number.isSafeInteger(leaseMs) || leaseMs <= 0)
			throw new Error("Invalid lease request");
		return this.transaction(async (connection) => {
			await connection.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
				JSON.stringify(["pi861.lease", this.identity.tenantId, purpose]),
			]);
			const nowResult = await connection.query("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now");
			const now = Number(nowResult.rows[0]?.now);
			if (!Number.isFinite(now)) throw new Error("Database clock unavailable");
			const current = await connection.query(
				"SELECT generation, expires_at FROM pi861_leases WHERE tenant_id=$1 AND purpose=$2",
				[this.identity.tenantId, purpose],
			);
			const held = current.rows[0];
			if (held && Number(held.expires_at) > now)
				throw new LeaseNotHeld(`Lease ${purpose} is held by another owner until expiry`);
			const lease = issueLease(purpose, owner, held ? Number(held.generation) + 1 : 1, now, leaseMs);
			await connection.query(
				"INSERT INTO pi861_leases(tenant_id,purpose,owner,token,generation,acquired_at,expires_at,lease_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) " +
					"ON CONFLICT (tenant_id,purpose) DO UPDATE SET owner=EXCLUDED.owner, token=EXCLUDED.token, generation=EXCLUDED.generation, " +
					"acquired_at=EXCLUDED.acquired_at, expires_at=EXCLUDED.expires_at, lease_id=EXCLUDED.lease_id",
				[
					this.identity.tenantId,
					purpose,
					owner,
					lease.token,
					lease.generation,
					lease.acquiredAt,
					lease.expiresAt,
					lease.leaseId,
				],
			);
			return lease;
		});
	}
	async renewLease(purpose: string, token: string, leaseMs: number): Promise<PersistentLease> {
		if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("Invalid lease renewal");
		return this.transaction(async (connection) => {
			const nowResult = await connection.query("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now");
			const now = Number(nowResult.rows[0]?.now);
			if (!Number.isFinite(now)) throw new Error("Database clock unavailable");
			const renewed = await connection.query(
				"UPDATE pi861_leases SET expires_at=$4 WHERE tenant_id=$1 AND purpose=$2 AND token=$3 AND expires_at > $5 " +
					"RETURNING owner, token, generation, acquired_at, expires_at, lease_id",
				[this.identity.tenantId, purpose, token, now + leaseMs, now],
			);
			const lease = this.leaseRow(renewed.rows[0], purpose);
			if (!lease) throw new LeaseNotHeld(`Lease ${purpose} is not held or has expired`);
			return lease;
		});
	}
	/** Release keeps the row with an immediate expiry so generations stay monotonic for fencing. */
	async releaseLease(purpose: string, token: string): Promise<void> {
		await this.transaction(async (connection) => {
			const released = await connection.query(
				"UPDATE pi861_leases SET expires_at=acquired_at WHERE tenant_id=$1 AND purpose=$2 AND token=$3 AND expires_at > acquired_at RETURNING generation",
				[this.identity.tenantId, purpose, token],
			);
			if (!released.rows[0]) throw new LeaseNotHeld(`Lease ${purpose} is not held with this token`);
		});
	}
	/** Fencing check for commit paths: the lease must be valid at the given generation. */
	async leaseSnapshot(purpose: string): Promise<PersistentLease | undefined> {
		return this.transaction(async (connection) => {
			const found = await connection.query(
				"SELECT owner, token, generation, acquired_at, expires_at, lease_id FROM pi861_leases WHERE tenant_id=$1 AND purpose=$2",
				[this.identity.tenantId, purpose],
			);
			return this.leaseRow(found.rows[0], purpose, true);
		});
	}
	async leaseValidAt(purpose: string, generation: number): Promise<boolean> {
		// The verdict must come from one transaction with the DATABASE clock: lease rows
		// carry DB timestamps, and mixing in a client clock that lags the server made
		// freshly acquired leases fail fencing during the clock skew window.
		return this.transaction(async (connection) => {
			const now = Number(
				(await connection.query("SELECT (extract(epoch FROM clock_timestamp())*1000)::bigint AS now")).rows[0]?.now,
			);
			const found = await connection.query(
				"SELECT owner, token, generation, acquired_at, expires_at, lease_id FROM pi861_leases WHERE tenant_id=$1 AND purpose=$2",
				[this.identity.tenantId, purpose],
			);
			const lease = this.leaseRow(found.rows[0], purpose, true);
			return lease !== undefined && Number.isFinite(now) && leaseValid(lease, generation, now);
		});
	}
	private leaseRow(
		row: Record<string, unknown> | undefined,
		purpose: string,
		optional = false,
	): PersistentLease | undefined {
		if (!row) {
			if (optional) return undefined;
			throw new LeaseNotHeld(`Lease ${purpose} is not held`);
		}
		return {
			leaseId: String(row.lease_id),
			purpose,
			owner: String(row.owner),
			token: String(row.token),
			generation: Number(row.generation),
			acquiredAt: Number(row.acquired_at),
			expiresAt: Number(row.expires_at),
		};
	}

	// ----- transactional outbox: at-least-once feed for index and cache consumers -----

	async claimEvents(limit = 20): Promise<ClaimedStorageEvent[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid event claim limit");
		return this.transaction(async (connection) => {
			const claimed = await connection.query(
				"SELECT sequence, scope_key, memory_id, revision, action, event_digest, state, attempts FROM pi861_memory_events " +
					"WHERE tenant_id=$1 AND scope_key=ANY($2::text[]) AND state='pending' ORDER BY sequence LIMIT $3",
				[this.identity.tenantId, this.identity.readScopes, limit],
			);
			return claimed.rows.map((row) => ({
				sequence: Number(row.sequence),
				scope: String(row.scope_key),
				id: String(row.memory_id),
				revision: Number(row.revision),
				action: row.action as ClaimedStorageEvent["action"],
				eventDigest: String(row.event_digest),
				state: row.state as ClaimedStorageEvent["state"],
				attempts: Number(row.attempts),
			}));
		});
	}
	async completeEvent(sequence: number, outcome: OutboxOutcome): Promise<void> {
		if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Invalid event sequence");
		return this.transaction(async (connection) => {
			const parameters: unknown[] = [this.identity.tenantId, sequence];
			let sql: string;
			if (outcome === "dispatched") {
				sql = "UPDATE pi861_memory_events SET state='dispatched', attempts=attempts+1 WHERE tenant_id=$1 AND sequence=$2 AND state='pending' RETURNING sequence";
			} else if (outcome === "failed-terminal") {
				sql = "UPDATE pi861_memory_events SET state='failed', attempts=attempts+1 WHERE tenant_id=$1 AND sequence=$2 AND state='pending' RETURNING sequence";
			} else {
				parameters.push(Math.max(1, Math.floor(outcome.retryAfterMs)), outcome.error.slice(0, 500));
				sql = "UPDATE pi861_memory_events SET attempts=attempts+1, next_attempt_at=clock_timestamp()+($3::bigint * interval '1 millisecond'), last_error=$4 " +
					"WHERE tenant_id=$1 AND sequence=$2 AND state='pending' RETURNING sequence";
			}
			const updated = await connection.query(sql, parameters);
			if (!updated.rows[0]) throw new Error(`Unknown or already completed event: ${sequence}`);
		});
	}
}

const NEVER_EXHAUSTED_LIMITS: BudgetLimits = {
	maxTotalCostUsd: Number.MAX_SAFE_INTEGER,
	maxAttempts: Number.MAX_SAFE_INTEGER,
	maxInputTokens: Number.MAX_SAFE_INTEGER,
	maxOutputTokens: Number.MAX_SAFE_INTEGER,
};

/** The trusted service itself: authenticate once per request, then run scoped operations. */
export class StorageService {
	private readonly data: SqlPool;
	private readonly directory: ServicePrincipalDirectory;
	constructor(data: SqlPool, directory: ServicePrincipalDirectory) {
		this.data = data;
		this.directory = directory;
	}
	/** Refuse missing migrations or privileged runtime credentials before serving. */
	async ready(): Promise<void> {
		const connection = await this.data.connect();
		try {
			const schema = await connection.query(
				"SELECT version FROM pi861_schema_migrations WHERE version IN ('memory-v3','storage-v4')",
			);
			const versions = new Set(schema.rows.map((row) => String(row.version)));
			if (!versions.has("memory-v3") || !versions.has("storage-v4"))
				throw new StorageSchemaError("Run the explicit memory-v3 and storage-v4 migrations before starting the service");
			const directory = await connection.query("SELECT to_regclass('pi861_service_principals') AS present");
			if (!directory.rows[0]?.present)
				throw new StorageSchemaError("Service identity directory is missing; run the storage-v4 migration");
			const role = await connection.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user");
			if (!role.rows[0] || role.rows[0].rolsuper || role.rows[0].rolbypassrls)
				throw new StorageSchemaError("Storage runtime requires a non-superuser NOBYPASSRLS account");
		} finally {
			connection.release();
		}
	}
	async session(token: string): Promise<StorageSession> {
		return new StorageSession(this.data, await this.directory.resolve(token));
	}
}

/** Anything able to open authenticated sessions; StorageService satisfies this. */
export interface SessionSource {
	session(token: string): Promise<StorageSession>;
}

export interface StorageServiceResponse {
	status: number;
	/** Pre-serialized JSON: the transport must write the status line exactly once, after this. */
	body: string;
}

const STORAGE_OPERATION_NAMES = [
	"put",
	"withdraw",
	"get",
	"search",
	"list",
	"delta",
	"reconcile",
	"listJobs",
	"requeueJob",
	"createBudget",
	"registerBudgetTask",
	"reserveBudget",
	"settleBudget",
	"settleBudgetUnknown",
	"releaseBudget",
	"budgetUsage",
	"acquireLease",
	"renewLease",
	"releaseLease",
	"leaseSnapshot",
	"claimEvents",
	"completeEvent",
] as const;
export type StorageOperationName = (typeof STORAGE_OPERATION_NAMES)[number];

type OperationHandler = (session: StorageSession, args: Record<string, unknown>) => Promise<unknown>;

function operationString(value: unknown, field: string): string {
	if (typeof value !== "string" || !value) throw new Error(`Field ${field} must be a non-empty string`);
	return value;
}
function operationNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Field ${field} must be a finite number`);
	return value;
}
function operationOptionalString(value: unknown, field: string): string | undefined {
	return value === undefined || value === null ? undefined : operationString(value, field);
}
const METERED_KINDS = ["execution", "reception", "planning", "skill-compile", "distill", "probe", "auxiliary"] as const;
function operationKind(value: unknown): MeteredKind {
	const name = operationString(value, "kind");
	if (!METERED_KINDS.includes(name as (typeof METERED_KINDS)[number])) throw new Error(`Field kind is not a metered kind: ${name}`);
	return name as MeteredKind;
}
function operationOutcome(value: unknown): OutboxOutcome {
	if (value === "dispatched" || value === "failed-terminal") return value;
	if (value !== null && typeof value === "object" && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		return {
			retryAfterMs: operationNumber(record.retryAfterMs, "outcome.retryAfterMs"),
			error: operationString(record.error, "outcome.error"),
		};
	}
	throw new Error("Field outcome must be a completion outcome");
}

/** Scoped operations; every handler receives only the server-resolved session. */
const STORAGE_OPERATIONS: Record<StorageOperationName, OperationHandler> = {
	put: (session, args) =>
		session.put({
			requestId: operationString(args.requestId, "requestId"),
			expectedRevision:
				args.expectedRevision === null || args.expectedRevision === undefined
					? null
					: operationNumber(args.expectedRevision, "expectedRevision"),
			item: args.item as MemoryInput,
		}),
	withdraw: (session, args) =>
		session.withdraw(
			operationString(args.requestId, "requestId"),
			operationString(args.scope, "scope"),
			operationString(args.id, "id"),
			operationNumber(args.expectedRevision, "expectedRevision"),
		),
	get: (session, args) => session.get(operationString(args.scope, "scope"), operationString(args.id, "id")),
	search: (session, args) =>
		session.search(operationString(args.query, "query"), args.limit === undefined ? undefined : operationNumber(args.limit, "limit")),
	list: (session, args) =>
		session.list(
			operationString(args.scope, "scope"),
			operationOptionalString(args.afterId, "afterId"),
			args.limit === undefined ? undefined : operationNumber(args.limit, "limit"),
		),
	delta: (session, args) =>
		session.delta(
			args.afterSequence === undefined ? undefined : operationNumber(args.afterSequence, "afterSequence"),
			args.limit === undefined ? undefined : operationNumber(args.limit, "limit"),
		),
	reconcile: (session, args) =>
		session.reconcile(operationString(args.requestId, "requestId"), operationOptionalString(args.expectedDigest, "expectedDigest")),
	listJobs: (session) => session.listJobs(),
	requeueJob: (session, args) => session.requeueJob(operationString(args.jobId, "jobId")),
	createBudget: (session, args) =>
		session.createBudget(
			args.rootLimits as BudgetLimits,
			args.budgetId === undefined ? undefined : operationString(args.budgetId, "budgetId"),
		),
	registerBudgetTask: (session, args) =>
		session.registerBudgetTask(
			operationString(args.budgetId, "budgetId"),
			operationString(args.taskId, "taskId"),
			args.parentTaskId === null || args.parentTaskId === undefined ? null : operationString(args.parentTaskId, "parentTaskId"),
			args.subtreeLimits as BudgetLimits | undefined,
		),
	reserveBudget: (session, args) =>
		session.reserveBudget(
			operationString(args.budgetId, "budgetId"),
			args.taskId === null || args.taskId === undefined ? null : operationString(args.taskId, "taskId"),
			operationKind(args.kind),
			args.estimate as UsageMeasure,
			args.probeKey === undefined ? {} : { probeKey: operationString(args.probeKey, "probeKey") },
		),
	settleBudget: (session, args) =>
		session.settleBudget(
			operationString(args.budgetId, "budgetId"),
			operationString(args.reservationId, "reservationId"),
			args.actual as UsageMeasure,
		),
	settleBudgetUnknown: (session, args) =>
		session.settleBudgetUnknown(
			operationString(args.budgetId, "budgetId"),
			operationString(args.reservationId, "reservationId"),
			args.conservativeEstimate as UsageMeasure,
		),
	releaseBudget: (session, args) =>
		session.releaseBudget(operationString(args.budgetId, "budgetId"), operationString(args.reservationId, "reservationId")),
	budgetUsage: (session, args) => session.budgetUsage(operationString(args.budgetId, "budgetId")),
	acquireLease: (session, args) =>
		session.acquireLease(operationString(args.purpose, "purpose"), operationString(args.owner, "owner"), operationNumber(args.leaseMs, "leaseMs")),
	renewLease: (session, args) =>
		session.renewLease(operationString(args.purpose, "purpose"), operationString(args.token, "token"), operationNumber(args.leaseMs, "leaseMs")),
	releaseLease: (session, args) =>
		session.releaseLease(operationString(args.purpose, "purpose"), operationString(args.token, "token")),
	leaseSnapshot: (session, args) => session.leaseSnapshot(operationString(args.purpose, "purpose")),
	claimEvents: (session, args) => session.claimEvents(args.limit === undefined ? undefined : operationNumber(args.limit, "limit")),
	completeEvent: (session, args) => session.completeEvent(operationNumber(args.sequence, "sequence"), operationOutcome(args.outcome)),
};

function storageErrorStatus(error: unknown): number {
	if (error instanceof ServiceAuthenticationError) return 401;
	if (error instanceof IdempotencyConflict || error instanceof VersionConflict) return 409;
	if (error instanceof BudgetExhausted || error instanceof ProbeInFlight) return 429;
	if (error instanceof LeaseNotHeld) return 409;
	if (error instanceof StorageSchemaError) return 503;
	return 400;
}

function storageErrorBody(error: unknown): string {
	const message = error instanceof Error ? error.message : "storage service request failed";
	const code = error instanceof Error ? error.constructor.name : "Error";
	// Error payloads are plain strings; this serialization cannot throw for them.
	return JSON.stringify({ ok: false, error: { code, message } });
}

/**
 * Wire dispatcher for the storage service entry. Three review-driven invariants:
 * 1. the operation allowlist is matched with Object.hasOwn against a frozen name
 *    list, so prototype keys ("constructor", "__proto__", "valueOf", ...) can never
 *    resolve to an inherited function;
 * 2. responses are fully serialized BEFORE any status is reported, so a result that
 *    cannot be encoded becomes a single 500 error response instead of a second
 *    writeHead after headers were already sent;
 * 3. handle() never throws: every failure path returns a pre-serialized response.
 */
export class StorageOperationDispatcher {
	private readonly source: SessionSource;
	constructor(source: SessionSource) {
		this.source = source;
	}
	async handle(token: string, body: unknown): Promise<StorageServiceResponse> {
		let name: string;
		let args: Record<string, unknown>;
		try {
			if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be an object");
			const record = body as Record<string, unknown>;
			name = operationString(record.op, "op");
			if (record.args !== undefined && record.args !== null) {
				if (typeof record.args !== "object" || Array.isArray(record.args)) throw new Error("Field args must be an object");
				args = record.args as Record<string, unknown>;
			} else {
				args = {};
			}
		} catch (error) {
			return { status: 400, body: storageErrorBody(error) };
		}
		// Allowlist double gate: known name AND own property of the table.
		if (!STORAGE_OPERATION_NAMES.includes(name as StorageOperationName) || !Object.hasOwn(STORAGE_OPERATIONS, name))
			return { status: 404, body: storageErrorBody(new Error(`Unknown operation: ${name}`)) };
		try {
			const session = await this.source.session(token);
			const result = await STORAGE_OPERATIONS[name as StorageOperationName](session, args);
			// Serialize before reporting success; an unencodable result is a single 500,
			// never a half-written 200 followed by a second header write.
			try {
				const payload = JSON.stringify({ ok: true, result: result === undefined ? null : result });
				return { status: 200, body: payload };
			} catch {
				return {
					status: 500,
					body: storageErrorBody(new Error(`Operation result cannot be encoded: ${name}`)),
				};
			}
		} catch (error) {
			return { status: storageErrorStatus(error), body: storageErrorBody(error) };
		}
	}
}

export interface StorageMigrationOptions {
	/** Absolute path for the storage-v4 backup envelope, written and fsynced before applying. */
	backupPath: string;
	/** Absolute path for the conflict report, always written (empty conflicts when clean). */
	conflictReportPath: string;
	writersStopped: true;
	/** Required when the memory-v3 ledger entry is missing; forwarded to the memory migration. */
	memory?: {
		backupPath: string;
		sources?: MemoryMigrationSource[];
		runtimeSources?: { tenantId: string; stateKey: string; id: string }[];
	};
}

export interface StorageMigrationResult {
	version: "storage-v4";
	applied: string[];
	skipped: string[];
	memory?: MemoryMigrationResult;
	backupPath: string;
	conflictReportPath: string;
	replayed: boolean;
	conflicts: string[];
}

interface StorageBackup {
	format: 1;
	kind: "storage-v4";
	createdAt: number;
	schemaDigest: string;
	tables: Record<string, Record<string, unknown>[]>;
}

const STORAGE_V4_TABLES = ["pi861_service_principals", "pi861_budgets", "pi861_leases"] as const;

function writeFileSynced(path: string, contents: string): void {
	const fd = openSync(path, "wx", 0o600);
	try {
		writeFileSync(fd, contents, "utf8");
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

async function migrationRoleCheck(connection: SqlConnection): Promise<void> {
	const role = await connection.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user");
	if (!role.rows[0]?.rolsuper && !role.rows[0]?.rolbypassrls)
		throw new Error("Migration account must have explicitly provisioned BYPASSRLS; never use the runtime account");
}

async function ledgerVersion(connection: SqlConnection, version: string): Promise<{ digest: string } | undefined> {
	const ledger = await connection.query("SELECT to_regclass('pi861_schema_migrations') AS present");
	if (!ledger.rows[0]?.present) return undefined;
	const row = await connection.query("SELECT digest FROM pi861_schema_migrations WHERE version=$1", [version]);
	return row.rows[0] ? { digest: String(row.rows[0].digest) } : undefined;
}

/**
 * Versioned, operator-only migration for the storage service. Order: stop writers,
 * migrate memory to the record model (explicit backup + conflict detection, M3
 * semantics), back up any existing storage-v4 tables, apply storage-v4.sql, record
 * the ledger digest and always write a conflict report. Orphan v4 tables without a
 * ledger entry and digest mismatches are conflicts that abort without overwriting.
 */
export async function migrateStorage(pool: SqlPool, options: StorageMigrationOptions): Promise<StorageMigrationResult> {
	if (options.writersStopped !== true) throw new Error("Migration requires stopped writers");
	if (!isAbsolute(options.backupPath) || !isAbsolute(options.conflictReportPath))
		throw new Error("Migration requires absolute backup and report paths");
	const schema = readFileSync(new URL("../../sql/storage-v4.sql", import.meta.url), "utf8");
	const schemaDigest = digest(schema);
	const applied: string[] = [];
	const skipped: string[] = [];
	const conflicts: string[] = [];

	const memoryNeeded = await withConnection(pool, async (connection) => {
		await connection.query("BEGIN");
		try {
			await migrationRoleCheck(connection);
			return (await ledgerVersion(connection, "memory-v3")) === undefined;
		} finally {
			await connection.query("COMMIT").catch(() => {});
		}
	});
	let memory: MemoryMigrationResult | undefined;
	if (memoryNeeded) {
		if (!options.memory) throw new Error("Memory sources are required until the memory-v3 migration is applied");
		try {
			memory = await migrateMemory(pool, { ...options.memory, writersStopped: true });
		} catch (error) {
			const reason = error instanceof Error ? error.message : "memory migration failed";
			writeFileSynced(
				options.conflictReportPath,
				JSON.stringify(
					{ format: 1, generatedAt: Date.now(), applied, skipped, conflicts: [`memory migration failed: ${reason}`] },
					null,
					"\t",
				) + "\n",
			);
			throw error;
		}
		applied.push("memory-v3");
	} else skipped.push("memory-v3");

	const connection = await pool.connect();
	try {
		await connection.query("BEGIN");
		await connection.query("SELECT pg_advisory_xact_lock(hashtextextended('pi861.storage.migration',0))");
		await migrationRoleCheck(connection);
		const existing = await ledgerVersion(connection, "storage-v4");
		if (existing && existing.digest !== schemaDigest) {
			conflicts.push("storage-v4 ledger digest mismatch: schema file changed after being applied");
			await writeReport();
			throw new Error("Storage schema migration digest mismatch");
		}
		const tables: Record<string, Record<string, unknown>[]> = {};
		if (existing) {
			skipped.push("storage-v4");
			const present = await connection.query(
				"SELECT to_regclass('pi861_service_principals') AS principals, to_regclass('pi861_budgets') AS budgets, to_regclass('pi861_leases') AS leases",
			);
			if (Object.values(present.rows[0] ?? {}).some((table) => !table)) {
				conflicts.push("storage-v4 ledger entry exists without its tables; complete or undo the partial schema first");
				await writeReport();
				throw new Error("Storage ledger does not match the schema");
			}
			await connection.query(`LOCK TABLE ${STORAGE_V4_TABLES.join(",")} IN ACCESS EXCLUSIVE MODE`);
			for (const table of STORAGE_V4_TABLES) tables[table] = (await connection.query(`SELECT * FROM ${table}`)).rows;
		} else {
			// The identity directory lives in the tenant schema without RLS; tenant
			// tables without a ledger entry are conflicts.
			const orphan = (await connection.query(
				"SELECT to_regclass('pi861_budgets') AS budgets, to_regclass('pi861_leases') AS leases",
			)).rows[0] ?? {};
			if (orphan.budgets || orphan.leases) {
				conflicts.push("storage-v4 tenant tables already exist without a ledger entry; refusing to overwrite");
				await writeReport();
				throw new Error("Orphan storage service tables; resolve the conflict before migrating");
			}
			for (const table of STORAGE_V4_TABLES) tables[table] = [];
			await connection.query(schema.replace(/^BEGIN;$/m, "").replace(/^COMMIT;$/m, ""));
			await connection.query(
				"INSERT INTO pi861_schema_migrations(version,name,digest) VALUES('storage-v4','trusted storage service',$1)",
				[schemaDigest],
			);
			applied.push("storage-v4");
		}
		const backup: StorageBackup = JSON.parse(
			JSON.stringify({ format: 1, kind: "storage-v4", createdAt: Date.now(), schemaDigest, tables }),
		);
		writeFileSynced(options.backupPath, JSON.stringify({ digest: digest(backup), backup }));
		const result: StorageMigrationResult = {
			version: "storage-v4",
			applied,
			skipped,
			...(memory ? { memory } : {}),
			backupPath: options.backupPath,
			conflictReportPath: options.conflictReportPath,
			replayed: skipped.includes("storage-v4"),
			conflicts,
		};
		await writeReport();
		await connection.query("COMMIT");
		return result;

		async function writeReport(): Promise<void> {
			writeFileSynced(
				options.conflictReportPath,
				JSON.stringify(
					{ format: 1, generatedAt: Date.now(), applied, skipped, conflicts },
					null,
					"\t",
				) + "\n",
			);
		}
	} catch (error) {
		await connection.query("ROLLBACK").catch(() => {});
		throw error;
	} finally {
		connection.release();
	}
}

async function withConnection<T>(pool: SqlPool, fn: (connection: SqlConnection) => Promise<T>): Promise<T> {
	const connection = await pool.connect();
	try {
		return await fn(connection);
	} finally {
		connection.release();
	}
}
