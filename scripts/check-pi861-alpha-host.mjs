#!/usr/bin/env node
// Uses the pinned, installed Pi host and pi-subagents implementation. No LLM or web request.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadExtensions } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { discoverAgents, clearAgentDiscoveryCache } from "../.pi/npm/node_modules/pi-subagents/src/agents/agents.js";
import { resolveSkills, clearSkillCache } from "../.pi/npm/node_modules/pi-subagents/src/agents/skills.js";
import { ROOT, checkFiles, UNBOUND_MODEL } from "./pi861-alpha.mjs";

const directory = mkdtempSync(join(tmpdir(), "pi-alpha-host-"));
process.env.HOME = directory; process.env.USERPROFILE = directory;
process.env.PI_CODING_AGENT_DIR = join(directory, ".pi/agent");
process.env.XDG_CONFIG_HOME = join(directory, ".config"); process.env.XDG_CACHE_HOME = join(directory, ".cache");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
let loaded;
try {
  const report = checkFiles(), names = report.profiles.map((p) => p.name);
  for (const [name, version] of [["pi-subagents", "0.74.0"], ["pi-web-access", "0.35.0"]]) {
    const metadata = JSON.parse(readFileSync(join(ROOT, ".pi/npm/node_modules", name, "package.json"), "utf8"));
    assert.equal(metadata.version, version, `Unsupported ${name} version`);
  }
  clearAgentDiscoveryCache(); clearSkillCache();
  const discovery = discoverAgents(ROOT, "project", undefined, { globalNpmRoot: null });
  const diagnostics = (discovery.agentDiagnostics ?? []).filter((d) => names.includes(d.name) || names.includes(d.runtimeName));
  assert.deepEqual(diagnostics, [], JSON.stringify(diagnostics));
  const agents = discovery.agents.filter((a) => names.includes(a.name));
  assert.deepEqual(agents.map((a) => a.name).sort(), [...names].sort());
  const providerPaths = new Set(), resolution = [];
  for (const agent of agents) {
    assert.equal(agent.source, "project"); assert.equal(agent.model, UNBOUND_MODEL);
    assert.equal(agent.defaultContext, "fresh"); assert.equal(agent.inheritGlobalContext, false);
    assert.equal(agent.inheritSkills, false); assert.equal(agent.allowNestedSubagents, false);
    assert.deepEqual(agent.allowedAgents, []); assert.deepEqual(agent.extensions, []);
    assert.equal(agent.runner, undefined, "Native Pi, not an external CLI agent");
    const expected = report.profiles.find((p) => p.name === agent.name);
    assert.deepEqual(agent.tools, expected.tools);
    assert.deepEqual(agent.skills, expected.skills);
    const skills = resolveSkills(agent.skills, ROOT, agent.skillPath, dirname(agent.filePath));
    assert.deepEqual(skills.missing, [], `Missing actual skills for ${agent.name}`);
    assert.equal(skills.resolved.length, expected.skills.length);
    assert.equal(agent.subagentOnlyExtensions.length, 1);
    for (const path of agent.subagentOnlyExtensions) {
      const absolute = resolve(dirname(agent.filePath), path);
      assert.ok(existsSync(absolute), `Missing child provider ${path}`); providerPaths.add(absolute);
    }
    resolution.push({ name: agent.name, source: agent.source, model: agent.model, tools: agent.tools, skills: skills.resolved.map((s) => s.name) });
  }
  assert.equal(providerPaths.size, 1);
  // Load the exact child provider registered in all fourteen profiles. Tool existence, not service availability.
  loaded = await loadExtensions([...providerPaths], directory);
  assert.deepEqual(loaded.errors, [], JSON.stringify(loaded.errors));
  assert.equal(loaded.extensions.length, 1);
  const tools = loaded.extensions.flatMap((e) => [...e.tools.keys()]);
  for (const name of ["web_search", "fetch_content", "get_search_content", "source_check"]) assert.ok(tools.includes(name), `Missing registered tool ${name}`);
  const missing = resolveSkills(["pi-alpha-intentionally-missing"], ROOT);
  assert.deepEqual(missing.missing, ["pi-alpha-intentionally-missing"]);
  console.log(JSON.stringify({ status: "passed", nativeProfiles: resolution.length, registeredProviderTools: tools,
    skills: report.skillCount, resolution, liveAgentsStarted: 0, realProviderRequests: 0,
    limitation: "Discovery/skill resolution/extension factory checks only; not actual paired LLM execution or network authorization." }, null, 2));
} finally {
  loaded?.runtime.invalidate("Alpha host verification finished");
  clearAgentDiscoveryCache(); clearSkillCache();
  rmSync(directory, { recursive: true, force: true });
}
