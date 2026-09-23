import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IdentityAuthority, formatScope, parseScope, outboundAllows, resolveOutbound, isPrivateNetworkHost,
	executionPath, parseExecutionPath, validateExecutionIdentity,
	TRUSTED_LOCAL_TENANT_ID, TRUSTED_LOCAL_PRINCIPAL_ENV, TRUSTED_LOCAL_FALLBACK_PRINCIPAL_ID,
	trustedLocalPrincipalId,
} from "../src/contracts/identity.ts";

const roles = [{
	id: "developer", revision: "r1",
	readScopes: ["project:pi861", "task:pi861/t1"],
	writeScopes: ["project:pi861"],
	outbound: [{ hostPattern: "api.example.com", protocols: ["https"], allowPrivateNetworks: false }],
	toolGrants: [{ serviceId: "svc", toolName: "deploy", accountId: "acc", resourceIds: ["res-1", "res-2"] }],
}];
const authority = () => new IdentityAuthority({ authorityId: "auth-1", tenantId: "tenant-1", roles: structuredClone(roles) });

test("scopes parse, format and reject non-canonical forms", () => {
	assert.equal(formatScope(parseScope("project:pi861")), "project:pi861");
	assert.throws(() => parseScope("project:"));
	assert.throws(() => parseScope("tenant:x"));
	assert.throws(() => parseScope("project:UPPER"));
});

test("private, loopback, link-local and metadata addresses are recognized", () => {
	for (const host of ["localhost", "127.0.0.1", "10.1.2.3", "172.16.0.9", "192.168.1.4", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "metadata.internal"]) {
		assert.equal(isPrivateNetworkHost(host), true, host);
	}
	for (const host of ["example.com", "8.8.8.8"]) assert.equal(isPrivateNetworkHost(host), false, host);
});

test("outbound policy allows only matched hosts and protocols", () => {
	const outbound = resolveOutbound([{ hostPattern: "*.example.com", protocols: ["https"], allowPrivateNetworks: false }]);
	assert.equal(outboundAllows(outbound, new URL("https://api.example.com/x")), true);
	assert.equal(outboundAllows(outbound, new URL("http://api.example.com/x")), false);
	assert.equal(outboundAllows(outbound, new URL("https://api.example.com.evil.net/x")), false);
	assert.throws(() => resolveOutbound([{ hostPattern: "bad host/name", protocols: ["https"], allowPrivateNetworks: false }]));
});

test("credentials are issued, narrowed for subagents and verified against tampering", () => {
	const auth = authority();
	const agent = auth.issue("agent-1", { roleIds: ["developer"] });
	assert.deepEqual(agent.readScopes, ["project:pi861", "task:pi861/t1"]);
	const sub = auth.deriveSubordinate(agent, "sub-1", { restriction: { readScopes: ["task:pi861/t1"] } });
	assert.deepEqual(sub.readScopes, ["task:pi861/t1"]);
	assert.deepEqual(sub.writeScopes, []);
	auth.assertRead(agent, "project:pi861");
	auth.assertWrite(agent, "project:pi861");
	assert.throws(() => auth.assertWrite(sub, "project:pi861"), /not authorized/);
	const tampered = { ...structuredClone(agent), readScopes: ["shared:everything"] };
	assert.throws(() => auth.verify(tampered), /does not match|Untrusted identity/);
	const foreign = authority();
	assert.throws(() => foreign.verify(agent), /Untrusted identity/);
});

test("revocation cascades to subordinates and invalidates outstanding credentials", () => {
	const auth = authority();
	const agent = auth.issue("agent-1", { roleIds: ["developer"] });
	const sub = auth.deriveSubordinate(agent, "sub-1", { restriction: {} });
	auth.revoke("agent-1");
	assert.throws(() => auth.verify(agent), /revoked/);
	assert.throws(() => auth.verify(sub), /revoked/);
});

test("execution identity paths round-trip and reject malformed parts", () => {
	const identity = validateExecutionIdentity({ tenantId: "t", projectId: "p", goalId: "g", runId: "r", taskId: "task-1", attempt: 2 });
	assert.deepEqual(parseExecutionPath(executionPath(identity)), identity);
	assert.throws(() => parseExecutionPath("t/p/g/r/task-1"));
	assert.throws(() => validateExecutionIdentity({ ...identity, attempt: 0 }));
});

test("F01/F02 revocation survives restart and reaches every descendant", () => {
	const auth = authority();
	const parent = auth.issue("parent", { roleIds: ["developer"], now: 1 });
	const child = auth.deriveSubordinate(parent, "child", { restriction: {}, now: 2 });
	const grandchild = auth.deriveSubordinate(child, "grandchild", { restriction: {}, now: 3 });
	const unrelated = auth.issue("other", { roleIds: ["developer"], now: 4 });
	auth.revoke("parent");
	const restored = authority();
	restored.restore(auth.exportState());
	for (const issuer of [auth, restored]) {
		for (const credential of [parent, child, grandchild]) assert.throws(() => issuer.verify(credential), /revoked/);
		assert.deepEqual(issuer.verify(unrelated), unrelated);
	}
	const legacy = { ...auth.exportState(), version: 1 };
	delete legacy.revokedPrincipalIds;
	assert.throws(() => restored.restore(legacy), /Invalid authority snapshot/);
	assert.throws(() => restored.verify(grandchild), /revoked/);
});

test("F14 execution paths escape separators without identity collisions", () => {
	const base = { tenantId: "t", projectId: "p", goalId: "g", runId: "r", taskId: "task", attempt: 1 };
	const first = { ...base, tenantId: "t/a" };
	const second = { ...base, projectId: "a/p" };
	assert.notEqual(executionPath(first), executionPath(second));
	for (const field of ["tenantId", "projectId", "goalId", "runId", "taskId"]) {
		const identity = { ...base, [field]: "a/../b" };
		assert.deepEqual(parseExecutionPath(executionPath(identity)), identity);
		assert.equal(executionPath(identity).split("/").length, 6);
	}
});

test("authority snapshots restore with integrity checks and a fresh epoch", () => {
	const auth = authority();
	auth.issue("agent-1", { roleIds: ["developer"], now: 1_000 });
	const snapshot = auth.exportState();
	const restored = authority();
	restored.restore(snapshot);
	const replayed = restored.exportState();
	assert.equal(replayed.epoch, snapshot.epoch + 1);
	const forged = structuredClone(snapshot);
	forged.credentials[0].readScopes = ["shared:everything"];
	assert.throws(() => authority().restore(forged), /integrity|Untrusted|Invalid/);
});

test("the local tenant exists only in trusted-local mode (G1)", () => {
	assert.equal(TRUSTED_LOCAL_TENANT_ID, "local");
	assert.equal(TRUSTED_LOCAL_PRINCIPAL_ENV, "PI861_AGENT_ID");
	assert.equal(TRUSTED_LOCAL_FALLBACK_PRINCIPAL_ID, "main");
	assert.throws(() => new IdentityAuthority({ authorityId: "svc", tenantId: "local", roles: [] }), /trusted-local/);
	const trusted = new IdentityAuthority({ authorityId: "local-auth", tenantId: "local", roles: structuredClone(roles), trustedLocal: true });
	const principal = trusted.issue("main", { roleIds: ["developer"] });
	assert.equal(principal.tenantId, "local");
	// A remote/service authority never verifies local-tenant credentials: it cannot even exist.
	assert.throws(() => new IdentityAuthority({ authorityId: "svc", tenantId: "local", roles: [], trustedLocal: false }), /trusted-local/);
});

test("trusted-local principal id resolves PI861_AGENT_ID with a main fallback", () => {
	assert.equal(trustedLocalPrincipalId(undefined), "main");
	assert.equal(trustedLocalPrincipalId(""), "main");
	assert.equal(trustedLocalPrincipalId("  "), "main");
	assert.equal(trustedLocalPrincipalId("worker-7"), "worker-7");
	assert.throws(() => trustedLocalPrincipalId("bad id"));
	assert.throws(() => trustedLocalPrincipalId("/abs"));
});
