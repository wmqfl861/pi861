import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperationJournal } from "../src/live/operations.ts";
import { FileStateStore } from "../src/live/store.ts";
import { McpFailure } from "../src/live/mcp.ts";
const intent={requestId:"one",principal:"role",resource:"database/row",fingerprint:"hash",readOnly:false};
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
