import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolSchemaRegistry, pinActivation, validateInvocation, grantCovers, SchemaDriftError } from "../src/contracts/capability.ts";
import { OperationLedger, OperationConflict } from "../src/contracts/operation.ts";

const grants = [{ serviceId: "svc", toolName: "deploy", accountId: "acc", resourceIds: ["res-1"] }];
const tool = { serviceId: "svc", toolName: "deploy", accountId: "acc", resourceId: "res-1", schemaDigest: "sha-a" };
const registry = () => {
	const schemas = new ToolSchemaRegistry();
	schemas.register("svc", "deploy", "sha-a", 0);
	return schemas;
};

test("activation pins are content-addressed and immutable per version", () => {
	const pin = pinActivation({ skillId: "debug", skillRevision: "v3", branchIds: ["b1"], phase: "execute", tools: [tool], createdAt: 5 });
	const same = pinActivation({ skillId: "debug", skillRevision: "v3", branchIds: ["b1"], phase: "execute", tools: [structuredClone(tool)], createdAt: 9 });
	assert.equal(same.pinDigest, pin.pinDigest);
	const other = pinActivation({ skillId: "debug", skillRevision: "v4", branchIds: ["b1"], phase: "execute", tools: [structuredClone(tool)], createdAt: 5 });
	assert.notEqual(other.pinDigest, pin.pinDigest);
	assert.throws(() => pinActivation({ skillId: "debug", skillRevision: "v3", branchIds: [], phase: "execute", tools: [tool], createdAt: 5 }));
	assert.throws(() => pinActivation({ skillId: "debug", skillRevision: "v3", branchIds: ["b1", "b1"], phase: "execute", tools: [tool], createdAt: 5 }));
	assert.throws(() => pinActivation({ skillId: "debug", skillRevision: "v3", branchIds: ["b1"], phase: "execute",
		tools: [tool, { ...tool, schemaDigest: "sha-a" }], createdAt: 5 }));
});

test("invocation validates pin membership, current grants and current schema", () => {
	const pin = pinActivation({ skillId: "debug", skillRevision: "v3", branchIds: ["b1"], phase: "execute", tools: [tool], createdAt: 5 });
	const binding = validateInvocation(pin, registry(), grants, { serviceId: "svc", toolName: "deploy", accountId: "acc", resourceId: "res-1" });
	assert.deepEqual(binding, tool);
	assert.throws(() => validateInvocation(pin, registry(), grants, { serviceId: "svc", toolName: "deploy", accountId: "acc", resourceId: "res-9" }), /not part of the pinned/);
	assert.throws(() => validateInvocation(pin, registry(), [], { serviceId: "svc", toolName: "deploy", accountId: "acc", resourceId: "res-1" }), /not authorized/);
	const drifted = registry();
	drifted.register("svc", "deploy", "sha-b", 10);
	assert.throws(() => validateInvocation(pin, drifted, grants, { serviceId: "svc", toolName: "deploy", accountId: "acc", resourceId: "res-1" }),
		(error) => error instanceof SchemaDriftError);
});

test("grant coverage is exact per service, tool, account and resource", () => {
	assert.equal(grantCovers(grants, tool), true);
	assert.equal(grantCovers(grants, { ...tool, resourceId: "res-2" }), false);
	assert.equal(grantCovers(grants, { ...tool, accountId: "other" }), false);
	assert.equal(grantCovers([], tool), false);
});

test("schema registry detects drift including removed tools", () => {
	const schemas = new ToolSchemaRegistry();
	schemas.register("svc", "deploy", "sha-a", 0);
	assert.equal(schemas.drifted(tool), false);
	assert.equal(schemas.drifted({ ...tool, schemaDigest: "sha-b" }), true);
	schemas.register("svc", "deploy", "sha-b", 1);
	assert.equal(schemas.drifted(tool), true);
	assert.equal(schemas.currentSchema("svc", "missing"), undefined);
	assert.equal(schemas.drifted({ ...tool, toolName: "missing" }), true);
});

test("operations prepare idempotently and conflict on different content", () => {
	const ledger = new OperationLedger();
	const first = ledger.prepare("order-42", tool, "input-1", 1);
	const replay = ledger.prepare("order-42", structuredClone(tool), "input-1", 2);
	assert.deepEqual(replay, first);
	assert.throws(() => ledger.prepare("order-42", tool, "input-2", 3), OperationConflict);
	assert.throws(() => ledger.prepare("order-42", { ...tool, resourceId: "res-2" }, "input-1", 3), OperationConflict);
});

test("a succeeded operation is never re-dispatched under a new tool call id", () => {
	const ledger = new OperationLedger();
	ledger.prepare("order-42", tool, "input-1", 1);
	assert.equal(ledger.canDispatch("order-42"), true);
	ledger.markDispatched("order-42", 2);
	assert.equal(ledger.canDispatch("order-42"), false);
	ledger.markSucceeded("order-42", "result-1", 3);
	assert.equal(ledger.canDispatch("order-42"), false);
	assert.equal(ledger.get("order-42")?.resultDigest, "result-1");
	assert.throws(() => ledger.markDispatched("order-42", 4), /cannot move/);
});

test("unknown outcomes block retry until reconciliation decides the truth", () => {
	const ledger = new OperationLedger();
	ledger.prepare("order-42", tool, "input-1", 1);
	ledger.markDispatched("order-42", 2);
	ledger.markUnknown("order-42", "receipt lost", 3);
	assert.equal(ledger.canDispatch("order-42"), false);
	assert.throws(() => ledger.markSucceeded("order-42", "late", 4), /cannot move/);
	ledger.reconcile("order-42", { status: "succeeded", resultDigest: "result-1" }, 5);
	assert.equal(ledger.get("order-42")?.status, "succeeded");
	assert.equal(ledger.get("order-42")?.reconciled, true);
	assert.equal(ledger.canDispatch("order-42"), false);
});

test("reconciliation to not-executed re-arms dispatch exactly once", () => {
	const ledger = new OperationLedger();
	ledger.prepare("order-43", tool, "input-1", 1);
	ledger.markDispatched("order-43", 2);
	ledger.markUnknown("order-43", "stream cut", 3);
	ledger.reconcile("order-43", { status: "not-executed" }, 4);
	assert.equal(ledger.canDispatch("order-43"), true);
	assert.throws(() => ledger.reconcile("order-43", { status: "failed", error: "again" }, 5), /not awaiting reconciliation/);
	ledger.markDispatched("order-43", 6);
	ledger.markFailed("order-43", "provider refused", 7);
	assert.equal(ledger.get("order-43")?.status, "failed");
});

test("operation snapshots round-trip and reject tampered entries", () => {
	const ledger = new OperationLedger();
	ledger.prepare("order-44", tool, "input-1", 1);
	ledger.markDispatched("order-44", 2);
	const snapshot = ledger.exportState();
	const restored = new OperationLedger();
	restored.restore(snapshot);
	assert.equal(restored.get("order-44")?.status, "dispatched");
	const forged = structuredClone(snapshot);
	forged.operations[0].status = "bogus";
	assert.throws(() => new OperationLedger().restore(forged), /Invalid operation snapshot/);
});
