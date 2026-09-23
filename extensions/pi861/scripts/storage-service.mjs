#!/usr/bin/env node
/**
 * pi861 trusted storage service entry (P2-D).
 *
 * The process holds the database credentials; workers never do. Each request carries
 * only a bearer token, which is resolved server-side to the principal identity
 * (tenant + scopes) recorded in pi861_service_principals. Tenant, role or scope
 * values in a request body are never trusted for authorization.
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
import { BudgetExhausted, ProbeInFlight } from "../src/contracts/budget.ts";
import { IdempotencyConflict, VersionConflict } from "../src/contracts/storage.ts";
import { createPostgresPool } from "../src/live/postgres-configuration.ts";
import {
	LeaseNotHeld,
	ServiceAuthenticationError,
	ServicePrincipalDirectory,
	StorageSchemaError,
	StorageService,
} from "../src/live/storage-service.ts";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY_BYTES = 1_048_576;

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

function asString(value, field) {
	if (typeof value !== "string" || !value) throw new Error(`Field ${field} must be a non-empty string`);
	return value;
}
function asNumber(value, field) {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Field ${field} must be a finite number`);
	return value;
}
function optional(value, field) {
	return value === undefined || value === null ? undefined : asString(value, field);
}

/** Scoped operation table. Every handler receives the server-resolved session only. */
const OPERATIONS = {
	put: (session, args) =>
		session.put({
			requestId: asString(args.requestId, "requestId"),
			expectedRevision:
				args.expectedRevision === null || args.expectedRevision === undefined ? null : asNumber(args.expectedRevision, "expectedRevision"),
			item: args.item,
		}),
	withdraw: (session, args) =>
		session.withdraw(
			asString(args.requestId, "requestId"),
			asString(args.scope, "scope"),
			asString(args.id, "id"),
			asNumber(args.expectedRevision, "expectedRevision"),
		),
	get: (session, args) => session.get(asString(args.scope, "scope"), asString(args.id, "id")),
	search: (session, args) => session.search(asString(args.query, "query"), args.limit === undefined ? undefined : asNumber(args.limit, "limit")),
	list: (session, args) =>
		session.list(asString(args.scope, "scope"), optional(args.afterId, "afterId"), args.limit === undefined ? undefined : asNumber(args.limit, "limit")),
	delta: (session, args) =>
		session.delta(
			args.afterSequence === undefined ? undefined : asNumber(args.afterSequence, "afterSequence"),
			args.limit === undefined ? undefined : asNumber(args.limit, "limit"),
		),
	reconcile: (session, args) => session.reconcile(asString(args.requestId, "requestId"), optional(args.expectedDigest, "expectedDigest")),
	listJobs: (session) => session.listJobs(),
	requeueJob: (session, args) => session.requeueJob(asString(args.jobId, "jobId")),
	createBudget: (session, args) => session.createBudget(args.rootLimits, args.budgetId === undefined ? undefined : asString(args.budgetId, "budgetId")),
	registerBudgetTask: (session, args) =>
		session.registerBudgetTask(
			asString(args.budgetId, "budgetId"),
			asString(args.taskId, "taskId"),
			args.parentTaskId === null || args.parentTaskId === undefined ? null : asString(args.parentTaskId, "parentTaskId"),
			args.subtreeLimits,
		),
	reserveBudget: (session, args) =>
		session.reserveBudget(
			asString(args.budgetId, "budgetId"),
			args.taskId === null || args.taskId === undefined ? null : asString(args.taskId, "taskId"),
			asString(args.kind, "kind"),
			args.estimate,
			args.probeKey === undefined ? {} : { probeKey: asString(args.probeKey, "probeKey") },
		),
	settleBudget: (session, args) =>
		session.settleBudget(asString(args.budgetId, "budgetId"), asString(args.reservationId, "reservationId"), args.actual),
	settleBudgetUnknown: (session, args) =>
		session.settleBudgetUnknown(
			asString(args.budgetId, "budgetId"),
			asString(args.reservationId, "reservationId"),
			args.conservativeEstimate,
		),
	releaseBudget: (session, args) =>
		session.releaseBudget(asString(args.budgetId, "budgetId"), asString(args.reservationId, "reservationId")),
	budgetUsage: (session, args) => session.budgetUsage(asString(args.budgetId, "budgetId")),
	acquireLease: (session, args) =>
		session.acquireLease(asString(args.purpose, "purpose"), asString(args.owner, "owner"), asNumber(args.leaseMs, "leaseMs")),
	renewLease: (session, args) =>
		session.renewLease(asString(args.purpose, "purpose"), asString(args.token, "token"), asNumber(args.leaseMs, "leaseMs")),
	releaseLease: (session, args) => session.releaseLease(asString(args.purpose, "purpose"), asString(args.token, "token")),
	leaseSnapshot: (session, args) => session.leaseSnapshot(asString(args.purpose, "purpose")),
	claimEvents: (session, args) => session.claimEvents(args.limit === undefined ? undefined : asNumber(args.limit, "limit")),
	completeEvent: (session, args) => session.completeEvent(asNumber(args.sequence, "sequence"), args.outcome),
};

function errorStatus(error) {
	if (error instanceof ServiceAuthenticationError) return 401;
	if (error instanceof IdempotencyConflict || error instanceof VersionConflict) return 409;
	if (error instanceof BudgetExhausted || error instanceof ProbeInFlight) return 429;
	if (error instanceof LeaseNotHeld) return 409;
	if (error instanceof StorageSchemaError) return 503;
	return 400;
}

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
	if (!cert || !key) throw new Error("Non-loopback storage service binds require PI861_STORAGE_TLS_CERT and PI861_STORAGE_TLS_KEY");
	return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") };
}

function handle(request, response) {
	void (async () => {
		if (request.method !== "POST" || request.url !== "/") {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: false, error: { code: "not-found", message: "POST / is the only endpoint" } }));
			return;
		}
		const authorization = request.headers.authorization;
		const token = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
		try {
			const body = await readBody(request);
			const operation = OPERATIONS[asString(body?.op, "op")];
			if (!operation) throw new Error(`Unknown operation: ${String(body?.op)}`);
			const session = await service.session(token);
			const result = await operation(session, body.args ?? {});
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
		} catch (error) {
			const message = error instanceof Error ? error.message : "storage service request failed";
			response.writeHead(errorStatus(error), { "content-type": "application/json" });
			response.end(JSON.stringify({ ok: false, error: { code: error.constructor.name, message } }));
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

await service.ready();
server.listen(port, host, () => {
	const bound = server.address();
	const listeningPort = typeof bound === "object" && bound ? bound.port : port;
	process.stdout.write(`pi861-storage-service listening ${host}:${listeningPort}\n`);
});
