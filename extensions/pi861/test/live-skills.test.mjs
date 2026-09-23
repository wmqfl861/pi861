import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TaskTreeBudget } from "../src/contracts/budget.ts";
import { IdentityAuthority } from "../src/contracts/identity.ts";
import { AuxiliaryModelInvocations } from "../src/live/auxiliary-models.ts";
import { FileStateStore } from "../src/live/store.ts";
import { SkillRepository, emptySkillState } from "../src/live/skill-repository.ts";
import { McpClient } from "../src/live/mcp.ts";
import { auxiliaryCompiler, auxiliaryGrouping } from "../src/live/skill-services.ts";
import { installCapabilities } from "../src/live/skills-host.ts";
import { digest } from "../src/memory.ts";
import { runSkillValidation, recordSkillAcceptance } from "../src/live/skill-validation.ts";
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi861-skill-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source"); mkdirSync(source); writeFileSync(join(source, "SKILL.md"), "---\nname: debug\ndescription: NEVER_AUTO_EXPOSE_ORIGINAL\n---\nRead the error. Preserve evidence. Validate the fix.");
  return { directory, source, repo: new SkillRepository(new FileStateStore(join(directory, "skills.json"), emptySkillState())) };
}
const signal = () => new AbortController().signal;
const fixturePath = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const fixtureClient = (t, env = {}, server = {}) => {
  const client = new McpClient({ id: server.id ?? "local", accountId: server.accountId ?? "a", transport: { kind: "stdio", process: { command: process.execPath, args: [fixturePath], cwd: process.cwd(), env } } });
  t.after(() => client.close());
  return client;
};
/** In-memory Pi host stub: registered tools and event handlers in plain maps. */
function harness(t, options) {
  const handlers = new Map(), tools = new Map(); let active = [];
  const host = { getActiveTools: () => active, setActiveTools: value => { active = value; },
    registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn), appendEntry: () => {} };
  const capabilities = installCapabilities(host, options);
  t.after(() => capabilities.close());
  return { handlers, tools, activeNames: () => active.filter(name => name.startsWith("pi861_mcp_")), capabilities };
}
const activateSkill = (h, skillId, revision, branches, phase) =>
  h.tools.get("pi861_capabilities").execute("act", { action: "activate", skillId, revision, branches, phase });
const staticCompiler = skill => ({ async compile() { return structuredClone(skill); } });
const owner = { producedBy: { tenantId: "local", projectId: "fixture", goalId: "validation", runId: "one", taskId: "skill", attempt: 1 }, scope: "project:fixture", recordedBy: "fixture-checker" };
// These expectations apply only to the deterministic local fixture, not arbitrary MCP servers.
async function publish(repo, candidate, clients = []) {
  return repo.publish(candidate.id, async skill => {
    let submits = 0;
    const cases = skill.branches.flatMap(branch => {
      const phases = [...new Set(branch.tools.map(binding => binding.phase))];
      return (phases.length ? phases : ["execute"]).map(phase => ({ branchId: branch.id, phase,
        instructionIncludes: ["Preserve evidence"], calls: branch.tools.filter(binding => binding.phase === phase).map(binding => {
          const project = binding.resourceId.replace("project:", "");
          const client = clients.find(client => binding.toolId.startsWith(`${client.server.id}/`) && client.server.accountId === binding.accountId);
          assert.ok(client, "bound fixture publication needs a real local client");
          const account = client.server.transport.process.env?.MCP_ACCOUNT;
          const text = binding.toolId.endsWith("/submit") ? `submitted change ${++submits}` : `looked up ${project}${account ? ` via account ${account}` : ""}`;
          return { binding, args: { project }, expected: { content: [{ type: "text", text }] } };
        }) }));
    });
    const result = await runSkillValidation(skill, { ...owner, approvedBindings: candidate.approvedBindings,
      environment: ["browser"], cases, invoke: (binding, args, signal) => {
        const client = clients.find(client => binding.toolId.startsWith(`${client.server.id}/`) && client.server.accountId === binding.accountId);
        return client.call(binding.toolId.slice(client.server.id.length + 1), args, binding.schemaHash, signal);
      } }, signal());
    return { evidence: [...result.evidence, recordSkillAcceptance(skill, { ...owner, recordedBy: "fixture-human", summary: "Simulated human acceptance in deterministic test" })] };
  });
}
const bindingName = (h, binding, skillId) => {
  const entry = [...h.tools.values()].find(tool => h.activeNames().includes(tool.name) && tool.description.includes(binding.resourceId) && tool.description.includes(binding.toolId) && (!skillId || tool.description.includes(`Skill: ${skillId}@`)));
  assert.ok(entry, `active tool not found for ${binding.toolId}/${binding.accountId}/${skillId ?? ""}`);
  return entry.name;
};
const compiler = { async compile(input) { assert.ok(input.documents.some(d => d.content.includes("Preserve evidence"))); return { id: "debug", revision: "tmp", title: "Debug", category: "development/debug", instructions: "Preserve evidence and validate fixes.", sources: [], branches: [{ id: "general", when: "Program failure; not unrelated research", instructions: "Reproduce, diagnose and verify", environment: [], conflictsWith: [], tools: [] }] }; } };
test("install archives full bytes; updates include changed scripts", async t => {
  const { repo, source } = setup(t); writeFileSync(join(source, "script.py"), "print('one')");
  const first = await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  writeFileSync(join(source, "script.py"), "print('two')");
  const second = await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  assert.notEqual(first.revision, second.revision);
  assert.match(Buffer.from((await repo.original("a", first.revision)).files.find(f => f.path === "script.py").base64, "base64").toString(), /one/);
});
test("source is not discoverable until a candidate passes trusted publication", async t => {
  const { repo, source } = setup(t), role = { id: "dev", skillIds: ["debug"], grants: [] };
  await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  assert.deepEqual((await repo.browse(role)).skills, []);
  const candidate = await repo.compile("debug", compiler, new AbortController().signal);
  assert.equal((await repo.catalog()).browse(role).length, 0);
  await assert.rejects(repo.publish(candidate.id, async () => ({ passed: false, evidence: [] })), /validation/);
  await assert.rejects(repo.publish(candidate.id, async () => ({ passed: true, evidence: ["test:passed"] })), /evidence/);
  await publish(repo, candidate);
  assert.deepEqual((await repo.browse(role)).categories, ["development"]);
  assert.equal((await repo.browse(role, "development/debug")).skills[0].id, "debug");
  assert.ok(!JSON.stringify(await repo.browse(role)).includes("NEVER_AUTO_EXPOSE"));
});
test("source changing during compilation rejects the stale candidate", async t => {
  const { repo, source } = setup(t); await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  await assert.rejects(repo.compile("debug", { async compile(input) {
    writeFileSync(join(source, "new.md"), "new requirements"); await repo.install(source, { id: "a", revision: "auto", group: "debug" }); return compiler.compile(input);
  } }, new AbortController().signal), /changed/);
});
test("symbolic links are not traversed during Skill installation", async t => {
  const { repo, source } = setup(t);
  try { symlinkSync(tmpdir(), join(source, "outside"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    // Windows without developer mode cannot create symlinks at all; the guard itself stays untested here.
    if (error.code === "EPERM") return t.skip(`symlink creation not permitted on this host: ${error.message}`);
    throw error;
  }
  await assert.rejects(repo.install(source, { id: "a", revision: "auto", group: "debug" }), /symlinks/);
});
test("hardlinked files are rejected during Skill installation", async t => {
  const { repo, source } = setup(t);
  const target = join(source, "linked.md");
  writeFileSync(target, "shared content");
  const alias = join(source, "alias.md");
  linkSync(target, alias);
  await assert.rejects(repo.install(source, { id: "a", revision: "auto", group: "debug" }), /limits|special files/);
});
test("install works from directories whose path contains spaces", async t => {
  const { directory, repo } = setup(t);
  const spaced = join(directory, "skill source with spaces");
  mkdirSync(spaced); writeFileSync(join(spaced, "SKILL.md"), "---\nname: spaced\ndescription: never exposed\n---\nWorks from a spaced path.");
  const installed = await repo.install(spaced, { id: "spaced", revision: "auto", group: "debug" });
  assert.equal(installed.files.length, 1);
  assert.ok((await repo.original("spaced", installed.revision)).files.some(f => f.path === "SKILL.md"));
});
test("Skill activation registers real MCP tools lazily and enforces current grants", async t => {
  const { repo } = setup(t);
  const client = new McpClient({ id: "local", accountId: "a", transport: { kind: "stdio", process: { command: process.execPath, args: [fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))], cwd: process.cwd() } } });
  t.after(() => client.close());
  const metadata = await client.tools(new AbortController().signal);
  const binding = { toolId: "local/lookup", accountId: "a", resourceId: "project:p", schemaHash: metadata[0].schemaHash, phase: "execute" };
  const id = await repo.publishMcp("local", "a", metadata, [binding]);
  let role = { id: "developer", skillIds: [id], grants: [{ toolId: binding.toolId, accountId: "a", resourceIds: ["project:p"] }] };
  const handlers = new Map(), tools = new Map(), entries = []; let active = ["read"];
  const host = { getActiveTools: () => active, setActiveTools: v => { active = v; },
    registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => handlers.set(name, fn), appendEntry: (type, data) => entries.push({ type, data }) };
  const cap = installCapabilities(host, { repository: repo, role: () => role, clients: [client], environment: [], resourceRules: [{ ...binding, equals: { project: "p" } }] });
  t.after(() => cap.close());
  assert.ok(!active.some(name => name.startsWith("pi861_mcp_")));
  const catalog = await repo.catalog(), published = catalog.browse(role)[0], branch = catalog.branches(role, id)[0];
  await tools.get("pi861_capabilities").execute("act", { action: "activate", skillId: id, revision: published.revision, branches: [branch.id], phase: "execute" });
  const name = active.find(name => name.startsWith("pi861_mcp_")); assert.ok(name);
  const result = await tools.get(name).execute("one", { project: "p" }); assert.match(result.content[0].text, /looked up p/);
  await assert.rejects(tools.get(name).execute("two", { project: "other" }), /authorization/);
  role = { ...role, grants: [] };
  await assert.rejects(tools.get(name).execute("three", { project: "p" }), /authorized/);
  const prompt = { systemPromptOptions: { skills: [{ description: "NEVER_AUTO_EXPOSE" }], sections: {} } };
  await handlers.get("before_agent_start")(prompt); assert.deepEqual(prompt.systemPromptOptions.skills, []);
});

test("capability factory does not call unbound Pi action methods",()=>{
 const commands=new Map();const host={registerTool(){},on(name,handler){commands.set(name,handler);},appendEntry(){},getActiveTools(){throw new Error("not bound");},setActiveTools(){throw new Error("not bound");}};
 assert.doesNotThrow(()=>installCapabilities(host,{repository:{},role:()=>({id:"r",skillIds:[],grants:[]}),clients:[],environment:[],resourceRules:[]}));
});

// AX6 coverage: minimal exposure, per-phase registration, cross-account dispatch, shared bindings,
// schema changes, hidden-name gating and zero business writes while browsing (requirements R5.1-R5.8).
const branch = (id, binding, extra = {}) => ({ id, when: `branch ${id}`, instructions: `Use ${binding.toolId}.`, environment: [], conflictsWith: [], tools: [binding], ...extra });
const runtimeSkill = (id, branches) => ({ id, revision: "candidate", title: id, category: `development/${id}`, instructions: `${id} instructions. Preserve evidence and validate fixes.`, sources: [], branches });

test("activation registers only bound tools and browsing stays free of business writes", async t => {
  const { repo } = setup(t);
  const client = fixtureClient(t);
  const metadata = await client.tools(signal());
  assert.equal(metadata.length, 5); // the server offers five tools
  const bindings = ["lookup", "stats"].map(name => {
    const tool = metadata.find(item => item.name === name);
    return { toolId: `local/${name}`, accountId: "a", resourceId: "project:p", schemaHash: tool.schemaHash, phase: "execute" };
  });
  const id = await repo.publishMcp("local", "a", metadata, bindings);
  const role = { id: "developer", skillIds: [id], grants: [{ toolId: "local/lookup", accountId: "a", resourceIds: ["project:p"] }, { toolId: "local/stats", accountId: "a", resourceIds: ["project:p"] }] };
  const h = harness(t, { repository: repo, role: () => role, clients: [client], environment: [], resourceRules: bindings.map(binding => ({ ...binding, endpointConfined: true })) });
  assert.deepEqual(h.activeNames(), []); // nothing registered before activation
  const browse = await h.tools.get("pi861_capabilities").execute("b", { action: "browse" });
  assert.ok(browse.content[0].text.includes("tools")); // shallow directory only
  const deep = await h.tools.get("pi861_capabilities").execute("b2", { action: "browse", path: "tools/local" });
  assert.ok(deep.content[0].text.includes(id));
  const catalog = await repo.catalog(), published = catalog.browse(role)[0];
  const branches = catalog.branches(role, id).map(item => item.id);
  await activateSkill(h, id, published.revision, branches, "execute");
  const names = h.activeNames();
  assert.equal(names.length, 2); // five server tools, two bound: exactly the two bound names appear
  const statsName = bindingName(h, bindings[1]);
  const payload = JSON.parse((await h.tools.get(statsName).execute("c", {})).content[0].text);
  const counters = JSON.parse(payload.content[0].text); // host text wraps the MCP result text
  assert.equal(counters.submits, 0); // browse, branches and activation performed zero business writes
  assert.ok(counters.lists >= 1 && counters.calls >= 1); // read traffic did happen
});

test("only the requested phase's tools are registered", async t => {
  const { repo, source } = setup(t);
  const client = fixtureClient(t);
  const metadata = await client.tools(signal());
  const hash = name => metadata.find(item => item.name === name).schemaHash;
  const skill = runtimeSkill("phased", [
    branch("plan", { toolId: "local/lookup", accountId: "a", resourceId: "project:p", schemaHash: hash("lookup"), phase: "plan" }),
    branch("execute", { toolId: "local/submit", accountId: "a", resourceId: "project:p", schemaHash: hash("submit"), phase: "execute" }),
  ]);
  await repo.install(source, { id: "p", revision: "auto", group: "phased" });
  await publish(repo, await repo.compile("phased", staticCompiler(skill), signal(), { approvedBindings: skill.branches.flatMap(branch => branch.tools) }), [client]);
  const role = { id: "developer", skillIds: ["phased"], grants: [{ toolId: "local/lookup", accountId: "a", resourceIds: ["project:p"] }, { toolId: "local/submit", accountId: "a", resourceIds: ["project:p"] }] };
  const h = harness(t, { repository: repo, role: () => role, clients: [client], environment: [], resourceRules: [
    { toolId: "local/lookup", accountId: "a", resourceId: "project:p", equals: { project: "p" } },
    { toolId: "local/submit", accountId: "a", resourceId: "project:p", equals: { project: "p" } },
  ] });
  const published = (await repo.catalog()).browse(role)[0];
  await activateSkill(h, "phased", published.revision, ["plan", "execute"], "plan");
  const names = h.activeNames();
  assert.equal(names.length, 1); // the execute-phase submit tool is not registered
  assert.match((await h.tools.get(names[0]).execute("c", { project: "p" })).content[0].text, /looked up p/);
});

test("cross-account bindings dispatch through their own account's client", async t => {
  const { repo, source } = setup(t);
  const clientA = fixtureClient(t, { MCP_ACCOUNT: "acct-a" }, { id: "dup", accountId: "a" });
  const clientB = fixtureClient(t, { MCP_ACCOUNT: "acct-b" }, { id: "dup", accountId: "b" });
  const schemaHash = (await clientA.tools(signal())).find(tool => tool.name === "lookup").schemaHash;
  const bindA = { toolId: "dup/lookup", accountId: "a", resourceId: "project:pa", schemaHash, phase: "execute" };
  const bindB = { toolId: "dup/lookup", accountId: "b", resourceId: "project:pb", schemaHash, phase: "execute" };
  await repo.install(source, { id: "c", revision: "auto", group: "cross" });
  await publish(repo, await repo.compile("cross", staticCompiler(runtimeSkill("cross", [branch("via-a", bindA), branch("via-b", bindB)])), signal(), { approvedBindings: [bindA, bindB] }), [clientA, clientB]);
  const role = { id: "developer", skillIds: ["cross"], grants: [
    { toolId: "dup/lookup", accountId: "a", resourceIds: ["project:pa"] }, { toolId: "dup/lookup", accountId: "b", resourceIds: ["project:pb"] }] };
  const h = harness(t, { repository: repo, role: () => role, clients: [clientA, clientB], environment: [], resourceRules: [
    { toolId: "dup/lookup", accountId: "a", resourceId: "project:pa", equals: { project: "pa" } },
    { toolId: "dup/lookup", accountId: "b", resourceId: "project:pb", equals: { project: "pb" } },
  ] });
  const published = (await repo.catalog()).browse(role)[0];
  await activateSkill(h, "cross", published.revision, ["via-a", "via-b"], "execute");
  assert.equal(h.activeNames().length, 2);
  // Each registered name must reach the account named in its own binding, not the last one described.
  const viaA = (await h.tools.get(bindingName(h, bindA)).execute("c", { project: "pa" })).content[0].text;
  const viaB = (await h.tools.get(bindingName(h, bindB)).execute("c", { project: "pb" })).content[0].text;
  assert.match(viaA, /via account acct-a/);
  assert.match(viaB, /via account acct-b/);
});

test("same-named tools on different servers keep separate registrations", async t => {
  const { repo, source } = setup(t);
  const one = fixtureClient(t, { MCP_ACCOUNT: "server-one" }, { id: "one", accountId: "acct" });
  const two = fixtureClient(t, { MCP_ACCOUNT: "server-two" }, { id: "two", accountId: "acct" });
  const hashOne = (await one.tools(signal())).find(tool => tool.name === "lookup").schemaHash;
  const hashTwo = (await two.tools(signal())).find(tool => tool.name === "lookup").schemaHash;
  const b1 = { toolId: "one/lookup", accountId: "acct", resourceId: "project:p", schemaHash: hashOne, phase: "execute" };
  const b2 = { toolId: "two/lookup", accountId: "acct", resourceId: "project:q", schemaHash: hashTwo, phase: "execute" };
  await repo.install(source, { id: "s", revision: "auto", group: "twin" });
  await publish(repo, await repo.compile("twin", staticCompiler(runtimeSkill("twin", [branch("one", b1), branch("two", b2)])), signal(), { approvedBindings: [b1, b2] }), [one, two]);
  const role = { id: "developer", skillIds: ["twin"], grants: [
    { toolId: "one/lookup", accountId: "acct", resourceIds: ["project:p"] }, { toolId: "two/lookup", accountId: "acct", resourceIds: ["project:q"] }] };
  const h = harness(t, { repository: repo, role: () => role, clients: [one, two], environment: [], resourceRules: [
    { toolId: "one/lookup", accountId: "acct", resourceId: "project:p", equals: { project: "p" } },
    { toolId: "two/lookup", accountId: "acct", resourceId: "project:q", equals: { project: "q" } },
  ] });
  const published = (await repo.catalog()).browse(role)[0];
  await activateSkill(h, "twin", published.revision, ["one", "two"], "execute");
  assert.deepEqual(h.activeNames().sort(), [bindingName(h, b1), bindingName(h, b2)].sort());
  assert.match((await h.tools.get(bindingName(h, b1)).execute("c", { project: "p" })).content[0].text, /via account server-one/);
  assert.match((await h.tools.get(bindingName(h, b2)).execute("c", { project: "q" })).content[0].text, /via account server-two/);
});

test("two Skills sharing one binding do not disable each other", async t => {
  const { repo, source } = setup(t);
  const client = fixtureClient(t);
  const binding = { toolId: "local/lookup", accountId: "a", resourceId: "project:p", schemaHash: (await client.tools(signal())).find(tool => tool.name === "lookup").schemaHash, phase: "execute" };
  await repo.install(source, { id: "s1", revision: "auto", group: "share1" });
  await repo.install(source, { id: "s2", revision: "auto", group: "share2" });
  await publish(repo, await repo.compile("share1", staticCompiler(runtimeSkill("shared1", [branch("only", binding)])), signal(), { approvedBindings: [binding] }), [client]);
  await publish(repo, await repo.compile("share2", staticCompiler(runtimeSkill("shared2", [branch("only", binding)])), signal(), { approvedBindings: [binding] }), [client]);
  const role = { id: "developer", skillIds: ["shared1", "shared2"], grants: [{ toolId: "local/lookup", accountId: "a", resourceIds: ["project:p"] }] };
  const h = harness(t, { repository: repo, role: () => role, clients: [client], environment: [], resourceRules: [{ ...binding, equals: { project: "p" } }] });
  const catalog = await repo.catalog();
  for (const skillId of ["shared1", "shared2"]) {
    const published = catalog.browse(role).find(item => item.id === skillId);
    await activateSkill(h, skillId, published.revision, ["only"], "execute");
  }
  const name = bindingName(h, binding, "shared1");
  const secondName = bindingName(h, binding, "shared2");
  assert.notEqual(name, secondName);
  assert.match((await h.tools.get(secondName).execute("other", { project: "p" })).content[0].text, /looked up p/);
  assert.match((await h.tools.get(name).execute("c1", { project: "p" })).content[0].text, /looked up p/);
  await h.tools.get("pi861_capabilities").execute("d1", { action: "deactivate", skillId: "shared2" });
  assert.match((await h.tools.get(name).execute("c2", { project: "p" })).content[0].text, /looked up p/); // shared1 still supports the binding
  assert.equal(h.handlers.get("tool_call")({ toolName: name }), undefined);
  assert.deepEqual(h.handlers.get("tool_call")({ toolName: "pi861_mcp_never_registered" }), { block: true, reason: "MCP capability is not active" });
  await h.tools.get("pi861_capabilities").execute("d2", { action: "deactivate", skillId: "shared1" });
  assert.deepEqual(h.handlers.get("tool_call")({ toolName: name }), { block: true, reason: "MCP capability is not active" });
  await assert.rejects(h.tools.get(name).execute("c3", { project: "p" }), /no longer active/);
});

test("a schema change blocks live bindings and refuses reactivation", async t => {
  const { directory, repo } = setup(t);
  const control = join(directory, "flip");
  const client = fixtureClient(t, { MCP_CONTROL: control });
  const binding = { toolId: "local/lookup", accountId: "a", resourceId: "project:p", schemaHash: (await client.tools(signal())).find(tool => tool.name === "lookup").schemaHash, phase: "execute" };
  const id = await repo.publishMcp("local", "a", await client.tools(signal()), [binding]);
  const role = { id: "developer", skillIds: [id], grants: [{ toolId: "local/lookup", accountId: "a", resourceIds: ["project:p"] }] };
  const h = harness(t, { repository: repo, role: () => role, clients: [client], environment: [], resourceRules: [{ ...binding, equals: { project: "p" } }] });
  const published = (await repo.catalog()).browse(role)[0];
  await activateSkill(h, id, published.revision, (await repo.catalog()).branches(role, id).map(item => item.id), "execute");
  const name = bindingName(h, binding);
  assert.match((await h.tools.get(name).execute("c", { project: "p" })).content[0].text, /looked up p/);
  writeFileSync(control, "v2"); // the server flips its input schema
  await assert.rejects(h.tools.get(name).execute("c2", { project: "p" }), /schema changed/);
  await assert.rejects(activateSkill(h, id, published.revision, (await repo.catalog()).branches(role, id).map(item => item.id), "execute"), /metadata changed/);
});

test("duplicate endpoint identities are rejected; distinct accounts of one server are not", () => {
  const mk = (id, accountId) => new McpClient({ id, accountId, transport: { kind: "stdio", process: { command: process.execPath, args: [fixturePath], cwd: process.cwd() } } });
  const host = { registerTool() {}, on() {}, appendEntry() {}, getActiveTools: () => [], setActiveTools() {} };
  const base = { repository: {}, role: () => ({ id: "r", skillIds: [], grants: [] }), environment: [], resourceRules: [] };
  assert.throws(() => installCapabilities(host, { ...base, clients: [mk("dup", "a"), mk("dup", "a")] }), /Duplicate MCP endpoint/);
  const legal = installCapabilities(host, { ...base, clients: [mk("dup", "a"), mk("dup", "b")] });
  legal.close();
});

test("revoking grants also blocks stored result references", async t => {
  const { repo } = setup(t);
  const binding = { toolId: "t/x", accountId: "a", resourceId: "r", schemaHash: "h", phase: "execute" };
  const role = { id: "dev", skillIds: ["debug"], grants: [{ toolId: "t/x", accountId: "a", resourceIds: ["r"] }] };
  const reference = await repo.storeResult({ data: "sensitive" }, { roleId: "dev", skillId: "debug", binding });
  assert.match(JSON.stringify(await repo.readResult(reference, role)), /sensitive/);
  await assert.rejects(repo.readResult(reference, { ...role, grants: [] }), /not found/);
});

// AX5 groundwork coverage with a deterministic compiler fixture: merge, branch selection and
// version pinning are pinned here so Phase B integration (auto-grouping, rebuild) inherits them.
test("two generic sources compile into one merged runtime Skill", async t => {
  const { directory, repo } = setup(t);
  const second = join(directory, "source-b"); mkdirSync(second);
  writeFileSync(join(second, "SKILL.md"), "---\nname: debug-b\ndescription: NEVER_AUTO_EXPOSE_B\n---\nCheck the logs. Preserve evidence.");
  await repo.install(join(directory, "source"), { id: "debug-a", revision: "auto", group: "debug" });
  await repo.install(second, { id: "debug-b", revision: "auto", group: "debug" });
  const candidate = await repo.compile("debug", { async compile(input) {
    assert.ok(input.documents.some(item => item.sourceId === "debug-a" && item.content.includes("Preserve evidence")));
    assert.ok(input.documents.some(item => item.sourceId === "debug-b" && item.content.includes("Check the logs")));
    return runtimeSkill("debug", [{ id: "general", when: "Program failure", instructions: "Reproduce, diagnose and verify. Check the logs.", environment: [], conflictsWith: [], tools: [] }]);
  } }, signal());
  await publish(repo, candidate);
  const role = { id: "dev", skillIds: ["debug"], grants: [] };
  assert.equal((await repo.browse(role, "development/debug")).skills.length, 1); // one entry, not one per source
  assert.equal((await repo.catalog()).branches(role, "debug").length, 1);
  assert.ok(!JSON.stringify(await repo.browse(role)).includes("NEVER_AUTO_EXPOSE_B")); // original descriptions stay hidden
});

test("environment-gated and mutually exclusive branches select correctly", async t => {
  const { repo, source } = setup(t);
  await repo.install(source, { id: "e", revision: "auto", group: "envs" });
  const skill = runtimeSkill("envskill", [
    { id: "general", when: "Program failure", instructions: "General debugging.", environment: [], conflictsWith: ["browser"], tools: [] },
    { id: "browser", when: "Browser-only failure", instructions: "Collect console evidence.", environment: ["browser"], conflictsWith: ["general"], tools: [] },
    { id: "console", when: "Console logs needed", instructions: "Read the console.", environment: ["browser"], conflictsWith: [], tools: [] },
  ]);
  await publish(repo, await repo.compile("envs", staticCompiler(skill), signal()));
  const role = { id: "developer", skillIds: ["envskill"], grants: [] };
  const published = (await repo.catalog()).browse(role)[0];
  const plain = harness(t, { repository: repo, role: () => role, clients: [], environment: [], resourceRules: [] });
  await assert.rejects(activateSkill(plain, "envskill", published.revision, ["browser"], "execute"), /prerequisites/);
  await activateSkill(plain, "envskill", published.revision, ["general"], "execute"); // available without the browser environment
  const withBrowser = harness(t, { repository: repo, role: () => role, clients: [], environment: ["browser"], resourceRules: [] });
  await activateSkill(withBrowser, "envskill", published.revision, ["browser"], "execute"); // available with it
  await assert.rejects(activateSkill(withBrowser, "envskill", published.revision, ["general", "browser"], "execute"), /Conflicting/); // mutex holds
  await activateSkill(withBrowser, "envskill", published.revision, ["browser", "console"], "execute"); // compatible supplements coexist
});

test("a new published version leaves running activations pinned; rollback restores", async t => {
  const { repo, source } = setup(t);
  await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  const instructions = text => [{ id: "general", when: "Failure", instructions: text, environment: [], conflictsWith: [], tools: [] }];
  const v1 = await publish(repo, await repo.compile("debug", staticCompiler(runtimeSkill("debug", instructions("Version one instructions."))), signal()));
  const role = { id: "dev", skillIds: ["debug"], grants: [] };
  const h = harness(t, { repository: repo, role: () => role, clients: [], environment: [], resourceRules: [] });
  // activateSkill returns a ToolResult whose text is the serialized Activation.
  const first = JSON.parse((await activateSkill(h, "debug", v1.revision, ["general"], "execute")).content[0].text);
  assert.equal(first.skillRevision, v1.revision);
  assert.match(first.instructions, /Version one/);
  writeFileSync(join(source, "SKILL.md"), "---\nname: debug\ndescription: NEVER_AUTO_EXPOSE_ORIGINAL\n---\nRead the error. Preserve evidence. Also check telemetry.");
  await repo.install(source, { id: "a", revision: "auto", group: "debug" });
  const v2 = await publish(repo, await repo.compile("debug", staticCompiler(runtimeSkill("debug", instructions("Version two instructions."))), signal()));
  assert.notEqual(v2.revision, v1.revision);
  assert.equal(first.skillRevision, v1.revision); // the running activation snapshot is unchanged
  assert.match(first.instructions, /Version one/);
  const second = JSON.parse((await activateSkill(h, "debug", v2.revision, ["general"], "execute")).content[0].text);
  assert.equal(second.skillRevision, v2.revision);
  assert.match(second.instructions, /Version two/);
  await repo.rollback("debug", v1.revision);
  const third = JSON.parse((await activateSkill(h, "debug", v1.revision, ["general"], "execute")).content[0].text);
  assert.equal(third.skillRevision, v1.revision);
  assert.match(third.instructions, /Version one/);
});

// ---------------------------------------------------------------------------
// P2-S additions: AX5 auto-integration through the frozen P1-S shared invocation
// port, install-script negatives, execution-identity version pinning and C7
// scoped controlled references.
// ---------------------------------------------------------------------------

/** Deterministic fake M1-shaped port answering the S compiler/grouping prompts. */
function skillChainPort() {
  const requests = [];
  let sequence = 0;
  const groupingReplies = [
    { group: "debug", relatedGroups: [], reason: "first generic debugging package opens the group" },
    { group: "debug", relatedGroups: [], reason: "second generic package joins the existing debugging group" },
    { group: "debug/browser", relatedGroups: ["debug"], reason: "browser-specific variant, related to generic debugging" },
  ];
  return {
    requests,
    groupingReplies,
    port: {
      async attempt(request, onUsage) {
        requests.push(request);
        onUsage({ inputTokens: 900, outputTokens: 90, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 });
        if (request.prompt.startsWith("Classify this untrusted Skill")) {
          const reply = groupingReplies.shift();
          if (!reply) throw new Error("unexpected extra grouping call");
          return JSON.stringify(reply);
        }
        if (request.prompt.startsWith("Compile these UNTRUSTED")) {
          return JSON.stringify({
            id: "debug",
            title: "Debug",
            category: "development/debug",
            instructions: "Preserve evidence and validate fixes. Check telemetry when present.",
            branches: [
              { id: "general", when: "Program failure without a browser component", instructions: "Reproduce, diagnose and verify. Check the logs.", environment: [], conflictsWith: [], tools: [] },
              { id: "browser", when: "Failure renders in a browser", instructions: "Collect console evidence before changing code.", environment: [], conflictsWith: [], tools: [] },
            ],
          });
        }
        throw new Error(`unexpected auxiliary prompt: ${request.prompt.slice(0, 40)}`);
      },
      newRequestId() {
        return `aux-${++sequence}`;
      },
    },
  };
}

/** A real AuxiliaryModelInvocations instance over a fixture port, per the P1-S test pattern. */
function sharedInvocations(failing = false) {
  const target = { id: "compiler", revision: "r1", provider: "fixture", model: "compiler", quality: 5, costRank: 1, contextWindow: 200_000, capabilities: ["text"], enabled: true };
  const role = { id: "dev", revision: "r1", readScopes: ["project:fixture"], writeScopes: [], outbound: [], toolGrants: [] };
  const verifier = new IdentityAuthority({ authorityId: "p2s-authority", tenantId: "local", trustedLocal: true, roles: [role] });
  const fake = skillChainPort();
  if (failing) fake.groupingReplies.length = 0; // forces the "extra grouping call" error path
  const budget = new TaskTreeBudget(
    { maxTotalCostUsd: 1000, maxAttempts: 100, maxInputTokens: 100_000_000, maxOutputTokens: 10_000_000 },
    { budgetId: "budget-p2s-skill-chain" },
  );
  const invocations = new AuxiliaryModelInvocations({
    authority: verifier,
    budget,
    port: fake.port,
    targets: { classifier: target, compiler: target, enrich: target, planner: target },
  });
  return { invocations, budget, requests: fake.requests, credential: verifier.issue("agent-1", { roleIds: ["dev"] }) };
}

function writePackage(root, name, body) {
  const directory = join(root, name);
  mkdirSync(directory);
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: NEVER_AUTO_EXPOSE_${name}\n---\n${body} Preserve evidence.`);
  return directory;
}

test("AX5: three packages auto-integrate into one runtime Skill through the shared invocation port", async t => {
  const { directory, repo } = setup(t);
  const { invocations, budget, requests, credential } = sharedInvocations();
  const context = { credential, scope: "project:fixture", taskId: null };
  const classified = new SkillRepository(new FileStateStore(join(directory, "skills.json"), emptySkillState()), {
    classify: auxiliaryGrouping(invocations, context),
  });
  // Two generic Debug packages and one specialized browser variant, installed WITHOUT a group.
  const genericA = writePackage(directory, "debug-a", "Read the error. Check the logs.");
  const genericB = writePackage(directory, "debug-b", "Reproduce first. Check the logs.");
  const specialized = writePackage(directory, "debug-special", "Inspect the browser console and network panel.");
  const installed = [
    await classified.install(genericA, { id: "debug-a", revision: "auto" }),
    await classified.install(genericB, { id: "debug-b", revision: "auto" }),
    await classified.install(specialized, { id: "debug-special", revision: "auto" }),
  ];
  assert.deepEqual(installed.map(item => item.group), ["debug", "debug", "debug/browser"]);
  assert.ok(installed.every(item => item.grouping?.method === "automatic"));
  // Compiling the specialized group pulls its related generic group: all three sources integrate.
  const candidate = await classified.compile(
    "debug/browser",
    auxiliaryCompiler(invocations, context),
    signal(),
    { approvedBindings: [] },
  );
  assert.deepEqual([...new Set(candidate.skill.sources.map(source => source.id))].sort(),
    ["debug-a", "debug-b", "debug-special"]);
  assert.equal(candidate.approvedBindings.length, 0);
  await publish(classified, candidate);
  const role = { id: "dev", skillIds: ["debug"], grants: [] };
  const listing = await classified.browse(role, "development/debug");
  assert.equal(listing.skills.length, 1);
  assert.equal(listing.skills[0].id, "debug");
  // Every physical model call ran through the shared service under one budget: three groupings
  // plus one compilation, all metered with measured usage and nothing left open.
  assert.equal(requests.length, 4);
  assert.ok(requests.every(request => request.purpose === "auxiliary"));
  assert.equal(budget.usage.attempts, 4);
  assert.equal(budget.usage.unknownSettlements, 0);
  assert.equal(budget.openReservations().length, 0);
  // Manual group override never touches the model.
  const manual = writePackage(directory, "manual-pkg", "Operator-pinned group.");
  const manualSource = await classified.install(manual, { id: "manual", revision: "auto", group: "explicit" });
  assert.equal(manualSource.grouping?.method, "manual");
  assert.equal(requests.length, 4);
});

test("AX5 negative: automatic grouping without a classifier or over budget is refused", async t => {
  const { directory, repo } = setup(t);
  const unclassified = writePackage(directory, "no-group", "Cannot be grouped here.");
  await assert.rejects(repo.install(unclassified, { id: "n", revision: "auto" }), /classifier/);
  const { invocations, credential } = sharedInvocations();
  const context = { credential, scope: "project:fixture", taskId: null };
  const tiny = new SkillRepository(new FileStateStore(join(directory, "tiny.json"), emptySkillState()), {
    classify: auxiliaryGrouping(invocations, context),
    maxInputBytes: 64,
  });
  await assert.rejects(tiny.install(unclassified, { id: "n", revision: "auto" }), /byte budget/);
  // A grouping decision outside the S compiler's contract is rejected, not coerced: the
  // repository re-validates even a misbehaving classifier.
  const badDecision = new SkillRepository(new FileStateStore(join(directory, "bad.json"), emptySkillState()), {
    classify: async () => ({ group: "../escape", relatedGroups: [], reason: "malicious" }),
  });
  await assert.rejects(badDecision.install(unclassified, { id: "n", revision: "auto" }), /grouping/);
});

test("AX5: uninstall invalidates, rebuildAffected recompiles through the port, rollback restores", async t => {
  const { directory, repo } = setup(t);
  const { invocations, credential } = sharedInvocations();
  const context = { credential, scope: "project:fixture", taskId: null };
  const classified = new SkillRepository(new FileStateStore(join(directory, "skills.json"), emptySkillState()), {
    classify: auxiliaryGrouping(invocations, context),
  });
  const a = writePackage(directory, "debug-a", "Read the error.");
  const b = writePackage(directory, "debug-b", "Check the logs.");
  await classified.install(a, { id: "debug-a", revision: "auto" });
  await classified.install(b, { id: "debug-b", revision: "auto" });
  const v1 = await publish(classified, await classified.compile("debug", auxiliaryCompiler(invocations, context), signal(), { approvedBindings: [] }));
  const role = { id: "dev", skillIds: ["debug"], grants: [] };
  assert.equal((await classified.browse(role, "development/debug")).skills[0].revision, v1.revision);
  // Uninstalling one source invalidates the published merged version: it leaves the affected
  // list and disappears from browsing until a rebuilt candidate is published again.
  await classified.uninstall("debug-b");
  assert.deepEqual((await classified.affected()).map(item => item.skillId), ["debug"]);
  assert.deepEqual((await classified.browse(role, "development/debug")).skills, []);
  const rebuilt = await classified.rebuildAffected(auxiliaryCompiler(invocations, context), signal(), []);
  assert.equal(rebuilt.length, 1);
  assert.deepEqual(rebuilt[0].skill.sources.map(source => source.id), ["debug-a"]);
  const v2 = await publish(classified, rebuilt[0]);
  assert.notEqual(v2.revision, v1.revision);
  assert.equal((await classified.browse(role, "development/debug")).skills[0].revision, v2.revision);
  await classified.rollback("debug", v1.revision);
  assert.equal((await classified.browse(role, "development/debug")).skills[0].revision, v1.revision);
});

test("R4.8: installing a package never runs its scripts or lifecycle hooks", async t => {
  const { directory, repo } = setup(t);
  const source = join(directory, "trapped");
  mkdirSync(source);
  writeFileSync(join(source, "SKILL.md"), "---\nname: trap\ndescription: never exposed\n---\nInnocent documentation.");
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "trap", version: "1.0.0",
    scripts: { preinstall: "node trap.js", postinstall: "node trap.js", install: "node trap.js" },
  }));
  writeFileSync(join(source, "trap.js"), "require('node:fs').writeFileSync(__dirname + '/RAN', 'ran');");
  const installed = await repo.install(source, { id: "trap", revision: "auto", group: "debug" });
  assert.equal(installed.files.length, 3); // archived as bytes only
  assert.ok(!existsSync(join(source, "RAN")), "installation must not execute source scripts");
  assert.ok(!existsSync(join(directory, "RAN")));
});

test("AX6: a running task's Skill version is pinned per execution identity", async t => {
  const { repo } = setup(t);
  const client = fixtureClient(t);
  const metadata = await client.tools(signal());
  const binding = { toolId: "local/lookup", accountId: "a", resourceId: "project:p", schemaHash: metadata.find(tool => tool.name === "lookup").schemaHash, phase: "execute" };
  const id = await repo.publishMcp("local", "a", metadata, [binding]);
  const role = { id: "developer", skillIds: [id], grants: [{ toolId: "local/lookup", accountId: "a", resourceIds: ["project:p"] }] };
  let execution = { tenantId: "local", projectId: "fixture", goalId: "g", runId: "r", taskId: "t", attempt: 1 };
  const h = harness(t, { repository: repo, role: () => role, clients: [client], environment: [], resourceRules: [{ ...binding, equals: { project: "p" } }], executionIdentity: () => execution });
  const published = (await repo.catalog()).browse(role)[0];
  const branchId = (await repo.catalog()).branches(role, id)[0].id;
  await activateSkill(h, id, published.revision, [branchId], "execute");
  const name = bindingName(h, binding);
  assert.match((await h.tools.get(name).execute("c1", { project: "p" })).content[0].text, /looked up p/);
  // Publishing a second revision of the SAME skill must not tempt the running task to drift.
  const sameIdAgain = await repo.publishMcp("local", "a", metadata, [{ ...binding, resourceId: "project:q" }]);
  assert.equal(sameIdAgain, id);
  const v2 = (await repo.catalog()).browse(role)[0];
  assert.notEqual(v2.revision, published.revision);
  await assert.rejects(activateSkill(h, id, v2.revision, [branchId], "execute"), /pinned/);
  // Ending the task attempt invalidates live dispatch under the old identity.
  execution = { ...execution, attempt: 2 };
  await assert.rejects(h.tools.get(name).execute("c2", { project: "p" }), /attempt ended/);
});

test("C7: scoped controlled references enforce read scopes, field selection and integrity", async t => {
  const directory = mkdtempSync(join(tmpdir(), "pi861-skill-c7-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = new SkillRepository(new FileStateStore(join(directory, "skills.json"), emptySkillState()), { maxResultBytes: 20_000 });
  const binding = { toolId: "t/x", accountId: "a", resourceId: "r", schemaHash: "h", phase: "execute" };
  const producedBy = { tenantId: "local", projectId: "fixture", goalId: "g", runId: "r", taskId: "t", attempt: 1 };
  const role = { id: "dev", skillIds: ["debug"], grants: [{ toolId: "t/x", accountId: "a", resourceIds: ["r"] }], readScopes: ["project:fixture"] };
  const owner = { roleId: "dev", skillId: "debug", binding, scope: "project:fixture", producedBy };
  // Untruncated reference: field-level selection returns exactly the pointed value.
  const small = await repo.storeResult({ meta: { errors: 3, nested: { deepest: "value" } } }, owner);
  assert.equal(JSON.parse((await repo.readResult(small, role, 0, "meta.errors")).text), 3);
  assert.equal(JSON.parse((await repo.readResult(small, role, 0, "meta.nested.deepest")).text), "value");
  // Truncated reference: paging stays available, field selection is refused, metadata stays honest.
  const big = await repo.storeResult({ log: "x".repeat(40_000) }, owner);
  const full = await repo.readResult(big, role);
  assert.equal(full.truncated, true);
  assert.ok(full.sourceBytes > full.totalCharacters);
  assert.equal(full.hasMore, true);
  await assert.rejects(repo.readResult(big, role, 0, "log"), /truncated/);
  // Controlled-reference metadata binds artifact id, digest, size and scope.
  assert.equal(full.reference.artifactId, big);
  assert.equal(full.reference.scope, "project:fixture");
  assert.equal(full.reference.contentDigest, full.contentDigest);
  assert.equal(full.reference.byteSize, full.sourceBytes);
  // A reader without the scope, or with revoked grants, gets the uniform missing-artifact failure.
  const scopedOut = { ...role, readScopes: ["project:other"] };
  await assert.rejects(repo.readResult(small, scopedOut), /not found/);
  const revoked = { ...role, grants: [] };
  await assert.rejects(repo.readResult(small, revoked), /not found/);
});
