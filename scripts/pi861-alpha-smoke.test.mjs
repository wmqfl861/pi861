import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ROOT, checkFiles, loadTeam } from "./pi861-alpha.mjs";
import { loadSmokeConfig, modelFile, settingsForAll, validateEndpoint, runSmoke } from "./pi861-alpha-smoke.mjs";

const config = loadSmokeConfig();
test("same-model exception is confined to smoke; production Alpha stays unarmed and heterogeneous", () => {
  assert.equal(config.independentReview, false);
  assert.equal(config.mode, "same-model-smoke-only");
  const team = loadTeam();
  assert.equal(team.execution.sameModelFallbackAllowed, false);
  assert.equal(team.execution.liveEnabled, false);
  assert.equal(checkFiles().profiles.length, 14);
});
test("all fourteen overrides preserve model id and max reasoning separately", () => {
  const profiles = checkFiles().profiles, settings = settingsForAll(profiles, config);
  assert.equal(Object.keys(settings.subagents.agentOverrides).length, 14);
  for (const p of profiles) assert.deepEqual(settings.subagents.agentOverrides[p.name], {
    model: "pi-alpha-smoke/gpt-6-luna", thinking: "max"
  });
  assert.equal(settings.defaultModel, "gpt-6-luna");
  assert.equal(settings.defaultThinkingLevel, "max");
});
test("custom Pi provider uses Responses, enabled max reasoning and an environment key reference", () => {
  const doc = modelFile(config, "https://fixture.invalid/v1"), p = doc.providers[config.provider], m = p.models[0];
  assert.equal(p.api, "openai-responses");
  assert.equal(p.apiKey, "$PI_ALPHA_TEST_API_KEY");
  assert.equal(m.reasoning, true);
  assert.equal(m.thinkingLevelMap.max, "max");
  assert.equal(m.samplingParams.max_output_tokens, 4096);
  assert.ok(!JSON.stringify(doc).includes("sk-"));
});
test("HTTP requires explicit approval", () => {
  assert.throws(() => validateEndpoint("http://fixture.invalid/v1", false), /approval/);
  assert.equal(validateEndpoint("http://fixture.invalid/v1", true), "http://fixture.invalid/v1");
});
test("gateway credentials cannot be placed in URLs or query strings", () => {
  for (const url of ["https://name:secret@fixture.invalid/v1", "https://fixture.invalid/v1?key=secret", "https://fixture.invalid/v1#secret"])
    assert.throws(() => validateEndpoint(url, false), /Credentials/);
});
test("unexpected protocols and paths are rejected", () => {
  for (const url of ["ftp://fixture.invalid/v1", "file:///v1", "https://fixture.invalid/v2"])
    assert.throws(() => validateEndpoint(url, false));
});
test("live test cannot silently invent or inherit a key", async () => {
  await assert.rejects(runSmoke("live", { PI_ALPHA_TEST_BASE_URL: "https://fixture.invalid/v1" }), /key environment variable missing/);
});
test("unknown commands do not execute", async () => {
  await assert.rejects(runSmoke("production"), /Expected/);
});
test("fixture executes 14 actual Pi sessions, 28 streamed requests and one real local tool call per role", { timeout: 30000 }, async () => {
  const before = readFileSync(join(ROOT, ".pi/settings.json"), "utf8");
  const r = await runSmoke("fixture", {});
  assert.equal(r.status, "passed"); assert.equal(r.sessions.length, 14);
  assert.equal(r.requests.length, 28); assert.equal(r.maxActiveSessions, 2);
  assert.equal(new Set(r.sessions.map((s) => s.sessionId)).size, 14);
  assert.ok(r.sessions.every((s) => s.toolCalls === 1 && s.status === "passed" && s.thinking === "max"));
  assert.ok(r.requests.every((q) => q.fixture && q.reasoningEffort === "max" && q.path === "/v1/responses"));
  assert.deepEqual(r.notRun, []); assert.equal(r.independentReview, false);
  assert.equal(r.billingCost, null); assert.equal(r.providerIdentityVerified, false);
  assert.equal(readFileSync(join(ROOT, ".pi/settings.json"), "utf8"), before);
});
