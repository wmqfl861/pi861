import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, linkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FileStateStore } from "../src/live/store.ts";
import { SkillRepository, emptySkillState } from "../src/live/skill-repository.ts";
import { McpClient } from "../src/live/mcp.ts";
import { installCapabilities } from "../src/live/skills-host.ts";
import { digest } from "../src/memory.ts";
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
const publish = (repo, candidate) => repo.publish(candidate.id, async () => ({ passed: true, evidence: ["fixture"] }));
const bindingName = binding => `pi861_mcp_${digest([binding.toolId, binding.accountId, binding.resourceId]).slice(0, 20)}`;
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
  await repo.publish(candidate.id, async () => ({ passed: true, evidence: ["test:passed"] }));
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
  try { symlinkSync("/tmp", join(source, "outside")); }
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
const runtimeSkill = (id, branches) => ({ id, revision: "candidate", title: id, category: `development/${id}`, instructions: `${id} instructions.`, sources: [], branches });

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
  const h = harness(t, { repository: repo, role: () => role, clients: [client], environment: [], resourceRules: bindings.map(binding => ({ ...binding, equals: { project: "p" } })) });
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
  const statsName = bindingName(bindings[1]);
  const payload = JSON.parse((await h.tools.get(statsName).execute("c", { project: "p" })).content[0].text);
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
  await publish(repo, await repo.compile("phased", staticCompiler(skill), signal()));
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
  await publish(repo, await repo.compile("cross", staticCompiler(runtimeSkill("cross", [branch("via-a", bindA), branch("via-b", bindB)])), signal()));
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
  const viaA = (await h.tools.get(bindingName(bindA)).execute("c", { project: "pa" })).content[0].text;
  const viaB = (await h.tools.get(bindingName(bindB)).execute("c", { project: "pb" })).content[0].text;
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
  await publish(repo, await repo.compile("twin", staticCompiler(runtimeSkill("twin", [branch("one", b1), branch("two", b2)])), signal()));
  const role = { id: "developer", skillIds: ["twin"], grants: [
    { toolId: "one/lookup", accountId: "acct", resourceIds: ["project:p"] }, { toolId: "two/lookup", accountId: "acct", resourceIds: ["project:q"] }] };
  const h = harness(t, { repository: repo, role: () => role, clients: [one, two], environment: [], resourceRules: [
    { toolId: "one/lookup", accountId: "acct", resourceId: "project:p", equals: { project: "p" } },
    { toolId: "two/lookup", accountId: "acct", resourceId: "project:q", equals: { project: "q" } },
  ] });
  const published = (await repo.catalog()).browse(role)[0];
  await activateSkill(h, "twin", published.revision, ["one", "two"], "execute");
  assert.deepEqual(h.activeNames().sort(), [bindingName(b1), bindingName(b2)].sort());
  assert.match((await h.tools.get(bindingName(b1)).execute("c", { project: "p" })).content[0].text, /via account server-one/);
  assert.match((await h.tools.get(bindingName(b2)).execute("c", { project: "q" })).content[0].text, /via account server-two/);
});

test("two Skills sharing one binding do not disable each other", async t => {
  const { repo, source } = setup(t);
  const client = fixtureClient(t);
  const binding = { toolId: "local/lookup", accountId: "a", resourceId: "project:p", schemaHash: (await client.tools(signal())).find(tool => tool.name === "lookup").schemaHash, phase: "execute" };
  await repo.install(source, { id: "s1", revision: "auto", group: "share1" });
  await repo.install(source, { id: "s2", revision: "auto", group: "share2" });
  await publish(repo, await repo.compile("share1", staticCompiler(runtimeSkill("shared1", [branch("only", binding)])), signal()));
  await publish(repo, await repo.compile("share2", staticCompiler(runtimeSkill("shared2", [branch("only", binding)])), signal()));
  const role = { id: "developer", skillIds: ["shared1", "shared2"], grants: [{ toolId: "local/lookup", accountId: "a", resourceIds: ["project:p"] }] };
  const h = harness(t, { repository: repo, role: () => role, clients: [client], environment: [], resourceRules: [{ ...binding, equals: { project: "p" } }] });
  const catalog = await repo.catalog();
  for (const skillId of ["shared1", "shared2"]) {
    const published = catalog.browse(role).find(item => item.id === skillId);
    await activateSkill(h, skillId, published.revision, ["only"], "execute");
  }
  const name = bindingName(binding);
  assert.match((await h.tools.get(name).execute("c1", { project: "p" })).content[0].text, /looked up p/);
  await h.tools.get("pi861_capabilities").execute("d1", { action: "deactivate", skillId: "shared2" });
  assert.match((await h.tools.get(name).execute("c2", { project: "p" })).content[0].text, /looked up p/); // shared1 still supports the binding
  assert.equal(h.handlers.get("tool_call")({ toolName: name }), undefined);
  assert.equal(h.handlers.get("tool_call")({ toolName: "pi861_mcp_never_registered" }), undefined); // never-activated names are not gated here
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
  const name = bindingName(binding);
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
