import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileStateStore } from "../src/live/store.ts";
import { LayeredMemory, emptyLayeredMemory } from "../src/live/layered-memory.ts";
const principal = { tenantId: "t", principalId: "a", readScopes: ["project:p"], writeScopes: ["project:p"] };
const item = (id, full = "用户决定使用 PostgreSQL，记录来自验收会议。") => ({ id, scope: "project:p", kind: "project", status: "confirmed", full, abstract: full, overview: full, source: { kind: "user", ref: `event:${id}` } });
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi861-memory-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("t"));
  return { store, memory: new LayeredMemory(store, principal) };
}
test("durable memory survives a new backend/session instance", async t => {
  const { store, memory } = setup(t);
  await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const next = new LayeredMemory(store, principal);
  assert.match((await next.get("project:p", "a")).full, /PostgreSQL/);
  assert.equal((await next.search("为什么使用 PostgreSQL"))[0].id, "a");
});
test("two file writers cannot overwrite the same revision", async t => {
  const { store, memory } = setup(t), other = new LayeredMemory(store, { ...principal, principalId: "b" });
  await memory.put({ requestId: "start", expectedRevision: null, item: item("a") });
  const outcomes = await Promise.allSettled([
    memory.put({ requestId: "u1", expectedRevision: 1, item: item("a", "first change") }),
    other.put({ requestId: "u2", expectedRevision: 1, item: item("a", "second change") })]);
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
  assert.equal((await memory.get("project:p", "a")).revision, 2);
});
test("write replay does not append a second delta or extraction job", async t => {
  const { store, memory } = setup(t), request = { requestId: "r1", expectedRevision: null, item: item("a") };
  assert.deepEqual(await memory.put(request), await memory.put(request));
  assert.equal((await store.read()).jobs.length, 1); assert.equal((await memory.delta()).changes.length, 1);
});
test("delta paging does not lose simultaneous writes", async t => {
  const { memory } = setup(t);
  await Promise.all(Array.from({ length: 12 }, (_, i) => memory.put({ requestId: `r${i}`, expectedRevision: null, item: item(`id${i}`) })));
  let cursor = 0, count = 0, more;
  do { const page = await memory.delta(cursor, 3); count += page.changes.length; cursor = page.cursor; more = page.hasMore; } while (more);
  assert.equal(count, 12); assert.equal(cursor, 12);
});
test("generated L0/L1 does not replace full evidence", async t => {
  const { memory } = setup(t), source = item("a"); await memory.put({ requestId: "r1", expectedRevision: null, item: source });
  const stats = await memory.enrich({ modelId: "test", async extract(input) {
    assert.equal(input.text, source.full);
    return { abstract: "数据库选型", overview: "已记录的数据库选择：PostgreSQL。", facts: [{ text: "选择 PostgreSQL", quote: "使用 PostgreSQL" }] };
  } }, { signal: new AbortController().signal });
  assert.equal(stats.completed, 1);
  const stored = await memory.get("project:p", "a");
  assert.equal(stored.abstract, "数据库选型"); assert.equal(stored.full, source.full); assert.equal(stored.revision, 1);
});
test("withdrawal while an extractor runs cannot resurrect memory", async t => {
  const { memory, store } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  let release, started; const ready = new Promise(r => { started = r; });
  const job = memory.enrich({ modelId: "test", extract() { started(); return new Promise(r => { release = r; }); } }, { signal: new AbortController().signal });
  await ready; await memory.withdraw("withdraw", "project:p", "a", 1);
  release({ abstract: "数据库", overview: "使用 PostgreSQL", facts: [] });
  assert.equal((await job).obsolete, 1); assert.equal(await memory.get("project:p", "a"), undefined);
  assert.equal(Object.keys((await store.read()).projections).length, 0);
});
test("fabricated extraction quotations fail closed", async t => {
  const { memory } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const outcome = await memory.enrich({ modelId: "test", async extract() { return { abstract: "bad", overview: "bad", facts: [{ text: "invented", quote: "not in source" }] }; } }, { signal: new AbortController().signal });
  assert.equal(outcome.failed, 1); assert.equal((await memory.get("project:p", "a")).abstract, item("a").abstract);
});
test("other project cannot search, list or receive delta", async t => {
  const { store, memory } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const other = new LayeredMemory(store, { ...principal, readScopes: ["project:q"], writeScopes: ["project:q"] });
  assert.equal((await other.search("PostgreSQL")).length, 0);
  assert.deepEqual((await other.list("project:p")).items, []); assert.equal((await other.delta()).changes.length, 0);
});
