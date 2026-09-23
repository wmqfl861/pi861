/**
 * P2-D storage service dispatcher regressions (review-1 F1). These are the exact
 * failure shapes from the independent review: prototype keys reaching the operation
 * allowlist, and operation results that cannot be JSON-encoded after the dispatcher
 * already reported success. No database required.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	ServiceAuthenticationError,
	StorageOperationDispatcher,
} from "../src/live/storage-service.ts";

function dispatcherOver(sessionFactory) {
	let opened = 0;
	const dispatcher = new StorageOperationDispatcher({
		async session(token) {
			opened++;
			return sessionFactory(token);
		},
	});
	return { dispatcher, sessionsOpened: () => opened };
}

test("prototype keys never reach an operation handler", async () => {
	const { dispatcher, sessionsOpened } = dispatcherOver(() => {
		throw new Error("must not authenticate for a rejected operation");
	});
	for (const op of ["constructor", "__proto__", "valueOf", "hasOwnProperty", "toString", "isPrototypeOf"]) {
		const response = await dispatcher.handle("token", { op });
		assert.equal(response.status, 404, `${op} must be rejected as unknown`);
		const parsed = JSON.parse(response.body);
		assert.equal(parsed.ok, false);
		assert.match(parsed.error.message, new RegExp(`Unknown operation: ${op}`));
	}
	assert.equal(sessionsOpened(), 0, "no session may be created for a rejected operation");
});

test("malformed request bodies are rejected without dispatching", async () => {
	const { dispatcher, sessionsOpened } = dispatcherOver(() => {
		throw new Error("must not authenticate");
	});
	for (const body of [null, [], "put", 5, {}, { op: "" }, { op: 7 }, { op: "get", args: "flat" }, { op: "get", args: [1] }]) {
		const response = await dispatcher.handle("token", body);
		assert.equal(response.status, 400, `body ${JSON.stringify(body)} must be rejected`);
		assert.equal(JSON.parse(response.body).ok, false);
	}
	assert.equal(sessionsOpened(), 0);
});

test("an operation result that cannot be encoded becomes a single 500 response", async () => {
	const circular = { name: "leak" };
	circular.self = circular;
	const { dispatcher } = dispatcherOver(() => ({ get: () => circular }));
	const response = await dispatcher.handle("token", { op: "get", args: { scope: "project:p1", id: "m1" } });
	assert.equal(response.status, 500);
	const parsed = JSON.parse(response.body);
	assert.equal(parsed.ok, false);
	assert.match(parsed.error.message, /cannot be encoded/);
});

test("authentication failures map to 401 and dispatch errors keep their status", async () => {
	const unauthorized = dispatcherOver(() => {
		throw new ServiceAuthenticationError("Unknown or disabled service principal");
	});
	const response = await unauthorized.dispatcher.handle("bad", { op: "listJobs" });
	assert.equal(response.status, 401);
	assert.equal(JSON.parse(response.body).ok, false);

	let failed = false;
	const failing = dispatcherOver(() => ({
		get: () => {
			failed = true;
			throw new Error("scope not authorized");
		},
	}));
	const failure = await failing.dispatcher.handle("token", { op: "get", args: { scope: "project:p3", id: "x" } });
	assert.equal(failure.status, 400);
	assert.match(JSON.parse(failure.body).error.message, /scope not authorized/);
	assert.ok(failed);
});
