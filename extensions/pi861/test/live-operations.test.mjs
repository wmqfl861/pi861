import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationJournal } from "../src/live/operations.ts";
import { FileStateStore } from "../src/live/store.ts";
import { McpFailure } from "../src/live/mcp.ts";
const intent={requestId:"one",principal:"role",resource:"database/row",fingerprint:"hash",readOnly:false};
test("stable business operation survives changed session request ids without redispatch", async t => {
 const dir = await mkdtemp(join(tmpdir(), "pi861-business-op-"));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const path = join(dir, "state.json");
 const journal = () => new OperationJournal(new FileStateStore(path, { receipts: {} }));
 let count = 0;
 const business = { ...intent, operationId: "approve-row-42" };
 const first = await journal().run(business, async () => ({ count: ++count }));
 const second = await journal().run({ ...business, requestId: "another-session-call" }, async () => ({ count: ++count }));
 assert.deepEqual(second, first); assert.equal(count, 1);
 await assert.rejects(journal().run({ ...business, requestId: "changed", fingerprint: "different" }, async () => ({})), /idempotency conflict/);
 await assert.rejects(journal().run({ ...business, operationId: "changed-operation" }, async () => ({})), /idempotency conflict/);
});
test("stable business unknown outcome requires reconciliation before a fresh attempt", async t => {
 const dir = await mkdtemp(join(tmpdir(), "pi861-business-unknown-"));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const journal = new OperationJournal(new FileStateStore(join(dir, "state.json"), { receipts: {} }));
 const business = { ...intent, operationId: "business-unknown" }; let calls = 0;
 await assert.rejects(journal.run(business, async () => { calls++; throw new McpFailure("lost receipt", "unknown"); }));
 await assert.rejects(journal.run({ ...business, requestId: "retry" }, async () => { calls++; return {}; }), /unresolved/);
 assert.equal(calls, 1);
 await journal.resolve("role", "one", "Fixture provider confirmed no write occurred");
 await journal.run({ ...business, requestId: "retry" }, async () => { calls++; return { done: true }; });
 assert.equal(calls, 2);
 assert.equal((await journal.list("role")).find(item => item.requestId === "retry").operationId, "business-unknown");
});
test("operation receipt replays committed result, rejects changed intent, survives reopen",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pi861-op-"));try{
 let count=0;const path=join(dir,"state.json"),create=()=>new OperationJournal(new FileStateStore(path,{receipts:{}}));
 assert.deepEqual(await create().run(intent,async()=>{count++;return {id:1};}),{id:1});
 assert.deepEqual(await create().run(intent,async()=>{count++;return {id:2};}),{id:1});assert.equal(count,1);
 await assert.rejects(()=>create().run({...intent,fingerprint:"other"},async()=>{}),/idempotency/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test("unknown side effect blocks equivalent fresh call until trusted reconciliation",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"pi861-op-"));try{
 const journal=new OperationJournal(new FileStateStore(join(dir,"state.json"),{receipts:{}}));let count=0;
 await assert.rejects(()=>journal.run(intent,async()=>{count++;throw new McpFailure("response lost","unknown");}));
 await assert.rejects(()=>journal.run({...intent,requestId:"two"},async()=>{count++;}),/unresolved/);assert.equal(count,1);
 await journal.resolve("role","one","Queried provider request status and confirmed the operation did not commit");
 await journal.run({...intent,requestId:"two"},async()=>{count++;return {done:true};});assert.equal(count,2);
 assert.equal((await journal.list("other")).length,0);
 }finally{await rm(dir,{recursive:true,force:true});}
});

// ---------------------------------------------------------------------------
// P2-S additions: C5 OperationLedger integration. Stable business ids now bind
// the full C5 tool identity, decisive server errors record as failed (not
// unknown), and the frozen contract's status view is derived from the receipts.
// ---------------------------------------------------------------------------

const tool = (over = {}) => ({ serviceId: "crm", toolName: "submit", accountId: "acct", resourceId: "row-42", schemaDigest: "s1", ...over });

test("C5: a stable business id binds the full tool identity; content drift conflicts", async t => {
 const dir = await mkdtemp(join(tmpdir(), "pi861-c5-tool-"));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const path = join(dir, "state.json");
 const journal = () => new OperationJournal(new FileStateStore(path, { receipts: {} }));
 const base = { ...intent, operationId: "approve-row-42", tool: tool() };
 await journal().run(base, async () => ({ ok: 1 }));
 // Same business id under a different schema digest is a different operation: refused.
 await assert.rejects(
   journal().run({ ...base, requestId: "again", tool: tool({ schemaDigest: "s2" }) }, async () => ({})),
   /Business operation idempotency conflict/);
 // A different tool on the same account is likewise a conflict, not a silent second dispatch.
 await assert.rejects(
   journal().run({ ...base, requestId: "third", tool: tool({ toolName: "delete" }) }, async () => ({})),
   /Business operation idempotency conflict/);
 // Incomplete tool identities never enter the ledger path.
 await assert.rejects(journal().run({ ...base, requestId: "bad", tool: { serviceId: "x" } }, async () => ({})), /C5 tool identity/);
});

test("C5: reported server errors are decisively failed, not unknown; explicit retry dispatches", async t => {
 const dir = await mkdtemp(join(tmpdir(), "pi861-c5-failed-"));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const journal = new OperationJournal(new FileStateStore(join(dir, "state.json"), { receipts: {} }));
 const business = { ...intent, operationId: "submit-report", tool: tool() };
 let calls = 0;
 await assert.rejects(journal.run(business, async () => {
   calls++;
   throw new McpFailure("server rejected the arguments", "reported_error");
 }));
 const failed = (await journal.list("role")).find(item => item.requestId === "one");
 assert.equal(failed.state, "failed");
 assert.equal((await journal.businessSnapshot())[0].status, "failed");
 // Failed does not block: a fresh explicit intent re-dispatches the same business id. But an
 // unknown outcome on the way blocks everything equivalent until trusted reconciliation.
 await assert.rejects(journal.run({ ...business, requestId: "retry-unknown" }, async () => {
   throw new McpFailure("stream cut", "unknown");
 }));
 await assert.rejects(journal.run({ ...business, requestId: "retry-explicit" }, async () => {
   calls++;
 }), /unresolved/);
 await journal.resolve("role", "retry-unknown", "provider confirmed nothing was written");
 const retried = await journal.run({ ...business, requestId: "retry-explicit" }, async () => {
   calls++;
   return { done: true };
 });
 assert.deepEqual(retried, { done: true });
 assert.equal(calls, 2);
 // The C5 view finalizes the business id as succeeded once any receipt commits.
 const snapshot = await journal.businessSnapshot();
 assert.equal(snapshot.length, 1);
 assert.equal(snapshot[0].operationId, "submit-report");
 assert.equal(snapshot[0].status, "succeeded");
 assert.equal(typeof snapshot[0].resultDigest, "string");
 assert.deepEqual(snapshot[0].tool, tool());
});

test("C5: derived business statuses follow the frozen contract's vocabulary", async t => {
 const dir = await mkdtemp(join(tmpdir(), "pi861-c5-view-"));
 t.after(() => rm(dir, { recursive: true, force: true }));
 const path = join(dir, "state.json");
 const read = async () => (await new OperationJournal(new FileStateStore(path, { receipts: {} })).businessSnapshot());
 const mk = (over) => ({ ...intent, tool: tool(), ...over });

 // not_dispatched derives to prepared (retryable) and stays out of the blocking set.
 const notRun = new OperationJournal(new FileStateStore(path, { receipts: {} }));
 await assert.rejects(notRun.run(mk({ requestId: "n1", operationId: "never-sent" }), async () => {
   throw new McpFailure("guard refused before dispatch", "not_dispatched");
 }));
 assert.equal((await read()).find(item => item.operationId === "never-sent").status, "prepared");

 // unknown blocks until trusted reconciliation; the resolved view keeps reconciled semantics.
 const unknown = new OperationJournal(new FileStateStore(path, { receipts: {} }));
 await assert.rejects(unknown.run(mk({ requestId: "l1", operationId: "lost" }), async () => {
   throw new McpFailure("receipt lost", "unknown");
 }));
 assert.equal((await read()).find(item => item.operationId === "lost").status, "unknown");
 await assert.rejects(unknown.run(mk({ requestId: "l2", operationId: "lost" }), async () => ({})), /unresolved/);
 await unknown.resolve("role", "l1", "provider confirmed nothing was written");
 const lost = (await read()).find(item => item.operationId === "lost");
 assert.equal(lost.status, "unknown");
 assert.equal(lost.reconciled, true);
 // After reconciliation a fresh intent for the same business id may proceed.
 const fresh = new OperationJournal(new FileStateStore(path, { receipts: {} }));
 await fresh.run(mk({ requestId: "fresh", operationId: "lost" }), async () => ({ ok: 2 }));
 assert.equal((await read()).find(item => item.operationId === "lost").status, "succeeded");

 // Receipts without a C5 tool identity never appear in the business view.
 const bare = new OperationJournal(new FileStateStore(path, { receipts: {} }));
 await bare.run({ ...intent, requestId: "bare" }, async () => ({ ok: 3 }));
 const view = await read();
 assert.ok(view.every(item => item.tool));
});
