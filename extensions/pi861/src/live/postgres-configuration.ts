import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import type { SqlPool } from "../postgres.ts";

export interface PgPool extends SqlPool {
	end(): Promise<void>;
	on(event: "error", listener: (error: Error) => void): void;
}

/** Only an operator-owned driver root is accepted; no project or model-selected module path. */
export function createPostgresPool(config: PostgresConfiguration & { driverRoot?: string }): PgPool {
	if (config.driverRoot && !isAbsolute(config.driverRoot)) throw new Error("PostgreSQL driver root must be absolute");
	const load = createRequire(config.driverRoot ? join(config.driverRoot, "package.json") : import.meta.url);
	const driver = load("pg") as { Pool: new (options: ReturnType<typeof postgresPoolOptions>) => PgPool };
	return new driver.Pool(postgresPoolOptions(config));
}

export interface PostgresConfiguration {
	urlEnv: string;
	caFile?: string;
	allowLocalPlaintext?: boolean;
	maxConnections?: number;
	connectionTimeoutMs?: number;
	idleTimeoutMs?: number;
	statementTimeoutMs?: number;
	pgvector?: boolean;
}
/** Returns driver options for a trusted server-side pool. Never expose this result to models. */
export function postgresPoolOptions(
	config: PostgresConfiguration,
	environment: Record<string, string | undefined> = process.env,
): {
	connectionString: string;
	max: number;
	connectionTimeoutMillis: number;
	idleTimeoutMillis: number;
	statement_timeout: number;
	ssl: false | { rejectUnauthorized: true; ca?: string };
} {
	if (config.pgvector) throw new Error("pgvector enhancement is not implemented");
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.urlEnv)) throw new Error("Invalid PostgreSQL environment variable name");
	const value = environment[config.urlEnv];
	if (!value) throw new Error("PostgreSQL connection variable is unset");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Invalid PostgreSQL connection URL");
	}
	if (
		!["postgres:", "postgresql:"].includes(url.protocol) ||
		!url.hostname ||
		!url.username ||
		url.pathname.length < 2
	)
		throw new Error("Invalid PostgreSQL connection URL");
	// libpq/pg URL options can override TLS and even the host. Only accept the URL
	// identity fields; all transport options are explicitly owned by this function.
	if (url.searchParams.size)
		throw new Error("PostgreSQL URL query options are not accepted; configure TLS and pool options explicitly");
	const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
	if (config.allowLocalPlaintext && !local)
		throw new Error("Plaintext PostgreSQL is restricted to explicit loopback testing");
	if (config.caFile && !isAbsolute(config.caFile)) throw new Error("PostgreSQL CA path must be absolute");
	const max = config.maxConnections ?? 8;
	const connectionTimeoutMillis = config.connectionTimeoutMs ?? 10_000;
	const idleTimeoutMillis = config.idleTimeoutMs ?? 30_000;
	const statement_timeout = config.statementTimeoutMs ?? 10_000;
	if (
		!Number.isSafeInteger(max) ||
		max < 1 ||
		max > 100 ||
		[connectionTimeoutMillis, idleTimeoutMillis, statement_timeout].some(
			(n) => !Number.isSafeInteger(n) || n < 1 || n > 300_000,
		)
	)
		throw new Error("Invalid PostgreSQL pool limits");
	return {
		connectionString: url.toString(),
		max,
		connectionTimeoutMillis,
		idleTimeoutMillis,
		statement_timeout,
		ssl: config.allowLocalPlaintext
			? false
			: { rejectUnauthorized: true, ...(config.caFile ? { ca: readFileSync(config.caFile, "utf8") } : {}) },
	};
}
