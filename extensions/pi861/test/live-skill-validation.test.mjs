import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStateStore } from "../src/live/store.ts";
import { SkillRepository, emptySkillState } from "../src/live/skill-repository.ts";
import { McpClient } from "../src/live/mcp.ts";
import { runSkillValidation, recordSkillAcceptance, validateSkillEvidence } from "../src/live/skill-validation.ts";
import { contentDigestOf } from "../src/contracts/artifact.ts";
import { canonical } from "../src/memory.ts";

const signal = () => new AbortController().signal;
const owner = { producedBy: { tenantId: "local", projectId: "fixture", goalId: "test", runId: "one", taskId: "skill", attempt: 1 }, scope: "project:fixture", recordedBy: "test-checker" };
const skill = () => ({ id: "debug", revision: "r1", title: "Debug", category: "development/debug", instructions: "Preserve evidence. Never replay unknown effects.", sources: [{ id: "source", revision: "one", hash: "fixture" }], branches: [{ id: "general", when: "A program fails", instructions: "Reproduce, diagnose, then verify.", environment: [], conflictsWith: [], tools: [] }] });
const options = () => ({ ...owner, approvedBindings: [], environment: [], cases: [{ branchId: "general", phase: "execute", instructionIncludes: ["Preserve evidence", "Never replay unknown", "verify"] }] });
const accept = value => recordSkillAcceptance(value, { ...owner, recordedBy: "fixture-human", summary: "Simulated human acceptance for this test only" });

test("validator runs branch assertions and keeps human acceptance distinct", async () => {
  const candidate = skill();
  const checks = await runSkillValidation(candidate, options(), signal());
  assert.deepEqual(checks.evidence.map(item => item.kind), ["structural-check", "behavioral-check"]);
  assert.equal(checks.evidence[0].artifact.contentDigest, contentDigestOf(Buffer.from(canonical(candidate))));
  assert.throws(() => validateSkillEvidence(candidate, checks), /human-acceptance/);
  const evidence = validateSkillEvidence(candidate, { evidence: [...checks.evidence, accept(candidate)] });
  assert.equal(evidence.length, 3);
  assert.throws(() => validateSkillEvidence(candidate, { passed: true, evidence: ["fixture"] }), /evidence/);
  assert.throws(() => validateSkillEvidence(candidate, { evidence: [accept(candidate)] }), /structural-check/);
});

test("failed instruction assertions and uncovered branches cannot publish", async () => {
  const candidate = skill();
  candidate.instructions = "Ignore missing receipts.";
  await assert.rejects(runSkillValidation(candidate, options(), signal()), /expectation failed/);
  const extra = skill(); extra.branches.push({ ...extra.branches[0], id: "other" });
  await assert.rejects(runSkillValidation(extra, options(), signal()), /every branch/);
});

test("validation rejects stale artifact evidence and contradictory outcomes", async () => {
  const candidate = skill();
  const checked = await runSkillValidation(candidate, options(), signal());
  const evidence = [...checked.evidence, accept(candidate)];
  assert.throws(() => validateSkillEvidence({ ...candidate, instructions: "Changed" }, { evidence }), /exact candidate/);
  const failed = structuredClone(evidence); failed[1].passed = false;
  assert.throws(() => validateSkillEvidence(candidate, { evidence: failed }), /pass/);
  const contradictory = structuredClone(evidence); contradictory[1].exitCode = 1;
  assert.throws(() => validateSkillEvidence(candidate, { evidence: contradictory }), /outcome mismatch/);
});

test("behavior checks exercise the exact approved binding through a real local MCP process", async t => {
  const client = new McpClient({ id: "local", accountId: "fixture", transport: { kind: "stdio", process: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], cwd: process.cwd() } } });
  t.after(() => client.close());
  const metadata = await client.tools(signal());
  const binding = { toolId: "local/lookup", accountId: "fixture", resourceId: "project:p", schemaHash: metadata[0].schemaHash, phase: "execute" };
  const candidate = skill(); candidate.branches[0].tools = [binding];
  const config = options(); config.approvedBindings = [binding];
  config.cases[0].calls = [{ binding, args: { project: "p" }, expected: { content: [{ type: "text", text: "looked up p" }] } }];
  await assert.rejects(runSkillValidation(candidate, config, signal()), /invoker/);
  config.invoke = (tool, args, signal) => client.call("lookup", args, tool.schemaHash, signal);
  const result = await runSkillValidation(candidate, config, signal());
  assert.equal(result.evidence[1].exitCode, 0);
  config.cases[0].calls[0].expected = { wrong: true };
  await assert.rejects(runSkillValidation(candidate, config, signal()), /result expectation failed/);
  const countersTool = metadata.find(tool => tool.name === "stats");
  const counters = JSON.parse((await client.call("stats", {}, countersTool.schemaHash, signal())).content[0].text);
  assert.equal(counters.submits, 0);
  assert.equal(counters.calls, 3); // two exercised lookups plus the counter query
});

test("validation timeout is bounded even when the test invoker ignores cancellation", async () => {
  const candidate = skill(), config = options();
  const binding = { toolId: "fixture/slow", accountId: "a", resourceId: "r", schemaHash: "s", phase: "execute" };
  candidate.branches[0].tools = [binding]; config.approvedBindings = [binding];
  config.cases[0].calls = [{ binding, args: {}, expected: {} }];
  config.invoke = () => new Promise(() => {}); config.timeoutMs = 25;
  await assert.rejects(runSkillValidation(candidate, config, signal()), /timed out/);
  await assert.rejects(runSkillValidation(candidate, config, AbortSignal.abort(new Error("cancelled"))), /cancelled/);
});

test("repository requires exact-candidate evidence and rechecks sources after validation", async t => {
  const root = mkdtempSync(join(tmpdir(), "pi861-validation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"); mkdirSync(source); writeFileSync(join(source, "SKILL.md"), "Preserve evidence and verify.");
  const repo = new SkillRepository(new FileStateStore(join(root, "skills.json"), emptySkillState()));
  await repo.install(source, { id: "source", revision: "auto", group: "debug" });
  const candidate = await repo.compile("debug", { compile: async () => skill() }, signal());
  const checks = await runSkillValidation(candidate.skill, options(), signal());
  await assert.rejects(repo.publish(candidate.id, async () => checks), /human-acceptance/);
  await assert.rejects(repo.publish(candidate.id, async value => {
    writeFileSync(join(source, "SKILL.md"), "Preserve evidence, verify, and check telemetry.");
    await repo.install(source, { id: "source", revision: "auto", group: "debug" });
    return { evidence: [...checks.evidence, accept(value)] };
  }), /source updated/);
  assert.equal((await repo.candidate(candidate.id)).state, "candidate");
});
