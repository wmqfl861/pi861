import assert from "node:assert/strict";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authorizeRuntimeWeb, validateRuntimeConfig } from "../src/live/runtime-configuration.ts";

const base = () => ({ version: 2, projectId: "project", stateDirectory: join(tmpdir(), "pi861-config-validation"), role: { id: "dev", skillIds: [], grants: [] } });
const principal = { owner: JSON.stringify(["local", "main", "dev", "project:project"]), scope: "project:project" };

test("trusted configuration rejects wrong switch types, duplicate authority identities and relative storage", () => {
	assert.equal(validateRuntimeConfig(base()).projectId, "project");
	assert.throws(() => validateRuntimeConfig({ ...base(), memory: { autoCapture: "false" } }), /boolean/);
	assert.throws(() => validateRuntimeConfig({ ...base(), stateDirectory: "relative" }), /absolute/);
	assert.throws(() => validateRuntimeConfig({ ...base(), roles: [base().role] }), /Duplicate runtime role/);
	const server = { id: "svc", accountId: "account", transport: { kind: "http", url: "https://mcp.example.test" } };
	assert.throws(() => validateRuntimeConfig({ ...base(), mcp: [server, server] }), /Duplicate MCP/);
});

test("web permissions are principal-bound, hot-revocable and deny undeclared destinations", () => {
	const config = validateRuntimeConfig({ ...base(), web: {
		roleIds: ["dev"], maxRequests: 4, search: { enabled: true, apiKeyEnv: "TEST_SEARCH_KEY" },
		read: { enabled: true, allowedHosts: ["example.com"] },
	} });
	assert.equal(authorizeRuntimeWeb(config, "dev", { ...principal, kind: "search", url: "https://api.search.brave.com/res/v1/web/search" }), true);
	assert.equal(authorizeRuntimeWeb(config, "dev", { ...principal, kind: "web-read", url: "https://example.com/page" }), true);
	assert.equal(authorizeRuntimeWeb(config, "dev", { ...principal, kind: "result", url: "https://example.com/page" }), true);
	assert.equal(authorizeRuntimeWeb(config, "dev", { ...principal, owner: "dev", kind: "result", url: "https://example.com/page" }), false);
	assert.equal(authorizeRuntimeWeb(config, "dev", { ...principal, kind: "web-read", url: "https://example.com.attacker.test" }), false);
	assert.equal(authorizeRuntimeWeb(config, "dev", { ...principal, kind: "web-read", url: "http://example.com" }), false);
	config.web.roleIds = [];
	assert.equal(authorizeRuntimeWeb(config, "dev", { ...principal, kind: "result", url: "https://example.com/page" }), false);
});

test("web JSON cannot smuggle backend code, embedded credentials or an undeclared role", () => {
	const web = { roleIds: ["dev"], maxRequests: 1, search: { enabled: true } };
	assert.throws(() => validateRuntimeConfig({ ...base(), web: { ...web, roleIds: ["admin"] } }), /Unknown web role/);
	assert.throws(() => validateRuntimeConfig({ ...base(), web: { ...web, search: { enabled: true, apiKey: "secret" } } }), /credential variable/);
	assert.throws(() => validateRuntimeConfig({ ...base(), web: { ...web, read: { enabled: true, allowedHosts: ["example.com/path"] } } }), /hostname grants/);
	assert.equal(authorizeRuntimeWeb(validateRuntimeConfig(base()), "dev", { ...principal, kind: "search", url: "https://api.search.brave.com/res/v1/web/search" }), false);
});
