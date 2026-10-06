#!/usr/bin/env node
// Project-local entry point. Credential file is ignored by Git and never included in output.
// Run through the repository tsx loader. No CI upload or external credential relay.
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT } from "./pi861-alpha.mjs";
import { loadSmokeConfig, runSmoke } from "./pi861-alpha-smoke.mjs";

export function readGateway(path) {
  const info = lstatSync(path);
  assert.ok(info.isFile() && info.size <= 4096, "Expected a small regular private configuration file");
  if (process.platform !== "win32") assert.equal(info.mode & 0o077, 0, "Private configuration must use mode 600");
  const config = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(Object.keys(config).sort(), ["apiKey", "baseUrl", "model", "thinking"].sort());
  const policy = loadSmokeConfig();
  assert.equal(config.model, policy.model); assert.equal(config.thinking, policy.thinking);
  assert.equal(typeof config.apiKey, "string"); assert.ok(config.apiKey.trim().length > 0);
  return config;
}
export async function localSmoke(mode = "live") {
  assert.ok(["configure", "live"].includes(mode), "Choose configure or live");
  const config = readGateway(join(ROOT, ".pi/alpha/private/luna-gateway.local.json"));
  const result = await runSmoke(mode, { PI_ALPHA_TEST_BASE_URL: config.baseUrl, PI_ALPHA_TEST_API_KEY: config.apiKey });
  const directory = join(ROOT, ".artifacts/pi861-alpha-local-smoke"); mkdirSync(directory, { recursive: true });
  const file = join(directory, `${mode}.json`);
  const safe = JSON.stringify(result, null, 2).split(config.apiKey).join("[redacted]");
  writeFileSync(file, safe + "\n", { mode: 0o600 }); chmodSync(file, 0o600);
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.ok(process.argv.length <= 3, "Unexpected arguments");
    const result = await localSmoke(process.argv[2] ?? "live");
    console.log(JSON.stringify({ status: result.status, model: result.model, thinking: result.thinking,
      configuredRoles: result.configuredRoles, testedRoles: result.sessions.length,
      passedRoles: result.sessions.filter((s) => s.status === "passed").length,
      failedRoles: result.sessions.filter((s) => s.status === "failed").length,
      notRunRoles: result.notRun?.length ?? null, requests: result.requests.length,
      httpResponses: result.requests.filter((r) => r.status !== null).length,
      networkErrorCodes: [...new Set(result.requests.map((r) => r.error?.code).filter(Boolean))],
      toolCalls: result.sessions.reduce((n, s) => n + (s.toolCalls ?? 0), 0),
      sameModelSmokeOnly: true, independentReview: false, providerIdentityVerified: false }, null, 2));
    if (result.status === "failed") process.exitCode = 1;
  } catch {
    console.error("Local smoke could not complete. Check the ignored private gateway configuration and sanitized local report; credential values are not logged.");
    process.exitCode = 1;
  }
}
