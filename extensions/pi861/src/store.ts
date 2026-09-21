import { constants } from "node:fs";
import { type FileHandle, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { clone, emptyState, id, Mutex, PlatformError, type PlatformState, validateState } from "./core.ts";

export interface StateStore {
	readonly projectId: string;
	read(): Promise<PlatformState>;
	/** Callback must be synchronous and have no external side effects. */
	transact<T>(mutate: (state: PlatformState) => T): Promise<T>;
}

function rejectAsync(value: unknown): void {
	if (value && typeof value === "object" && "then" in value) {
		throw new PlatformError("ASYNC_TRANSACTION", "Do not perform asynchronous work inside a state transaction");
	}
}

export class MemoryStateStore implements StateStore {
	readonly projectId: string;
	private state: PlatformState;
	private mutex = new Mutex();
	constructor(projectId: string) {
		this.projectId = projectId;
		this.state = emptyState(projectId);
	}
	async read(): Promise<PlatformState> {
		return clone(this.state);
	}
	async transact<T>(mutate: (state: PlatformState) => T): Promise<T> {
		return this.mutex.run(() => {
			const next = clone(this.state);
			const result = mutate(next);
			rejectAsync(result);
			validateState(next, this.projectId);
			next.revision++;
			this.state = clone(next);
			return clone(result);
		});
	}
}

/**
 * Single-host durable store. Separate instances serialize via an exclusive lock.
 * Never steals an orphan lock: an operator must establish owner death first.
 * Multi-node deployments must use a transactional remote store, not NFS.
 */
export class FileStateStore implements StateStore {
	readonly projectId: string;
	readonly path: string;
	private mutex = new Mutex();
	constructor(path: string, projectId: string) {
		this.path = path;
		this.projectId = projectId;
	}
	async read(): Promise<PlatformState> {
		try {
			const state: unknown = JSON.parse(await readFile(this.path, "utf8"));
			validateState(state, this.projectId);
			return state;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState(this.projectId);
			if (error instanceof PlatformError) throw error;
			throw new PlatformError("CORRUPT_STATE", "Cannot read durable state; refusing to reset it");
		}
	}
	async transact<T>(mutate: (state: PlatformState) => T): Promise<T> {
		return this.mutex.run(async () => {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			let lock: FileHandle;
			try {
				lock = await open(`${this.path}.lock`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "EEXIST") {
					throw new PlatformError(
						"STORE_BUSY",
						"State is locked; retry later, never delete another writer's lock",
					);
				}
				throw error;
			}
			const temp = `${this.path}.${id("write")}.tmp`;
			try {
				await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
				await lock.sync();
				const state = await this.read();
				const result = mutate(state);
				rejectAsync(result);
				validateState(state, this.projectId);
				state.revision++;
				const file = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
				try {
					await file.writeFile(JSON.stringify(state));
					await file.sync();
				} finally {
					await file.close();
				}
				await rename(temp, this.path);
				// POSIX directory fsync persists the rename. Windows lacks this interface.
				if (process.platform !== "win32") {
					const directory = await open(dirname(this.path), constants.O_RDONLY);
					try {
						await directory.sync();
					} finally {
						await directory.close();
					}
				}
				return clone(result);
			} finally {
				try {
					await unlink(temp).catch((error: NodeJS.ErrnoException) => {
						if (error.code !== "ENOENT") throw error;
					});
				} finally {
					try {
						await lock.close();
					} finally {
						await unlink(`${this.path}.lock`);
					}
				}
			}
		});
	}
}

/** Compatible with node-postgres Pool without making the deterministic core depend on pg. */
export interface PgConnection {
	query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
	release(): void;
}
export interface PgPool {
	connect(): Promise<PgConnection>;
}

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS pi861_state (
    project_id text PRIMARY KEY,
    revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
`;

/**
 * PostgreSQL aggregate adapter: serializable per-project updates under a row lock.
 * The pool belongs to the trusted host. It is NOT a public multi-tenant HTTP API.
 * Normalized memory/FTS/pgvector projections are a later scalability milestone.
 */
export class PostgresStateStore implements StateStore {
	readonly projectId: string;
	private pool: PgPool;
	constructor(pool: PgPool, projectId: string) {
		this.pool = pool;
		this.projectId = projectId;
	}
	async initialize(): Promise<void> {
		const client = await this.pool.connect();
		try {
			await client.query(POSTGRES_SCHEMA);
		} finally {
			client.release();
		}
	}
	async read(): Promise<PlatformState> {
		const client = await this.pool.connect();
		try {
			const result = await client.query("SELECT payload FROM pi861_state WHERE project_id = $1", [this.projectId]);
			if (result.rows.length === 0) return emptyState(this.projectId);
			const state = result.rows[0].payload;
			validateState(state, this.projectId);
			return clone(state);
		} finally {
			client.release();
		}
	}
	async transact<T>(mutate: (state: PlatformState) => T): Promise<T> {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query("SET LOCAL lock_timeout = '5s'");
			await client.query("SET LOCAL statement_timeout = '15s'");
			await client.query(
				"INSERT INTO pi861_state(project_id, payload) VALUES ($1, $2::jsonb) ON CONFLICT DO NOTHING",
				[this.projectId, JSON.stringify(emptyState(this.projectId))],
			);
			const selected = await client.query("SELECT payload FROM pi861_state WHERE project_id = $1 FOR UPDATE", [
				this.projectId,
			]);
			const state = selected.rows[0]?.payload;
			validateState(state, this.projectId);
			const next = clone(state);
			const result = mutate(next);
			rejectAsync(result);
			next.revision++;
			validateState(next, this.projectId);
			await client.query(
				"UPDATE pi861_state SET payload = $2::jsonb, revision = $3, updated_at = now() WHERE project_id = $1",
				[this.projectId, JSON.stringify(next), next.revision],
			);
			await client.query("COMMIT");
			return clone(result);
		} catch (error) {
			await client.query("ROLLBACK").catch(() => undefined);
			// COMMIT acknowledgement may be lost: do not blindly repeat mutations.
			throw error;
		} finally {
			client.release();
		}
	}
}
