import assert from "node:assert/strict";
import { cpSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  ROOT, loadTeam, validateTeam, checkFiles, readLocal, validateModelPool,
  preparePair, researchGate, newPairState, advancePair, simulate, scalarHeader
} from "./pi861-alpha.mjs";

const team = loadTeam();
function pool() {
  return { schemaVersion: 1,
    models: ["a", "b"].map((id) => ({ id, provider: "fixture", model: id, canonicalModelId: `test-only-${id}`,
      capabilities: ["text", "tools", "research", "review"], qualifiedRoles: team.roles.map((r) => r.id), enabled: true })),
    pairs: Object.fromEntries(team.roles.map((r) => [r.id, { main: "a", shadow: "b" }])),
    authorization: { realModelCalls: true, researchServices: true, maxRequests: 10, maxTotalCost: 1, currency: "USD" } };
}
function dossier() {
  return { budgetExhausted: false, questions: [{ id: "q1", critical: true, decision: "Choose compatible method",
    evidenceIds: ["e1"], alternativesCompared: true, counterevidenceChecked: true, applicabilityChecked: true,
    unresolved: [], methodAvailable: true }],
    evidence: [{ id: "e1", locator: "fixture://source#section", sourceRoot: "primary-one", fullTextRead: true, version: "test-v1",
      checkedAt: "2026-10-05T00:00:00Z", expiresAt: "2026-10-07T00:00:00Z" }] };
}
const now = Date.parse("2026-10-06T00:00:00Z");
const initial = () => newPairState("task-D2", "v1", "maker", "auditor");
const event = (type, rest = {}) => ({ type, requirementVersion: "v1", ...rest });
const start = () => advancePair(initial(), event("start-pair", { availableSlots: 2, mainModel: "a", shadowModel: "b" }));
const prepared = () => advancePair(start(), event("shadow-prepared", { actor: "auditor", evidenceRefs: ["source-v1"], checks: ["negative-case"] }));
const candidate = () => advancePair(prepared(), event("candidate-submitted", { actor: "maker", artifactHash: "a".repeat(64) }));
const review = (rest = {}) => event("review-completed", { actor: "auditor", artifactHash: "a".repeat(64),
  verdict: "pass", evidenceRefs: ["check-result-v1"], coauthored: false, ...rest });

test("14 paired profiles and 11 substantive skills exist; configuration is not live readiness", () => {
  const report = checkFiles();
  assert.equal(report.profiles.length, 14);
  assert.equal(report.skillCount, 11);
  assert.equal(report.liveReady, false);
  assert.equal(report.status, "configuration-valid");
  assert.equal(new Set(report.profiles.map((p) => p.name)).size, 14);
});
test("pair names cannot collide", () => {
  const t = structuredClone(team); t.roles[1] = t.roles[0];
  assert.throws(() => validateTeam(t), /Duplicate/);
});
test("bootstrap cannot be armed by setting a flag", () => {
  const t = structuredClone(team); t.execution.liveEnabled = true;
  assert.throws(() => validateTeam(t), /arm/);
});
test("read-only bootstrap refuses shell and mutation tools", () => {
  const t = structuredClone(team); t.roles[0].bootstrapTools.push("bash");
  assert.throws(() => validateTeam(t), /read-only/);
});
test("external agent execution and recursive shadows remain disabled", () => {
  for (const key of ["externalAgentRunnersAllowed", "recursiveShadows"]) {
    const t = structuredClone(team); t.execution[key] = true;
    assert.throws(() => validateTeam(t));
  }
});
test("pair budget cannot allocate producer-only capacity", () => {
  const t = structuredClone(team); t.execution.maxModelCallsInFlight = 1;
  assert.throws(() => validateTeam(t), /two call slots/);
});
test("task data cannot rename the team to dsh or grant cross-team access", () => {
  const t = structuredClone(team); t.separation.modifyOtherTeam = true;
  assert.throws(() => validateTeam(t), /isolation/);
  assert.throws(() => validateTeam({ ...team, id: "dsh" }), /identity/);
});
test("missing model pool does not inherit a parent model", () => {
  assert.throws(() => validateModelPool(team, { schemaVersion: 1, models: [] }), /model pool/);
});
test("same actual model using different aliases is rejected", () => {
  const p = pool(); p.models[1].canonicalModelId = p.models[0].canonicalModelId;
  assert.throws(() => validateModelPool(team, p), /Different actual/);
});
test("same provider/model cannot bypass identity with fabricated canonical ids", () => {
  const p = pool(); p.models[1].model = "a";
  assert.throws(() => validateModelPool(team, p), /Different actual/);
});
test("unqualified shadow and missing tools/research capability fail before proposals", () => {
  const p = pool(); p.models[1].capabilities = ["text", "tools", "research"];
  assert.throws(() => validateModelPool(team, p), /Unqualified shadow/);
  p.models[1].capabilities.push("review"); p.models[1].qualifiedRoles = [];
  assert.throws(() => validateModelPool(team, p), /Unqualified/);
});
test("authorization and finite budgets are mandatory", () => {
  for (const patch of [{ realModelCalls: false }, { researchServices: false }, { maxRequests: 0 },
    { maxRequests: 1.5 }, { maxTotalCost: Infinity }, { maxTotalCost: null }]) {
    const p = pool(); Object.assign(p.authorization, patch);
    assert.throws(() => validateModelPool(team, p));
  }
});
test("credential fields cannot be included in metadata", () => {
  const p = pool(); p.models[0].apiKey = "fixture-not-a-secret";
  assert.throws(() => validateModelPool(team, p), /credentials/);
});
test("valid qualified pair produces fresh parallel proposals, never starts providers", () => {
  const result = preparePair(team, pool(), "D2", { id: "research-task", objective: "fixture", requirementVersion: "v1", acceptance: ["evidence"] });
  assert.equal(result.executable, false);
  assert.equal(result.reserveSlots, 2);
  assert.equal(result.launchPolicy, "same-admission-batch");
  assert.equal(result.children[0].context, "fresh");
  assert.equal(result.children[1].phase, "independent-research-preparation");
  assert.notEqual(result.children[0].model, result.children[1].model);
  assert.ok(result.children[1].skills.includes("pi-alpha-shadow"));
});
test("unknown roles and unversioned tasks cannot generate a proposal", () => {
  assert.throws(() => preparePair(team, pool(), "D9", {}), /Unknown/);
  assert.throws(() => preparePair(team, pool(), "D2", { id: "task", objective: "x", acceptance: [] }), /contract/);
});
test("source snippets cannot satisfy full-text evidence requirements", () => {
  const d = dossier(); d.evidence[0].fullTextRead = false;
  assert.equal(researchGate(d, now).status, "needs-research");
});
test("outdated and future-checked evidence cannot pass", () => {
  const d = dossier(); d.evidence[0].expiresAt = "2026-10-04T00:00:00Z";
  assert.equal(researchGate(d, now).status, "needs-research");
  d.evidence[0].expiresAt = "2026-10-09T00:00:00Z"; d.evidence[0].checkedAt = "2026-10-08T00:00:00Z";
  assert.equal(researchGate(d, now).status, "needs-research");
});
test("republished sources do not increase independent evidence count", () => {
  const d = dossier(); d.evidence.push({ ...d.evidence[0], id: "e2", locator: "fixture://reprint" });
  d.questions[0].evidenceIds.push("e2");
  assert.equal(researchGate(d, now).independentSourceRoots, 1);
});
test("no usable method enters experimentation rather than ending at a search summary", () => {
  const d = dossier(); d.questions[0].methodAvailable = false;
  assert.equal(researchGate(d, now).status, "needs-experiment");
});
test("complete metadata is only eligible for independent semantic review", () => {
  const result = researchGate(dossier(), now);
  assert.equal(result.status, "eligible-for-independent-review");
  assert.equal(result.semanticReviewRequired, true);
});
test("counterevidence, alternative routes and applicability cannot be omitted", () => {
  for (const field of ["counterevidenceChecked", "alternativesCompared", "applicabilityChecked"]) {
    const d = dossier(); d.questions[0][field] = false;
    assert.equal(researchGate(d, now).status, "needs-research");
  }
});
test("budget exhaustion is blocked, never a research pass", () => {
  assert.equal(researchGate({ ...dossier(), budgetExhausted: true }, now).status, "blocked");
});
test("empty and malformed questions cannot pass vacuously", () => {
  assert.throws(() => researchGate({ ...dossier(), questions: [] }, now), /questions/);
  const d = dossier(); d.questions[0].critical = false;
  assert.throws(() => researchGate(d, now), /critical/);
});
test("start is a pair event with equal admission sequence, no waiting for producer delivery", () => {
  const s = start(); assert.equal(s.started.main, s.started.shadow);
  assert.equal(s.phase, "researching");
});
test("producer cannot start alone or submit without prior shadow preparation", () => {
  assert.throws(() => advancePair(initial(), event("start-pair", { availableSlots: 1, mainModel: "a", shadowModel: "b" })), /two reserved/);
  assert.throws(() => advancePair(start(), event("candidate-submitted", { actor: "maker", artifactHash: "a".repeat(64) })), /prior/);
});
test("a same-model pair cannot start", () => {
  assert.throws(() => advancePair(initial(), event("start-pair", { availableSlots: 2, mainModel: "a", shadowModel: "a" })), /Different/);
});
test("shadow preparation requires the right actor and evidence", () => {
  for (const change of [{ actor: "maker" }, { evidenceRefs: [] }, { checks: [] }])
    assert.throws(() => advancePair(start(), event("shadow-prepared", { actor: "auditor", evidenceRefs: ["source"], checks: ["check"], ...change })), /preparation/);
});
test("review cannot be accepted for the wrong artifact or by its producer", () => {
  assert.throws(() => advancePair(candidate(), review({ artifactHash: "b".repeat(64) })), /actual candidate/);
  assert.throws(() => advancePair(candidate(), review({ actor: "maker" })), /independent actor/);
});
test("coauthor cannot call their review independent", () => {
  assert.throws(() => advancePair(candidate(), review({ coauthored: true })), /fresh independent/);
});
test("requirement changes invalidate prior preparation and stale review events", () => {
  const s = advancePair(candidate(), event("requirements-changed", { newVersion: "v2" }));
  assert.equal(s.prepared, null); assert.equal(s.candidate, null);
  assert.throws(() => advancePair(s, review()), /Stale/);
});
test("revision is requested without accepting the candidate; budget exhausted cannot pass", () => {
  const s = advancePair(candidate(), review({ verdict: "changes" }));
  assert.equal(s.phase, "researching"); assert.equal(s.candidate, null);
  const exhausted = advancePair(s, event("budget-exhausted"));
  assert.equal(exhausted.phase, "blocked");
  assert.throws(() => advancePair(exhausted, review()), /Terminal/);
});
test("simulator advertises zero real agents and zero provider requests", () => {
  const result = simulate();
  assert.equal(result.simulation, true); assert.equal(result.realAgentsStarted, 0);
  assert.equal(result.providerRequests, 0); assert.equal(result.finalState.phase, "accepted");
});
test("unknown protocol events and duplicate frontmatter fail closed", () => {
  assert.throws(() => advancePair(start(), event("grant-admin")), /Unknown/);
  assert.throws(() => scalarHeader("---\nname: a\nname: b\n---\n"), /duplicate/);
});
test("repository input path traversal and symlink escapes are rejected", (t) => {
  const base = mkdtempSync(join(tmpdir(), "alpha-path-test-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const workspace = join(base, "repo"); mkdirSync(workspace);
  writeFileSync(join(base, "outside.txt"), "fixture"); writeFileSync(join(workspace, "inside.txt"), "ok");
  assert.equal(readLocal(workspace, "inside.txt"), "ok");
  assert.throws(() => readLocal(workspace, "../outside.txt"), /escapes/);
  symlinkSync(join(base, "outside.txt"), join(workspace, "link.txt"));
  assert.throws(() => readLocal(workspace, "link.txt"), /regular|escapes/);
});
test("status is honest and unknown CLI commands cannot launch anything", () => {
  const cli = join(ROOT, "scripts/pi861-alpha.mjs");
  const status = spawnSync(process.execPath, [cli, "status"], { encoding: "utf8", timeout: 10000 });
  assert.equal(status.status, 0, status.stderr);
  const data = JSON.parse(status.stdout); assert.equal(data.liveReady, false); assert.equal(data.realAgentsStarted, 0);
  const launch = spawnSync(process.execPath, [cli, "launch"], { encoding: "utf8", timeout: 10000 });
  assert.equal(launch.status, 1); assert.match(launch.stderr, /Unknown/);
});

test("undefined model identity is not implicitly converted to a valid string", () => {
  const p = pool(); delete p.models[0].id;
  assert.throws(() => validateModelPool(team, p), /Invalid/);
});
test("unknown nested metadata cannot smuggle credentials or launch settings", () => {
  const p = pool(); p.models[0].transport = { headers: { Authorization: "fixture" } };
  assert.throws(() => validateModelPool(team, p), /Unknown model field/);
});
test("unspecified method availability cannot count as sufficient research", () => {
  const d = dossier(); delete d.questions[0].methodAvailable;
  assert.throws(() => researchGate(d, now), /method availability/);
});
test("missing evidence references remain unresolved even with positive booleans", () => {
  const d = dossier(); d.questions[0].evidenceIds = ["not-present"];
  assert.equal(researchGate(d, now).status, "needs-research");
});
test("an experiment cannot pass without an actual artifact reference", () => {
  const d = dossier(); d.questions[0].methodAvailable = false; d.questions[0].experiment = { status: "passed" };
  assert.equal(researchGate(d, now).status, "needs-experiment");
});
test("cancelled pair cannot later be marked accepted", () => {
  const s = advancePair(candidate(), event("cancel"));
  assert.equal(s.phase, "cancelled");
  assert.throws(() => advancePair(s, review()), /Terminal/);
});

function teamCopy(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-alpha-assets-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  for (const path of [".pi/alpha", ".pi/agents/alpha", "docs/pi861/alpha",
    ...new Set(checkFiles().profiles.flatMap((p) => p.skills).map((s) => `.pi/skills/${s}`))])
    cpSync(join(ROOT, path), join(dir, path), { recursive: true });
  return dir;
}
test("missing selected skill is an error, not just a plugin warning", (t) => {
  const dir = teamCopy(t);
  rmSync(join(dir, ".pi/skills/pi-alpha-shadow/SKILL.md"));
  assert.throws(() => checkFiles(dir), /ENOENT/);
});
test("a role cannot inherit the parent model or lose its search provider", (t) => {
  const dir = teamCopy(t), file = join(dir, ".pi/agents/alpha/alpha-coordinator.md");
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace("model: alpha-unconfigured/awaiting-model-pool", "model: inherit"));
  assert.throws(() => checkFiles(dir), /model guard/);
  writeFileSync(file, text.replace("subagentOnlyExtensions: ../../npm/node_modules/pi-web-access/index.ts", "subagentOnlyExtensions:"));
  assert.throws(() => checkFiles(dir), /search provider/);
});
