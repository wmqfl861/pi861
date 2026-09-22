import assert from "node:assert/strict";
import { test } from "node:test";
import {
	IdentityAuthority, formatScope, parseScope, outboundAllows, resolveOutbound, isPrivateNetworkHost,
	executionPath, parseExecutionPath, validateExecutionIdentity,
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
