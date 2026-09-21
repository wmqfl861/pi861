/**
 * Optional composition example. Install pg in a separate, operator-owned
 * extension directory and preserve the relative paths when copying this file.
 * Never use a superuser or BYPASSRLS role for these queries.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { installPi861 } from "../index.ts";
import { PostgresMemory } from "../src/postgres.ts";

export default function postgresPi861(pi) {
	const connectionString = process.env.PI861_DATABASE_URL;
	const tenantId = process.env.PI861_TENANT_ID;
	const principalId = process.env.PI861_AGENT_ID;
	const projectId = process.env.PI861_PROJECT_ID;
	if (!connectionString || !tenantId || !principalId || !projectId) {
		throw new Error("Set PI861_DATABASE_URL, PI861_TENANT_ID, PI861_AGENT_ID and PI861_PROJECT_ID");
	}
	const url = new URL(connectionString);
	const allowLocalPlaintext = process.env.PI861_PG_ALLOW_LOCAL_PLAINTEXT === "1" &&
		["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
	// Do not allow URL SSL parameters to replace the explicitly verified TLS policy.
	for (const name of ["sslmode", "sslcert", "sslkey", "sslrootcert"]) url.searchParams.delete(name);
	const ca = process.env.PI861_PG_CA_FILE;
	const pool = new pg.Pool({
		connectionString: url.toString(), max: 4, connectionTimeoutMillis: 10_000,
		ssl: allowLocalPlaintext ? false : { rejectUnauthorized: true, ...(ca ? { ca: readFileSync(ca, "utf8") } : {}) },
	});
	pool.on("error", () => console.error("Pi861: PostgreSQL connection unavailable; no local fallback was activated"));
	const scope = `project:${projectId}`;
	const backend = new PostgresMemory(pool, {
		tenantId, principalId, readScopes: [scope], writeScopes: [scope],
	});
	installPi861(pi, { memory: { backend, scope, autoRecall: true, autoCapture: true } });
	pi.on("session_shutdown", () => pool.end());
}
