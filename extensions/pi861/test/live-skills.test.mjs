import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FileStateStore } from "../src/live/store.ts";
import { SkillRepository, emptySkillState } from "../src/live/skill-repository.ts";
import { McpClient } from "../src/live/mcp.ts";
import { installCapabilities } from "../src/live/skills-host.ts";
function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi861-skill-")); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source"); mkdirSync(source); writeFileSync(join(source, "SKILL.md"), "---\nname: debug\ndescription: NEVER_AUTO_EXPOSE_ORIGINAL\n---\nRead the error. Preserve evidence. Validate the fix.");
  return { directory, source, repo: new SkillRepository(new FileStateStore(join(directory, "skills.json"), emptySkillState())) };
}
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
  const { repo, source } = setup(t); symlinkSync("/tmp", join(source, "outside"));
  await assert.rejects(repo.install(source, { id: "a", revision: "auto", group: "debug" }), /symlinks/);
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
