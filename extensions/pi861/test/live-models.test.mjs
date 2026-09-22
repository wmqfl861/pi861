import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ModelRuntime, RequestBudget } from "../src/live/model-runtime.ts";
import { ModelFailure } from "../src/routing.ts";
const targets = [
 {id:"cheap",revision:"1",provider:"test",model:"cheap",quality:1,costRank:1,contextWindow:10000,capabilities:["tools"],enabled:true},
 {id:"strong",revision:"1",provider:"test",model:"strong",quality:3,costRank:3,contextWindow:10000,capabilities:["tools"],enabled:true},
];
function policy(patch={}) {return {targets,preferred:"cheap",requirements:{minQuality:1,contextTokens:100,capabilities:["tools"],allowedIds:["cheap","strong"]},recovery:{failoverEnabled:true,failbackEnabled:true,probeIntervalMs:20,maxProbeIntervalMs:100,requiredProbeSuccesses:2},maxAttempts:3,requestTimeoutMs:500,maxRequests:20,maxProbeRequests:5,...patch};}
const signal=()=>new AbortController().signal;
test("fixed route classifies once then escalates on a concrete gap",async()=>{
 let classifications=0; const seen=[];
 const runtime=new ModelRuntime(policy(),async m=>{seen.push(m.id);return m.id;},async()=>true,{classify:async()=>{classifications++;return {mode:"fixed",targetId:"cheap",minQuality:1,reason:"stable"};}});
 try {runtime.setTask("stable task");await runtime.call({},signal());await runtime.call({},signal());assert.equal(classifications,1);
 runtime.report("capability_gap");await runtime.call({},signal());assert.deepEqual(seen,["cheap","cheap","strong"]);assert.equal(runtime.state.preferred,"strong");}
 finally{runtime.close();}
});
test("failover holds the original goal and auto failback waits for next inference",async()=>{
 let broken=true; const seen=[];
 const runtime=new ModelRuntime(policy(),async m=>{seen.push(m.id);if(m.id==="cheap"&&broken)throw new ModelFailure("transient");return m.id;},async()=>true);
 try {assert.equal(await runtime.call({},signal()),"strong");assert.equal(runtime.state.preferred,"cheap");broken=false;
 await runtime.checkRecovery(Date.now()+500);await runtime.checkRecovery(Date.now()+1000);assert.equal(runtime.state.active,"strong");
 assert.equal(await runtime.call({},signal()),"cheap");assert.deepEqual(seen,["cheap","strong","cheap"]);}
 finally{runtime.close();}
});
test("disabled failover never calls backup",async()=>{
 const p=policy();p.recovery.failoverEnabled=false;let calls=0;
 const runtime=new ModelRuntime(p,async()=>{calls++;throw new ModelFailure("transient");},async()=>true);
 try{await assert.rejects(runtime.call({},signal()));assert.equal(calls,1);}finally{runtime.close();}
});
test("disabled failback issues no probes",async()=>{
 const p=policy();p.recovery.failbackEnabled=false;let probes=0;
 const runtime=new ModelRuntime(p,async m=>{if(m.id==="cheap")throw new ModelFailure("transient");return m.id;},async()=>{probes++;return true;});
 try{await runtime.call({},signal());await runtime.checkRecovery(Date.now()+1000);await sleep(25);assert.equal(probes,0);}finally{runtime.close();}
});
test("cancellation never starts backup",async()=>{
 const p=policy({requestTimeoutMs:30});const ac=new AbortController();let calls=0;
 const runtime=new ModelRuntime(p,async()=>{calls++;await sleep(100);return "late";},async()=>new Promise(()=>{}));
 const running=runtime.call({},ac.signal);setTimeout(()=>ac.abort(),5);
 try{await assert.rejects(running);assert.equal(calls,1);}finally{runtime.close();}
});
test("global request allowance is atomic and idempotent",async()=>{
 const state={limit:2,used:0,intents:{}};let tail=Promise.resolve();
 const store={read:async()=>structuredClone(state),update(fn){const result=tail.then(()=>fn(state));tail=result.catch(()=>{});return result;}};
 const a=new RequestBudget(store),b=new RequestBudget(store);
 await Promise.all([a.reserve("same"),b.reserve("same")]);assert.equal(state.used,1);await a.reserve("second");await assert.rejects(b.reserve("third"));assert.equal(state.used,2);
});
test("backup state and request accounting survive a runtime replacement",async()=>{
 const p=policy();p.recovery.failbackEnabled=false;
 const first=new ModelRuntime(p,async m=>{if(m.id==="cheap")throw new ModelFailure("transient");return m.id;},async()=>true);
 first.setTask("persistent task");await first.call({},signal());const checkpoint=first.checkpoint;first.close();
 const second=new ModelRuntime(p,async m=>m.id,async()=>true);
 try{second.restore(checkpoint);second.setTask("persistent task");assert.equal(second.state.active,"strong");assert.equal(second.state.requests,2);assert.equal(await second.call({},signal()),"strong");assert.equal(second.state.requests,3);}finally{second.close();}
});
