#!/usr/bin/env node
/**
 * pi861 trusted storage service entry (P2-D).
 *
 * The process holds the database credentials; workers never do. Each request carries
 * only a bearer token, which is resolved server-side to the principal identity
 * (tenant + scopes) recorded in pi861_service_principals. Tenant, role or scope
 * values in a request body are never trusted for authorization. Dispatching,
 * the operation allowlist and response encoding live in StorageOperationDispatcher
 * (src/live/storage-service.ts); this entry only owns sockets, pools and shutdown.
 *
 * Environment:
 *   PI861_STORAGE_DATA_URL       required; runtime-role PostgreSQL URL (no query options)
 *   PI861_STORAGE_IDENTITY_URL   required; service-identity-role URL (directory SELECT only)
 *   PI861_STORAGE_PORT           required; 0 binds an ephemeral port (printed to stdout)
 *   PI861_STORAGE_HOST           optional; default 127.0.0.1. Non-loopback requires TLS
 *   PI861_STORAGE_TLS_CERT/KEY   server TLS for non-loopback binds
 *   PI861_STORAGE_CA_FILE        optional absolute CA file for database TLS verification
 *   PI861_STORAGE_ALLOW_LOCAL_PLAINTEXT=1  explicit loopback plaintext database testing
 *   PI861_STORAGE_DRIVER_ROOT    optional operator-owned pg driver root
 *   PI861_STORAGE_SCHEMA         optional tenant schema search_path
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { isAbsolute } from "node:path";
import { createPostgresPool } from "../src/live/postgres-configuration.ts";
import { ServicePrincipalDirectory, StorageOperationDispatcher, StorageService } from "../src/live/storage-service.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY_BYTES = 1_048_576;

/**
 * @param {string} name
 */
function requiredEnv(name) {
	const value = process.env[name];
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

const host = process.env.PI861_STORAGE_HOST ?? "127.0.0.1";
const port = Number(requiredEnv("PI861_STORAGE_PORT"));
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error("Invalid PI861_STORAGE_PORT");
const caFile = process.env.PI861_STORAGE_CA_FILE;
if (caFile !== undefined && !isAbsolute(caFile)) throw new Error("PI861_STORAGE_CA_FILE must be absolute");
const schemaName = process.env.PI861_STORAGE_SCHEMA;
const poolOptions = {
	driverRoot: process.env.PI861_STORAGE_DRIVER_ROOT,
	caFile,
	...(schemaName ? { schemaName } : {}),
	...(process.env.PI861_STORAGE_ALLOW_LOCAL_PLAINTEXT === "1" ? { allowLocalPlaintext: true } : {}),
};
const dataPool = createPostgresPool({ urlEnv: "PI861_STORAGE_DATA_URL", ...poolOptions });
const identityPool = createPostgresPool({ urlEnv: "PI861_STORAGE_IDENTITY_URL", ...poolOptions });
const service = new StorageService(dataPool, new ServicePrincipalDirectory(identityPool));
const dispatcher = new StorageOperationDispatcher(service);

/**
 * @param {import("node:http").IncomingMessage} request
 */
async function readBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
		chunks.push(chunk);
	}
	return JSON.parse(chunks.length ? Buffer.concat(chunks).toString("utf8") : "{}");
}

function useTls() {
	if (LOOPBACK_HOSTS.has(host)) return undefined;
	const cert = process.env.PI861_STORAGE_TLS_CERT;
	const key = process.env.PI861_STORAGE_TLS_KEY;
	if (!cert || !key)
		throw new Error("Non-loopback storage service binds require PI861_STORAGE_TLS_CERT and PI861_STORAGE_TLS_KEY");
	return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}

/**
 * One status line per response, written only after the payload exists.
 * @param {import("node:http").ServerResponse} response
 * @param {number} status
 * @param {string} body
 */
function respond(response, status, body) {
	if (response.headersSent) {
		response.end();
		return;
	}
	response.writeHead(status, { "content-type": "application/json" });
	response.end(body);
}

/**
 * @param {import("node:http").IncomingMessage} request
 * @param {import("node:http").ServerResponse} response
 */
function handle(request, response) {
	void (async () => {
		if (request.method !== "POST" || request.url !== "/") {
			respond(
				response,
				404,
				JSON.stringify({ ok: false, error: { code: "not-found", message: "POST / is the only endpoint" } }),
			);
			return;
		}
		const authorization = request.headers.authorization;
		const token =
			typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
		try {
			const body = await readBody(request);
			const outcome = await dispatcher.handle(token, body);
			respond(response, outcome.status, outcome.body);
		} catch (error) {
			const message = error instanceof Error ? error.message : "storage service request failed";
			respond(response, 400, JSON.stringify({ ok: false, error: { code: "bad-request", message } }));
		}
	})();
}

const tlsOptions = useTls();
const server = tlsOptions ? createHttpsServer(tlsOptions, handle) : createServer(handle);

let shuttingDown = false;
async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	server.close();
	await dataPool.end().catch(() => {});
	await identityPool.end().catch(() => {});
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// A rejected promise in a socket callback must never take the service down; the
// response path above is total, so anything reaching here is logged for the operator.
process.on("unhandledRejection", (reason) => {
	process.stderr.write(`pi861-storage-service unhandled rejection: ${String(reason)}\n`);
});
process.on("uncaughtException", (error) => {
	process.stderr.write(`pi861-storage-service uncaught exception: ${String(error)}\n`);
	void shutdown().finally(() => process.exit(1));
});

await service.ready();
server.listen(port, host, () => {
	const bound = server.address();
	const listeningPort = typeof bound === "object" && bound ? bound.port : port;
	process.stdout.write(`pi861-storage-service listening ${host}:${listeningPort}\n`);
});
