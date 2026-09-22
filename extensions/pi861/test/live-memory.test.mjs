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
  assert.equal((await other.assemble()).included.length, 0);
});
test("transient extraction failure backs off and recovers on a later wake", async t => {
  const { memory, store } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  let calls = 0;
  const extractor = { modelId: "test", async extract() { calls++; if (calls === 1) throw new Error("HTTP 429 rate limit"); return { abstract: "数据库选型", overview: "使用 PostgreSQL。", facts: [] }; } };
  const first = await memory.enrich(extractor, { signal: new AbortController().signal, backoffBaseMs: 200 });
  assert.equal(first.failed, 1); assert.equal(first.completed, 0);
  const parked = (await store.read()).jobs[0];
  assert.equal(parked.state, "queued"); assert.equal(parked.failures, 1); assert.equal(parked.failureClass, "transient");
  assert.ok(parked.nextAttemptAt > Date.now());
  const blocked = await memory.enrich(extractor, { signal: new AbortController().signal, backoffBaseMs: 200 });
  assert.equal(blocked.completed + blocked.failed, 0);
  await new Promise(resolve => setTimeout(resolve, 250));
  const second = await memory.enrich(extractor, { signal: new AbortController().signal, backoffBaseMs: 200 });
  assert.equal(second.completed, 1);
  assert.equal((await store.read()).jobs[0].state, "done");
  assert.equal((await memory.get("project:p", "a")).abstract, "数据库选型");
});
test("exhausted transient failures park the job for manual requeue", async t => {
  const { memory, store } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const failing = { modelId: "test", async extract() { throw new Error("HTTP 503 unavailable"); } };
  const outcome = await memory.enrich(failing, { signal: new AbortController().signal, backoffBaseMs: 0, maxJobs: 10 });
  assert.equal(outcome.failed, 3);
  const job = (await store.read()).jobs[0];
  assert.equal(job.state, "failed"); assert.equal(job.failures, 3); assert.equal(job.failureClass, "transient");
  const good = { modelId: "test", async extract() { return { abstract: "late", overview: "late overview", facts: [] }; } };
  const ignored = await memory.enrich(good, { signal: new AbortController().signal });
  assert.equal(ignored.completed + ignored.failed, 0);
  await memory.requeueJob(job.id);
  const recovered = await memory.enrich(good, { signal: new AbortController().signal });
  assert.equal(recovered.completed, 1);
  const view = (await memory.listJobs()).find(entry => entry.id === job.id);
  assert.equal(view.state, "done"); assert.equal(view.requeues, 1); assert.equal(view.failures, 0);
});
test("invalid extraction output fails once and is never retried", async t => {
  const { memory, store } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const extractor = { modelId: "test", async extract() { return { abstract: "bad", overview: "bad", facts: [{ text: "invented", quote: "not in source" }] }; } };
  const outcome = await memory.enrich(extractor, { signal: new AbortController().signal, backoffBaseMs: 0 });
  assert.equal(outcome.failed, 1);
  const job = (await store.read()).jobs[0];
  assert.equal(job.state, "failed"); assert.equal(job.failures, 1); assert.equal(job.failureClass, "invalid_output");
  await assert.rejects(memory.requeueJob("missing"), /Unknown enrichment job/);
});
test("operator abort releases the lease without consuming the retry budget", async t => {
  const { memory, store } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  const controller = new AbortController();
  const run = memory.enrich({ modelId: "test", extract() { controller.abort(); throw new Error("cancelled run"); } }, { signal: controller.signal });
  await assert.rejects(run);
  const job = (await store.read()).jobs[0];
  assert.equal(job.state, "queued"); assert.equal(job.attempts, 1); assert.equal(job.failures, 0);
  const done = await memory.enrich({ modelId: "test", async extract() { return { abstract: "after abort", overview: "after abort overview", facts: [] }; } }, { signal: new AbortController().signal });
  assert.equal(done.completed, 1);
});
test("an expired running lease is reclaimed by the next wake", async t => {
  const { memory, store } = setup(t); await memory.put({ requestId: "r1", expectedRevision: null, item: item("a") });
  await store.update(state => { const job = state.jobs[0]; job.state = "running"; job.attempts = 1; job.token = "stale"; job.expiresAt = Date.now() - 1000; });
  const outcome = await memory.enrich({ modelId: "test", async extract(input) { return { abstract: "reclaimed", overview: "reclaimed overview", facts: [{ text: input.text, quote: input.text }] }; } }, { signal: new AbortController().signal, maxJobs: 1 });
  assert.equal(outcome.completed, 1);
  assert.equal((await memory.get("project:p", "a")).abstract, "reclaimed");
});
test("terminal jobs and the change log are governed to bounded retention", async t => {
  const dir = mkdtempSync(join(tmpdir(), "pi861-memory-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new FileStateStore(join(dir, "memory.json"), emptyLayeredMemory("t"));
  const memory = new LayeredMemory(store, principal, { retention: { maxTerminalJobs: 2, maxChanges: 5 } });
  for (let index = 0; index < 7; index++) await memory.put({ requestId: `r${index}`, expectedRevision: null, item: item(`id${index}`) });
  const outcome = await memory.enrich({ modelId: "test", async extract(input) { return { abstract: "summary", overview: "overview text", facts: [] }; } }, { signal: new AbortController().signal, maxJobs: 10 });
  assert.equal(outcome.completed, 7);
  const state = await store.read();
  assert.equal(state.jobs.length, 2);
  assert.ok(state.jobs.every(job => job.state === "done" || job.state === "obsolete" || job.state === "failed"));
  assert.ok(state.changes.length <= 5);
  const floor = state.changesFloor ?? 0;
  assert.ok(floor > 0);
  await assert.rejects(memory.delta(0, 100), /retention floor/);
  const page = await memory.delta(floor, 100);
  assert.ok(page.changes.length > 0); assert.ok(page.changes.every(change => change.sequence > floor));
});
test("assembly installs constraints and working state without keyword recall", async t => {
  const { memory } = setup(t);
  await memory.put({ requestId: "rc", expectedRevision: null, item: { ...item("c"), kind: "constraint", full: "Always parameterize SQL; never concatenate user input into queries.", abstract: "SQL 安全规则", overview: "SQL 安全规则" } });
  await memory.put({ requestId: "rw", expectedRevision: null, item: { ...item("w"), kind: "working", full: "正在修复 enrich 重试逻辑。", abstract: "", overview: "" } });
  await memory.put({ requestId: "re", expectedRevision: null, item: { ...item("e"), kind: "experience", full: "x".repeat(3000), abstract: "long experience abstract", overview: "long experience overview" } });
  const pack = await memory.assemble({ maxBytes: 5000 });
  assert.deepEqual(pack.included.map(entry => entry.kind), ["constraint", "working", "experience"]);
  assert.equal(pack.included[0].level, 2); assert.equal(pack.included[1].level, 1); assert.equal(pack.included[2].level, 0);
  assert.ok(pack.text.includes("never concatenate"));
  assert.ok(pack.text.includes("正在修复 enrich 重试逻辑。"));
  assert.ok(pack.text.includes("long experience abstract"));
  assert.ok(!pack.text.includes("x".repeat(100)));
  const lines = pack.text.split("\n").map(line => JSON.parse(line));
  assert.equal(lines[0].kind, "constraint");
  const tight = await memory.assemble({ maxBytes: Buffer.byteLength(pack.text.split("\n")[0], "utf8") });
  assert.deepEqual(tight.included.map(entry => entry.kind), ["constraint"]);
  assert.equal(tight.omitted, 2);
});
test("withdrawal invalidates assembly, search, jobs and re-ingestion together", async t => {
  const { memory } = setup(t);
  const constraint = { ...item("c"), kind: "constraint", full: "Always parameterize SQL; never concatenate user input.", abstract: "SQL 安全规则", overview: "SQL 安全规则" };
  await memory.put({ requestId: "rc", expectedRevision: null, item: constraint });
  await memory.withdraw("w1", "project:p", "c", 1);
  assert.equal((await memory.assemble()).included.length, 0);
  assert.equal((await memory.search("parameterize")).length, 0);
  assert.ok((await memory.listJobs()).every(job => job.state === "obsolete"));
  await assert.rejects(memory.put({ requestId: "r2", expectedRevision: null, item: { ...item("z"), kind: "constraint", full: constraint.full } }), /Withdrawn/);
});
