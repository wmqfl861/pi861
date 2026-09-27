/**
 * Optional base-host composition. Install pg in an operator-owned directory and
 * set PI861_PG_DRIVER_ROOT to its absolute path. Apply the explicit v3 migration
 * first, then use a non-superuser NOBYPASSRLS runtime role.
 * @import { PiHost } from "../index.ts"
 */
import { installPi861 } from "../index.ts";
import { createPostgresPool } from "../src/live/postgres-configuration.ts";
import { PostgresMemory } from "../src/postgres.ts";

/** @param {PiHost} pi */
export default async function postgresPi861(pi) {
	const tenantId = process.env.PI861_TENANT_ID;
	const principalId = process.env.PI861_AGENT_ID;
	const projectId = process.env.PI861_PROJECT_ID;
	if (!process.env.PI861_DATABASE_URL || !tenantId || !principalId || !projectId) {
		throw new Error("Set PI861_DATABASE_URL, PI861_TENANT_ID, PI861_AGENT_ID and PI861_PROJECT_ID");
	}
	const pool = createPostgresPool({
		urlEnv: "PI861_DATABASE_URL",
		driverRoot: process.env.PI861_PG_DRIVER_ROOT,
		caFile: process.env.PI861_PG_CA_FILE,
		allowLocalPlaintext: process.env.PI861_PG_ALLOW_LOCAL_PLAINTEXT === "1",
		maxConnections: 4,
	});
	pool.on("error", () => console.error("Pi861: PostgreSQL connection unavailable; no local fallback was activated"));
	try {
		const scope = `project:${projectId}`;
		const backend = new PostgresMemory(pool, {
			tenantId,
			principalId,
			readScopes: [scope],
			writeScopes: [scope],
		});
		await backend.ready();
		installPi861(pi, { memory: { backend, scope, autoRecall: true, autoCapture: true } });
		pi.on("session_shutdown", () => pool.end());
	} catch (error) {
		await pool.end();
		throw error;
	}
}
