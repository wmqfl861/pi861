#!/usr/bin/env node
// Pi Alpha bootstrap tooling: validates configuration and simulates protocol transitions.
// This file does NOT launch agents, contact providers, grant permissions, or enforce an OS sandbox.
import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
export const ROOT = resolve(dirname(here), "..");
export const UNBOUND_MODEL = "alpha-unconfigured/awaiting-model-pool";
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const list = (value) => Array.isArray(value) && value.every(nonempty);
const unique = (values) => new Set(values).size === values.length;
const validId = (value) => nonempty(value) && ID.test(value);
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function object(value, label) {
  requireThat(value !== null && typeof value === "object" && !Array.isArray(value), `Invalid ${label}`);
  return value;
}
export function readLocal(root, path) {
  requireThat(nonempty(path) && !isAbsolute(path), "Expected a repository-relative path");
  const base = realpathSync(root), target = resolve(base, path), rel = relative(base, target);
  requireThat(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), "Path escapes repository");
  requireThat(lstatSync(target).isFile(), "Expected a regular file");
  const actual = relative(base, realpathSync(target));
  requireThat(actual && actual !== ".." && !actual.startsWith(`..${sep}`) && !isAbsolute(actual), "Symlink escapes repository");
  requireThat(lstatSync(target).size <= 1024 * 1024, "Bootstrap input exceeds 1 MiB");
  return readFileSync(target, "utf8");
}
export function loadTeam(root = ROOT) {
  return validateTeam(JSON.parse(readLocal(root, ".pi/alpha/team.json")));
}
export function validateTeam(team) {
  object(team, "team");
  requireThat(team.schemaVersion === 1 && team.id === "pi-alpha", "Unsupported Alpha schema or identity");
  requireThat(team.status === "configured-unarmed", "Bootstrap cannot declare a live team");
  const execution = object(team.execution, "execution");
  requireThat(execution.engine === "pi-native" && execution.externalAgentRunnersAllowed === false, "Pi native execution required");
  requireThat(execution.liveEnabled === false && execution.liveDispatcherImplemented === false, "Bootstrap cannot arm a dispatcher");
  requireThat(Number.isSafeInteger(execution.maxModelCallsInFlight) && execution.maxModelCallsInFlight >= 2, "Need at least two call slots");
  requireThat(execution.reserveSlotsPerPair === 2 && Number.isSafeInteger(execution.maxPairsInFlight) &&
    execution.maxPairsInFlight > 0 && execution.maxPairsInFlight * 2 <= execution.maxModelCallsInFlight, "Invalid paired capacity");
  requireThat(execution.sameModelFallbackAllowed === false && execution.recursiveShadows === false, "No same-model fallback or recursive shadows");
  requireThat(team.shadowProtocol?.start === "same-admission-batch" &&
    team.shadowProtocol.initialContext === "fresh" &&
    team.shadowProtocol.producerTranscriptInitiallyShared === false &&
    team.shadowProtocol.internalEvidenceRequired === true, "Independent synchronous shadow protocol required");
  requireThat(team.researchPolicy?.searchCountIsCompletion === false &&
    team.researchPolicy.budgetExhaustionMeans === "blocked" &&
    team.researchPolicy.missingMethodAction === "hypothesis-baseline-experiment", "Research policy cannot degrade to search quotas");
  requireThat(team.separation?.readOtherTeamWorkspace === false && team.separation?.modifyOtherTeam === false &&
    team.separation?.selfDeclareWinner === false, "Other-team isolation required");
  requireThat(Array.isArray(team.roles) && team.roles.length === 7, "Alpha v1 requires seven role pairs");
  const names = [], ids = [];
  for (const role of team.roles) {
    object(role, "role");
    requireThat(/^D[0-6]$/.test(role.id) && validId(role.slug), "Invalid role identity");
    requireThat(role.main === `alpha-${role.slug}` && role.shadow === `${role.main}-shadow`, "Invalid pair identity");
    requireThat(nonempty(role.responsibility) && list(role.deliverables) && role.deliverables.length > 0, "Missing role contract");
    requireThat(list(role.skills) && unique(role.skills) && role.skills.every((s) => validId(s)), "Invalid skills");
    requireThat(role.skills.includes("pi-alpha-core") && role.skills.includes("pi-alpha-evidence") &&
      role.skills.includes("pi-alpha-experiment"), "Missing required shared skills");
    const allowed = ["read", "grep", "find", "ls", "web_search", "fetch_content", "get_search_content", "source_check"];
    requireThat(list(role.bootstrapTools) && unique(role.bootstrapTools) && role.bootstrapTools.includes("read") &&
      role.bootstrapTools.every((t) => allowed.includes(t)), "Bootstrap tools must remain read-only");
    names.push(role.main, role.shadow); ids.push(role.id);
  }
  requireThat(unique(names) && unique(ids), "Duplicate agent or role");
  return team;
}
// This parser checks only our deliberately simple generated scalar format.
// The pinned pi-subagents parser is exercised separately by the host integration check.
export function scalarHeader(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  requireThat(match, "Missing frontmatter");
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^([A-Za-z][A-Za-z0-9]*):(?: +(.*))?$/.exec(line);
    requireThat(item && !Object.hasOwn(result, item[1]), "Invalid or duplicate scalar frontmatter");
    result[item[1]] = item[2] ?? "";
  }
  return result;
}
export function checkFiles(root = ROOT) {
  const team = loadTeam(root), skills = new Set(), profiles = [];
  for (const role of team.roles) {
    for (const side of ["main", "shadow"]) {
      const name = role[side], path = `.pi/agents/alpha/${name}.md`;
      const source = readLocal(root, path), h = scalarHeader(source);
      const wantedSkills = [...role.skills, ...(side === "shadow" ? ["pi-alpha-shadow"] : [])];
      requireThat(h.name === name && h.model === UNBOUND_MODEL, `Unbound model guard changed: ${name}`);
      requireThat(h.defaultContext === "fresh" && h.inheritGlobalContext === "false" &&
        h.inheritSkills === "false" && h.allowNestedSubagents === "false" && h.allowedAgents === "", `Context/fanout policy changed: ${name}`);
      requireThat(h.extensions === "" &&
        h.subagentOnlyExtensions === "../../npm/node_modules/pi-web-access/index.ts", `Missing explicit search provider: ${name}`);
      requireThat(h.tools === role.bootstrapTools.join(", ") && h.skills === wantedSkills.join(", "), `Capability drift: ${name}`);
      requireThat(h.skillPath === "../../skills" && h.acceptanceRole === "read-only", `Invalid bootstrap profile: ${name}`);
      requireThat(!("runner" in h) && !source.includes("runner.type:"), "External runner not allowed");
      for (const skill of wantedSkills) {
        const content = readLocal(root, `.pi/skills/${skill}/SKILL.md`), meta = scalarHeader(content);
        requireThat(meta.name === skill && nonempty(meta.description) && content.length > 400, `Missing substantive skill: ${skill}`);
        skills.add(skill);
      }
      profiles.push({ name, path, skills: wantedSkills, tools: role.bootstrapTools });
    }
  }
  for (const doc of ["CHARTER.md", "RESEARCH.md", "PLAN.md", "SELF_REVIEW.md", "README.md"])
    requireThat(readLocal(root, `docs/pi861/alpha/${doc}`).length > 100, `Missing ${doc}`);
  return { teamId: team.id, version: team.version, status: "configuration-valid", profiles, skillCount: skills.size, liveReady: false };
}
export function validateModelPool(team, pool) {
  validateTeam(team); object(pool, "model pool");
  requireThat(pool.schemaVersion === 1 && Array.isArray(pool.models) && pool.models.length > 0, "Approved model pool required");
  const auth = object(pool.authorization, "authorization");
  requireThat(auth.realModelCalls === true && auth.researchServices === true, "Explicit model and research authorization required");
  requireThat(Number.isSafeInteger(auth.maxRequests) && auth.maxRequests > 0 &&
    Number.isFinite(auth.maxTotalCost) && auth.maxTotalCost > 0 && /^[A-Z]{3}$/.test(auth.currency), "Finite explicit budget required");
  const models = new Map();
  for (const model of pool.models) {
    object(model, "model");
    const fields = ["id", "provider", "model", "canonicalModelId", "capabilities", "qualifiedRoles", "enabled"];
    requireThat(Object.keys(model).every((key) => fields.includes(key)), "Unknown model field; credentials belong to the private host");
    requireThat(validId(model.id) && !models.has(model.id) && nonempty(model.provider) && nonempty(model.model) &&
      nonempty(model.canonicalModelId) && list(model.capabilities) && list(model.qualifiedRoles) &&
      model.enabled === true, "Invalid, disabled, or duplicate model");
    requireThat(!Object.keys(model).some((key) => /secret|token|password|api.?key|credential/i.test(key)), "No credentials in Alpha model metadata");
    models.set(model.id, model);
  }
  object(pool.pairs, "pair bindings");
  for (const role of team.roles) {
    const binding = object(pool.pairs[role.id], `binding for ${role.id}`);
    const main = models.get(binding.main), shadow = models.get(binding.shadow);
    requireThat(main && shadow, `Missing approved models for ${role.id}`);
    requireThat(main.canonicalModelId !== shadow.canonicalModelId &&
      `${main.provider}/${main.model}` !== `${shadow.provider}/${shadow.model}`, `Different actual models required for ${role.id}`);
    for (const [model, side] of [[main, "main"], [shadow, "shadow"]]) {
      requireThat(model.qualifiedRoles.includes(role.id) && ["text", "tools", "research"].every((c) => model.capabilities.includes(c)) &&
        (side !== "shadow" || model.capabilities.includes("review")), `Unqualified ${side} model for ${role.id}`);
    }
  }
  return models;
}
export function preparePair(team, pool, roleId, task) {
  const models = validateModelPool(team, pool), role = team.roles.find((r) => r.id === roleId);
  requireThat(role, "Unknown Alpha role");
  object(task, "task");
  requireThat(validId(task.id) && nonempty(task.requirementVersion) && nonempty(task.objective) &&
    list(task.acceptance) && task.acceptance.length > 0, "A versioned task contract is required");
  const bindings = pool.pairs[roleId];
  return {
    kind: "alpha-pair-proposal", executable: false,
    reason: "Host-enforced budget, filesystem/network isolation, paired launch and event transport are not bound by this bootstrap tool.",
    pairId: `${task.id}-${roleId}`, reserveSlots: 2, launchPolicy: "same-admission-batch",
    children: ["main", "shadow"].map((side) => ({
      agent: role[side], context: "fresh", model: `${models.get(bindings[side]).provider}/${models.get(bindings[side]).model}`,
      canonicalModelId: models.get(bindings[side]).canonicalModelId, phase: side === "shadow" ? "independent-research-preparation" : "producer-research",
      task: { ...structuredClone(task), duty: side === "shadow" ? "Prepare evidence and checks before producer delivery; no duplicate public deliverable." : "Research, produce and submit a versioned candidate." },
      tools: role.bootstrapTools, skills: [...role.skills, ...(side === "shadow" ? ["pi-alpha-shadow"] : [])],
      eventsRequired: ["research-progress", "critical-finding", "shadow-prepared", "candidate-submitted", "review-completed"]
    }))
  };
}
// Metadata sufficiency gate. It cannot prove truth/relevance, actual tool use, or research quality.
export function researchGate(dossier, now = Date.now()) {
  object(dossier, "research dossier");
  requireThat(Number.isFinite(now) && Array.isArray(dossier.questions) && Array.isArray(dossier.evidence), "Invalid research envelope");
  if (dossier.budgetExhausted === true) return { status: "blocked", reasons: ["budget-exhausted"], semanticReviewRequired: true };
  const reasons = [], evidence = new Map();
  for (const e of dossier.evidence) {
    object(e, "evidence");
    requireThat(validId(e.id) && !evidence.has(e.id), "Duplicate or invalid evidence id");
    evidence.set(e.id, e);
  }
  requireThat(dossier.questions.length > 0 && unique(dossier.questions.map((q) => q.id)), "Research questions required and unique");
  let experimentNeeded = false;
  for (const q of dossier.questions) {
    object(q, "question");
    requireThat(validId(q.id) && typeof q.critical === "boolean", "Invalid research question");
    requireThat(typeof q.methodAvailable === "boolean", "Explicit method availability is required");
    if (!q.critical) continue;
    if (!nonempty(q.decision) || !list(q.evidenceIds) || !q.evidenceIds.length) reasons.push(`${q.id}:missing-decision-or-evidence`);
    for (const id of q.evidenceIds ?? []) {
      const e = evidence.get(id);
      if (!e || e.fullTextRead !== true || !nonempty(e.locator) || !nonempty(e.sourceRoot) || !nonempty(e.version)) {
        reasons.push(`${q.id}:unread-or-unversioned-evidence`); continue;
      }
      const checked = Date.parse(e.checkedAt), expires = Date.parse(e.expiresAt);
      if (!Number.isFinite(checked) || !Number.isFinite(expires) || checked > now || expires < now || expires < checked)
        reasons.push(`${q.id}:stale-or-invalid-evidence-time`);
    }
    if (q.alternativesCompared !== true || q.counterevidenceChecked !== true || q.applicabilityChecked !== true)
      reasons.push(`${q.id}:missing-alternatives-counterevidence-or-applicability`);
    if (!Array.isArray(q.unresolved) || q.unresolved.length) reasons.push(`${q.id}:unresolved`);
    if (q.methodAvailable === false && (q.experiment?.status !== "passed" || !nonempty(q.experiment?.artifactRef))) {
      experimentNeeded = true; reasons.push(`${q.id}:experiment-required`);
    }
  }
  requireThat(dossier.questions.some((q) => q.critical), "At least one critical question required");
  return { status: reasons.length ? (experimentNeeded ? "needs-experiment" : "needs-research") : "eligible-for-independent-review",
    reasons, independentSourceRoots: new Set([...evidence.values()].map((e) => e.sourceRoot).filter(nonempty)).size,
    semanticReviewRequired: true };
}
export function newPairState(pairId, requirementVersion, mainId, shadowId) {
  requireThat(nonempty(pairId) && nonempty(requirementVersion) && nonempty(mainId) && nonempty(shadowId) && mainId !== shadowId, "Invalid pair state");
  return { pairId, requirementVersion, mainId, shadowId, phase: "queued", sequence: 0, prepared: null, candidate: null, review: null };
}
// Pure protocol simulation, NOT a production admission controller. Host-authenticated actors and
// trustworthy timestamps/receipts must be supplied by the future runtime adapter, never by a model.
export function advancePair(state, event) {
  object(state, "pair state"); object(event, "event");
  requireThat(!["accepted", "blocked", "cancelled"].includes(state.phase), "Terminal pair requires a new attempt");
  requireThat(event.requirementVersion === state.requirementVersion, "Stale requirement version");
  const next = structuredClone(state); next.sequence++;
  if (event.type === "start-pair") {
    requireThat(state.phase === "queued" && Number.isSafeInteger(event.availableSlots) && event.availableSlots >= 2, "Pair requires two reserved slots");
    requireThat(nonempty(event.mainModel) && nonempty(event.shadowModel) && event.mainModel !== event.shadowModel, "Different actual models required");
    next.phase = "researching"; next.started = { main: next.sequence, shadow: next.sequence };
  } else if (event.type === "shadow-prepared") {
    requireThat(state.phase === "researching" && event.actor === state.shadowId && list(event.evidenceRefs) &&
      event.evidenceRefs.length > 0 && list(event.checks) && event.checks.length > 0, "Shadow preparation evidence required");
    next.prepared = { sequence: next.sequence, evidenceRefs: event.evidenceRefs, checks: event.checks };
  } else if (event.type === "candidate-submitted") {
    requireThat(state.phase === "researching" && state.prepared && event.actor === state.mainId &&
      /^[a-f0-9]{64}$/.test(event.artifactHash), "Candidate needs prior independent shadow preparation");
    next.phase = "reviewing"; next.candidate = { hash: event.artifactHash, sequence: next.sequence };
  } else if (event.type === "review-completed") {
    requireThat(state.phase === "reviewing" && event.actor === state.shadowId &&
      event.artifactHash === state.candidate.hash && ["pass", "changes", "blocked"].includes(event.verdict) &&
      list(event.evidenceRefs) && event.evidenceRefs.length > 0, "Review must bind the actual candidate and independent actor");
    requireThat(event.coauthored === false, "Coauthored candidate needs a fresh independent reviewer");
    next.review = { verdict: event.verdict, evidenceRefs: event.evidenceRefs };
    next.phase = event.verdict === "pass" ? "accepted" : event.verdict === "blocked" ? "blocked" : "researching";
    if (event.verdict === "changes") next.candidate = null;
  } else if (event.type === "requirements-changed") {
    requireThat(nonempty(event.newVersion) && event.newVersion !== state.requirementVersion && state.phase !== "queued", "New requirement version required");
    next.requirementVersion = event.newVersion; next.prepared = null; next.candidate = null; next.review = null; next.phase = "researching";
  } else if (["budget-exhausted", "cancel"].includes(event.type)) {
    next.phase = event.type === "cancel" ? "cancelled" : "blocked";
    next.reason = event.type;
  } else throw new Error("Unknown pair event");
  return next;
}
export function simulate() {
  let state = newPairState("demo", "v1", "producer", "shadow");
  const trace = [];
  for (const event of [
    { type: "start-pair", availableSlots: 2, mainModel: "fixture-a", shadowModel: "fixture-b" },
    { type: "shadow-prepared", actor: "shadow", evidenceRefs: ["fixture:source"], checks: ["fixture:check"] },
    { type: "candidate-submitted", actor: "producer", artifactHash: "a".repeat(64) },
    { type: "review-completed", actor: "shadow", artifactHash: "a".repeat(64), verdict: "pass", coauthored: false, evidenceRefs: ["fixture:inspection"] }
  ]) { state = advancePair(state, { ...event, requirementVersion: "v1" }); trace.push({ event: event.type, phase: state.phase }); }
  return { simulation: true, realAgentsStarted: 0, providerRequests: 0, trace, finalState: state };
}
export function main(args) {
  const [command = "help", ...rest] = args;
  if (command === "help" || command === "--help") {
    console.log("Pi Alpha: check | status | simulate | prepare <D0..D6> <task.json> <models.local.json>\nLocal bootstrap only; prepare outputs a non-executable proposal. No live agents, secrets, network, or background work.");
    return;
  }
  if (["check", "status", "simulate"].includes(command)) {
    requireThat(rest.length === 0, "Unexpected arguments");
    if (command === "simulate") console.log(JSON.stringify(simulate(), null, 2));
    else {
      const report = checkFiles();
      console.log(JSON.stringify(command === "check" ? report : {
        teamId: report.teamId, version: report.version, configuredAgents: report.profiles.length, skills: report.skillCount,
        bootstrap: "configuration-valid", liveReady: false, realAgentsStarted: 0,
        blockers: ["model-pool-and-authorization-not-bound", "host-isolation-budget-and-paired-live-dispatch-not-bound", "independent-real-model-pilot-not-run"]
      }, null, 2));
    }
    return;
  }
  if (command === "prepare") {
    requireThat(rest.length === 3, "prepare requires role, task file, model metadata file (all paths repository-relative)");
    console.log(JSON.stringify(preparePair(loadTeam(), JSON.parse(readLocal(ROOT, rest[2])), rest[0],
      JSON.parse(readLocal(ROOT, rest[1]))), null, 2)); return;
  }
  throw new Error(`Unknown Alpha command: ${command}`);
}
if (process.argv[1] && resolve(process.argv[1]) === here) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
