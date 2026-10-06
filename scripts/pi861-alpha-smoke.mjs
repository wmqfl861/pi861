#!/usr/bin/env node
// Bounded Pi-native connectivity harness. Never enables production Alpha dispatch.
// Run with the repository's tsx loader; secrets enter only through environment variables.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { createAgentSession } from "../packages/coding-agent/src/core/sdk.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { SessionManager } from "../packages/coding-agent/src/core/session-manager.ts";
import { SettingsManager } from "../packages/coding-agent/src/core/settings-manager.ts";
import { createExtensionRuntime } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { discoverAgents } from "../.pi/npm/node_modules/pi-subagents/src/agents/agents.js";
import { resolveSkills } from "../.pi/npm/node_modules/pi-subagents/src/agents/skills.js";
import { ROOT, checkFiles } from "./pi861-alpha.mjs";

export function loadSmokeConfig() {
  const c = JSON.parse(readFileSync(join(ROOT, ".pi/alpha/luna-smoke.json"), "utf8"));
  assert.equal(c.mode, "same-model-smoke-only"); assert.equal(c.allowSameModel, true);
  assert.equal(c.independentReview, false); assert.equal(c.model, "gpt-6-luna");
  assert.equal(c.thinking, "max"); assert.equal(c.api, "openai-responses");
  for (const k of ["maxRequests", "maxConcurrent", "maxOutputTokens", "requestTimeoutMs", "sessionTimeoutMs", "totalTimeoutMs"])
    assert.ok(Number.isSafeInteger(c[k]) && c[k] > 0, `Invalid ${k}`);
  assert.ok(c.maxRequests <= 32 && c.maxConcurrent === 2 && c.maxOutputTokens <= 4096);
  return c;
}
export function validateEndpoint(value, allowHttp) {
  assert.ok(typeof value === "string" && value.length > 0, "Explicit gateway URL required");
  const u = new URL(value);
  assert.ok(!u.username && !u.password && !u.search && !u.hash, "Credentials/query not allowed in URL");
  assert.ok(u.protocol === "https:" || (u.protocol === "http:" && allowHttp), "HTTP needs explicit approval");
  assert.equal(u.pathname.replace(/\/$/, ""), "/v1", "Expected /v1 endpoint");
  return u.href.replace(/\/$/, "");
}
export function settingsForAll(profiles, c) {
  return { defaultProvider: c.provider, defaultModel: c.model, defaultThinkingLevel: c.thinking,
    compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 },
    subagents: { defaultModel: `${c.provider}/${c.model}`, defaultThinking: c.thinking,
      agentOverrides: Object.fromEntries(profiles.map((p) => [p.name, { model: `${c.provider}/${c.model}`, thinking: c.thinking }])) } };
}
export function modelFile(c, baseUrl) {
  return { providers: { [c.provider]: { baseUrl, api: c.api, apiKey: `$${c.apiKeyEnv}`, authHeader: true,
    models: [{ id: c.model, name: "Luna max — Alpha smoke only", reasoning: true,
      thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
      input: ["text"], contextWindow: 128000, maxTokens: c.maxOutputTokens,
      samplingParams: { max_output_tokens: c.maxOutputTokens },
      compat: { supportsLongCacheRetention: false, supportsStrictMode: false } }] } } };
}
function safeError(error, key) {
  let s = error instanceof Error ? error.message : String(error);
  if (key) s = s.split(key).join("[redacted]");
  return { name: error?.name ?? "Error", code: error?.cause?.code ?? error?.code ?? null,
    message: s.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]").slice(0, 500) };
}
function fixtureResponse(body) {
  const result = body.input.findLast((i) => i.type === "function_call_output");
  const id = randomBytes(8).toString("hex");
  let item;
  if (result) {
    const text = typeof result.output === "string" ? result.output : result.output.map((p) => p.text ?? "").join("");
    item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: `ALPHA_SMOKE_OK ${text}`, annotations: [] }] };
  } else item = { type: "function_call", id: `fc_${id}`, call_id: `call_${id}`, name: "alpha_smoke_probe", arguments: "{}" };
  const events = [
    { type: "response.created", response: { id: `resp_${id}` } },
    { type: "response.output_item.added", output_index: 0,
      item: item.type === "message" ? { ...item, status: "in_progress", content: [] } : { ...item, arguments: "" } },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id: `resp_${id}`, status: "completed", output: [item],
      usage: { input_tokens: 100, output_tokens: 15, total_tokens: 115, input_tokens_details: { cached_tokens: 0 } } } }
  ];
  return new Response(events.map((e, n) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: n })}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } });
}
export async function runSmoke(mode, env = process.env) {
  assert.ok(["configure", "fixture", "live"].includes(mode), "Expected configure, fixture or live");
  const c = loadSmokeConfig(), config = checkFiles();
  const fixture = mode === "fixture";
  const baseUrl = validateEndpoint(fixture ? "https://fixture.invalid/v1" : env[c.baseUrlEnv], c.allowPlainHttp);
  const key = fixture ? "fixture-key-not-a-credential" : env[c.apiKeyEnv];
  if (mode === "live") assert.ok(typeof key === "string" && key.trim(), "API key environment variable missing");
  const home = join(ROOT, ".pi/alpha/private/luna-smoke/agent");
  if (!fixture) {
    mkdirSync(home, { recursive: true, mode: 0o700 }); chmodSync(home, 0o700);
    for (const [name, content] of [["models.json", modelFile(c, baseUrl)], ["settings.json", settingsForAll(config.profiles, c)]]) {
      writeFileSync(join(home, name), JSON.stringify(content, null, 2) + "\n", { mode: 0o600 }); chmodSync(join(home, name), 0o600);
    }
  }
  const report = { mode, model: c.model, thinking: c.thinking, api: c.api, configuredRoles: config.profiles.length,
    sameModelSmokeOnly: true, independentReview: false, providerIdentityVerified: false, billingCost: null,
    limits: { requests: c.maxRequests, concurrency: c.maxConcurrent, outputTokensPerRequest: c.maxOutputTokens },
    status: mode === "configure" ? "configured-not-tested" : "running", requests: [], sessions: [], maxActiveSessions: 0 };
  if (mode === "configure") return report;
  const temp = mkdtempSync(join(tmpdir(), "pi-alpha-luna-smoke-"));
  const started = Date.now(); let active = 0;
  const discovered = discoverAgents(ROOT, "project", undefined, { globalNpmRoot: null });
  const names = new Set(config.profiles.map((p) => p.name));
  const agents = discovered.agents.filter((a) => names.has(a.name));
  assert.equal(agents.length, 14);
  const guardFetch = async (url, init) => {
    const requestUrl = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    assert.equal(requestUrl.href, `${baseUrl}/responses`, "Unexpected destination blocked");
    assert.ok(Date.now() - started < c.totalTimeoutMs, "Total test deadline exceeded");
    assert.ok(report.requests.length < c.maxRequests, "Request budget exhausted");
    const body = JSON.parse(init.body);
    assert.equal(body.model, c.model); assert.equal(body.reasoning?.effort, "max");
    assert.equal(body.max_output_tokens, c.maxOutputTokens); assert.equal(body.stream, true);
    assert.equal(body.store, false);
    const record = { number: report.requests.length + 1, method: init.method, path: "/v1/responses",
      model: body.model, reasoningEffort: body.reasoning.effort, maxOutputTokens: body.max_output_tokens,
      startedAt: new Date().toISOString(), fixture, status: null };
    report.requests.push(record);
    try {
      const response = fixture ? fixtureResponse(body) : await fetch(url, { ...init, redirect: "error",
        signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(c.requestTimeoutMs)]) });
      record.status = response.status; record.finishedAt = new Date().toISOString();
      return response;
    } catch (error) { record.error = safeError(error, key); throw error; }
  };
  async function exercise(agent, ready) {
    const cwd = join(temp, agent.name); mkdirSync(cwd);
    const agentDir = join(cwd, "agent"); mkdirSync(agentDir);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelFile(c, baseUrl)));
    const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false });
    assert.equal(runtime.getError(), undefined);
    await runtime.setRuntimeApiKey(c.provider, key);
    const model = runtime.getModel(c.provider, c.model); assert.ok(model);
    const originalStream = runtime.streamSimple.bind(runtime);
    runtime.streamSimple = (m, ctx, options) => originalStream(m, ctx, { ...options,
      fetch: guardFetch, maxTokens: c.maxOutputTokens, maxRetries: 0, timeoutMs: c.requestTimeoutMs });
    const skills = resolveSkills(agent.skills, ROOT, agent.skillPath, dirname(agent.filePath));
    assert.deepEqual(skills.missing, []);
    const scope = "CURRENT USER OVERRIDE: this is an explicitly authorized same-model connectivity smoke only, not research or independent review. " +
      "For this test the unconfigured-model prohibition is replaced by the selected Luna/max. Use only alpha_smoke_probe; do not research, read other files, delegate, or refuse because this is the same model. " +
      "Call the probe once with {} and then return exactly ALPHA_SMOKE_OK followed by the returned token.";
    const resourceLoader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
      getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => `${agent.systemPrompt}\n${skills.resolved.map((s) => s.content).join("\n")}\n${scope}`,
      getSystemPromptSource: () => undefined, getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
      extendResources: () => {}, reload: async () => {} };
    let toolCalls = 0;
    const token = randomBytes(16).toString("hex");
    const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model,
      thinkingLevel: c.thinking, tools: ["alpha_smoke_probe"], resourceLoader,
      customTools: [{ name: "alpha_smoke_probe", label: "Smoke probe", description: "Return a host-generated test token; no side effects.",
        parameters: Type.Object({}), execute: async () => { assert.equal(++toolCalls, 1, "Probe must execute once");
          return { content: [{ type: "text", text: token }], details: {} }; } }],
      sessionManager: SessionManager.inMemory(cwd), settingsManager: SettingsManager.inMemory(settingsForAll(config.profiles, c)) });
    const row = { agent: agent.name, model: `${model.provider}/${model.id}`, thinking: session.thinkingLevel,
      skillCount: skills.resolved.length, sessionId: session.sessionId, startedAt: new Date().toISOString(), status: "running" };
    report.sessions.push(row); active++; report.maxActiveSessions = Math.max(report.maxActiveSessions, active);
    const timer = setTimeout(() => { void session.abort(); }, c.sessionTimeoutMs);
    try {
      await ready();
      assert.equal(session.thinkingLevel, "max");
      await session.prompt(`ROLE=${agent.name}\n${scope}`);
      const messages = session.agent.state.messages.filter((m) => m.role === "assistant");
      const last = messages.at(-1); assert.ok(last, "No assistant result");
      assert.equal(last.stopReason, "stop", `Model did not finish: ${last.errorMessage ?? last.stopReason}`);
      assert.equal(toolCalls, 1, "Missing real tool invocation");
      assert.ok(last.content.some((p) => p.type === "text" && p.text.includes(token)), "Tool token not returned in final answer");
      row.status = "passed"; row.toolCalls = toolCalls;
      row.usage = messages.map((m) => ({ input: m.usage.input, output: m.usage.output, cacheRead: m.usage.cacheRead,
        totalTokens: m.usage.totalTokens }));
    } catch (error) { row.status = "failed"; row.error = safeError(error, key); row.toolCalls = toolCalls; }
    finally { clearTimeout(timer); session.dispose(); active--; row.finishedAt = new Date().toISOString(); }
  }
  try {
    // Pair main and shadow by manifest, not filename ordering. This is a limited smoke harness,
    // not the production Alpha dispatcher, online research protocol, or independent review.
    for (let i = 0; i < config.profiles.length; i += 2) {
      const pair = config.profiles.slice(i, i + 2).map((p) => agents.find((a) => a.name === p.name));
      const latch = Promise.withResolvers();
      let arrived = 0, setupFailed = false;
      const ready = async () => {
        if (++arrived === pair.length) latch.resolve();
        await latch.promise;
        assert.equal(setupFailed, false, "Pair startup failed; producer cannot run alone");
      };
      const results = await Promise.allSettled(pair.map((agent) => exercise(agent, ready).catch((error) => {
        setupFailed = true; latch.resolve(); throw error;
      })));
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      if (report.sessions.some((s) => s.status !== "passed")) break;
    }
    report.status = report.sessions.length === 14 && report.sessions.every((s) => s.status === "passed") ? "passed" : "failed";
    report.notRun = config.profiles.filter((p) => !report.sessions.some((s) => s.agent === p.name)).map((p) => p.name);
    report.elapsedMs = Date.now() - started;
    return report;
  } finally { rmSync(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const mode = process.argv[2]; const result = await runSmoke(mode);
    const out = join(ROOT, ".artifacts/pi861-alpha-smoke"); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${mode}.json`), JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "failed") process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify(safeError(error, process.env.PI_ALPHA_TEST_API_KEY))); process.exitCode = 1; }
}
