import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

// P1-Q PostgreSQL 17 fixture helper (K4). Default OFF: a container is only created when the
// operator opts in with PI861_PG17_TESTS=1; ordinary local/unit suites never invoke Docker and
// never inherit real database credentials. Containers get unique names, the runtime account is
// a restricted non-superuser role, and the migration account is separate. Version mismatches
// make dependent tests FAIL explicitly - they are never skipped and never pass.
//
// startPg17Fixture() -> {
//   containerName, port, serverVersionNum,
//   connectionEnv (runtime account, test-only env names), migrationEnv (migration account),
//   assertVersion17() (throws on any version outside [17, 18)), stop()
// }
// requirePg17(serverVersionNum) -> throws unless 170000 <= version < 180000.
// Standalone: node test/fixtures/pg17.mjs --print-manifest (prints the connection manifest as
// JSON for the acceptance runner's pg17 suite; requires the same opt-in env).

const execute = promisify(execFile);
const OPT_IN_ENV = "PI861_PG17_TESTS";

export function requirePg17(serverVersionNum) {
	if (!Number.isSafeInteger(serverVersionNum))
		throw new Error(`PostgreSQL version probe failed: server_version_num is not an integer (${String(serverVersionNum)}); PG17 acceptance fails instead of skipping`);
	if (serverVersionNum < 170000 || serverVersionNum >= 180000)
		throw new Error(`PostgreSQL 17 required: server_version_num ${serverVersionNum} is outside [170000, 180000); PG17 acceptance fails instead of skipping`);
	return true;
}

export function pg17VersionGate(serverVersionNum) {
	if (!Number.isSafeInteger(serverVersionNum)) return { ok: false, reason: "probe returned a non-integer version" };
	if (serverVersionNum < 170000) return { ok: false, reason: `server_version_num ${serverVersionNum} is older than PostgreSQL 17` };
	if (serverVersionNum >= 180000) return { ok: false, reason: `server_version_num ${serverVersionNum} is newer than PostgreSQL 17` };
	return { ok: true, reason: "PostgreSQL 17" };
}

export function pg17OptedIn(env = process.env) {
	return env[OPT_IN_ENV] === "1";
}

async function docker(...args) {
	return execute("docker", args, { timeout: 120_000, windowsHide: true });
}

export async function probeDocker() {
	try {
		const output = await docker("version", "--format", "{{.Server.Version}}");
		return { available: true, serverVersion: output.stdout.trim() };
	} catch (error) {
		return { available: false, reason: error instanceof Error ? error.message.split("\n")[0] : "docker unavailable" };
	}
}

async function waitForReady(containerName, migrator, timeoutMs = 90_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		try {
			const ready = await docker("exec", containerName, "pg_isready", "-U", migrator, "-d", "pi861_test");
			if (ready.stdout.includes("accepting connections")) return;
		} catch {
			// container or postgres still starting
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`PostgreSQL fixture ${containerName} did not become ready within ${timeoutMs}ms`);
}

export async function startPg17Fixture(options = {}) {
	if (!pg17OptedIn())
		throw new Error(`PG17 fixture is default-off; set ${OPT_IN_ENV}=1 to allow a local test container (it never runs from ordinary suites)`);
	const engine = await probeDocker();
	if (!engine.available) throw new Error(`PG17 fixture requires Docker: ${engine.reason}`);
	const image = options.image ?? "postgres:17";
	const suffix = randomBytes(4).toString("hex");
	const containerName = `pi861-pg17-${process.pid}-${suffix}`;
	const migrator = "pi861_migrator";
	const migratorPassword = randomBytes(12).toString("hex");
	const runtime = "pi861_runtime";
	const runtimePassword = randomBytes(12).toString("hex");
	const database = "pi861_test";
	try {
		await docker(
			"run", "-d", "--name", containerName,
			"-p", "127.0.0.1::5432",
			"-e", `POSTGRES_USER=${migrator}`,
			"-e", `POSTGRES_PASSWORD=${migratorPassword}`,
			"-e", `POSTGRES_DB=${database}`,
			image,
		);
		await waitForReady(containerName, migrator);
		// Restricted runtime account: not superuser, no BYPASSRLS, no migration rights.
		await docker("exec", containerName, "psql", "-U", migrator, "-d", database, "-v", "ON_ERROR_STOP=1", "-c", [
			`CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD '${runtimePassword}';`,
			`GRANT CONNECT ON DATABASE ${database} TO ${runtime};`,
			"GRANT USAGE ON SCHEMA public TO pi861_runtime;",
		].join(" "));
		const portOutput = await docker("port", containerName, "5432");
		const port = Number(/127\.0\.0\.1:(\d+)/.exec(portOutput.stdout)?.[1] ?? Number.NaN);
		if (!Number.isSafeInteger(port) || port <= 0) throw new Error(`Could not determine the fixture port mapping: ${portOutput.stdout.trim()}`);
		const versionOutput = await docker("exec", containerName, "psql", "-U", migrator, "-d", database, "-tAc", "SELECT server_version_num");
		const serverVersionNum = Number(versionOutput.stdout.trim());
		const fixture = {
			containerName,
			image,
			port,
			serverVersionNum,
			connectionEnv: {
				PI861_TEST_PG_HOST: "127.0.0.1",
				PI861_TEST_PG_PORT: String(port),
				PI861_TEST_PG_DATABASE: database,
				PI861_TEST_PG_USER: runtime,
				PI861_TEST_PG_PASSWORD: runtimePassword,
			},
			migrationEnv: {
				PI861_TEST_PG_HOST: "127.0.0.1",
				PI861_TEST_PG_PORT: String(port),
				PI861_TEST_PG_DATABASE: database,
				PI861_TEST_PG_MIGRATION_USER: migrator,
				PI861_TEST_PG_MIGRATION_PASSWORD: migratorPassword,
			},
			assertVersion17() {
				return requirePg17(serverVersionNum);
			},
			async runtimeRoleIsRestricted() {
				const attributes = await docker("exec", containerName, "psql", "-U", migrator, "-d", database, "-tAc",
					"SELECT rolsuper::text || '/' || rolbypassrls::text || '/' || rolcreatedb::text || '/' || rolcreaterole::text FROM pg_roles WHERE rolname = 'pi861_runtime'");
				const values = attributes.stdout.trim().split("/");
				if (values.length !== 4 || values.some((value) => value !== "false"))
					throw new Error(`Runtime role must stay restricted (super/bypassrls/createdb/createrole): ${attributes.stdout.trim()}`);
				return true;
			},
			stop: async () => {
				await docker("rm", "-f", containerName).catch(() => {});
			},
		};
		requirePg17(serverVersionNum);
		return fixture;
	} catch (error) {
		await docker("rm", "-f", containerName).catch(() => {});
		throw error;
	}
}

if (process.argv[1]?.endsWith("pg17.mjs") && process.argv.includes("--print-manifest")) {
	if (!pg17OptedIn()) {
		process.stderr.write(`PG17 fixture is default-off; set ${OPT_IN_ENV}=1 first.\n`);
		process.exitCode = 1;
	} else {
		const fixture = await startPg17Fixture();
		process.stdout.write(`${JSON.stringify({
			containerName: fixture.containerName,
			port: fixture.port,
			serverVersionNum: fixture.serverVersionNum,
			connectionEnvNames: Object.keys(fixture.connectionEnv),
			migrationEnvNames: Object.keys(fixture.migrationEnv),
		})}\n`);
		await fixture.stop();
	}
}
