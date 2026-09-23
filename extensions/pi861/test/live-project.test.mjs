import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStateStore } from "../src/live/store.ts";
import { ProjectCoordinator,emptyProject } from "../src/live/coordinator.ts";
import { ProjectRunner,InProcessWakeChannel } from "../src/live/project-runner.ts";
import { Workspaces } from "../src/live/workspace.ts";
const exec=promisify(execFile);
const spec=id=>({task:{id,title:id,dependsOn:id==="C"?["A"]:[],writeScopes:[`${id.toLowerCase()}.txt`],capabilities:[],acceptance:["Candidate check succeeds"]},execution:{instructions:`implement ${id}`,roleId:"dev",modelId:"test",checkIds:id==="B"?["verify","slow-verify"]:["verify"]}});
async function repo(){const root=await mkdtemp(join(tmpdir(),"pi861-project-"));const path=join(root,"repo");await mkdir(path);await exec("git",["init",path]);await writeFile(join(path,"README"),"fixture\n");await exec("git",["add","README"],{cwd:path});await exec("git",["-c","user.name=Test","-c","user.email=test@localhost","commit","-m","base"],{cwd:path});return {root,path};}
test("actual child processes refill before unrelated slow job, then verify and integrate",async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("fixture goal",base,[spec("A"),spec("B"),spec("C")]);
 const trace=join(root,"trace");const events=[];const integration=await workspace.create("integration",1,base);
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[{id:"verify",command:process.execPath,args:["-e","if(!require('fs').existsSync('README'))process.exit(1)"]},{id:"slow-verify",command:process.execPath,args:["-e","setTimeout(()=>process.exit(0),1500)"]}],
 workers:[0,1].map(id=>({identity:{id:`w${id}`,capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path,env:{TRACE:trace}})})),onProgress:e=>events.push(`${e.taskId}:${e.state}`)});
 await runner.start();
 assert.equal((await coordinator.state()).status,"review");assert.ok(events.indexOf("C:running")<events.indexOf("B:done"),events.join(","));
 assert.equal(await readFile(join(integration.path,"c.txt"),"utf8"),"C");assert.equal(await workspace.head(),base,"main must remain unchanged");
 // AX1 barrier record: A.accepted < C.started < B.finished, observed on durable state events
 // (stage records and recorded evidence), not on the model's self-reported task text.
 const final=await coordinator.state();
 const acceptedAt=id=>final.evidence.find(e=>e.kind==="behavioral-check"&&e.taskId===id).at;
 const startedAt=id=>final.stages.find(s=>s.taskId===id&&s.kind==="execution"&&s.status==="started").at;
 assert.ok(acceptedAt("A")<startedAt("C"),`A.accepted(${acceptedAt("A")}) must precede C.started(${startedAt("C")})`);
 assert.ok(startedAt("C")<acceptedAt("B"),`C.started(${startedAt("C")}) must precede B.finished(${acceptedAt("B")})`);
 // C7: every done task carries structural (trusted checker) and behavioral (verifier) evidence;
 // the model's submit alone produced neither completion nor evidence.
 for(const id of ["A","B","C"]){
  assert.ok(final.evidence.some(e=>e.kind==="structural-check"&&e.taskId===id&&e.detail[0]==="stage:candidate"),`structural evidence for ${id}`);
  assert.ok(final.evidence.some(e=>e.kind==="structural-check"&&e.taskId===id&&e.detail[0]==="stage:integration"),`integration evidence for ${id}`);
 }
 await coordinator.control("accept");assert.equal((await coordinator.state()).status,"completed");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("task ownership, role/model matching and versioned append are enforced",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-coordinator-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("goal","a".repeat(40),[spec("A")]);
 assert.equal(await coordinator.claim({id:"bad",capabilities:[],roleIds:["reader"],modelIds:["test"]},"bad"),null);
 const worker={id:"good",capabilities:[],roleIds:["dev"],modelIds:["test"]};const claim=await coordinator.claim(worker,"claim");
 assert.deepEqual(await coordinator.claim(worker,"claim"),claim);await assert.rejects(coordinator.submit("bad",claim.task.lease,["x"],"s"));
 await assert.rejects(coordinator.append([spec("B")],0));await coordinator.submit("good",claim.task.lease,["x"],"s");
 assert.equal((await coordinator.state()).board.tasks[0].status,"review");
 await coordinator.verify(claim.task.lease,{accepted:true,evidence:["verified"]},"v");assert.equal((await coordinator.state()).status,"review");
 }finally{await rm(root,{recursive:true,force:true});}
});
test("scope check rejects out of module changes",async()=>{const {root,path}=await repo();try{
 const service=new Workspaces(path,join(root,"trees"));const ws=await service.create("scopes",1,await service.head());await writeFile(join(ws.path,"outside.txt"),"x");await assert.rejects(service.changed(ws,["module"]),/unreserved/);
 }finally{await rm(root,{recursive:true,force:true});}});
test("AX1: append and unblock wake the resident runner without rebuilding it",async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:3});
 const failSpec=id=>({task:{...spec(id).task,retrySafe:true},execution:spec(id).execution});
 await coordinator.create("fixture goal",base,[spec("A"),failSpec("F")],{sealed:false});
 const events=[];const integration=await workspace.create("integration",1,base);
 const wake=new InProcessWakeChannel();
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[{id:"verify",command:process.execPath,args:["-e","if(!require('fs').existsSync('README'))process.exit(1)"]}],
	 workers:[{identity:{id:"w0",capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path,env:{TRACE:join(root,"trace"),PI861_FIXTURE_MARKDIR:root,PI861_FIXTURE_FAIL_ONCE:"F"}})}],
	 idle:"hold",wake,maintenanceMs:250,onProgress:e=>events.push(`${e.taskId}:${e.state}`)});
 const settled=runner.start();
 const statusOf=async(id,expected)=>{for(let i=0;i<400;i++){const task=(await coordinator.state()).board.tasks.find(t=>t.id===id);if(task?.status===expected)return task.status;await setTimeout(25);}throw new Error(`timeout waiting for ${id}:${expected}`);};
 try {
 assert.equal(await statusOf("F","blocked"),"blocked");assert.equal(await statusOf("A","done"),"done");
 // A separate coordinator appends while this runner is idle. No local wake call is needed.
 const other=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:3});
 await other.append([spec("D")],(await other.state()).goal.planVersion,{sealed:true,requestId:"append-D"});
 assert.equal(await statusOf("D","done"),"done");
 await other.unblock("F","unblock-F","operator resolved the fixture failure");
 assert.equal(await statusOf("F","done"),"done");
 const final=await coordinator.state();assert.equal(final.status,"review");
 assert.ok(events.indexOf("D:running")>events.indexOf("A:done"),events.join(","));
 } finally { await runner.pause();await settled; }
 }finally{await rm(root,{recursive:true,force:true});}});
test("pause returns retry-safe in-flight work to the queue instead of blocking it",async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:1,maxAttempts:2});
 await coordinator.create("fixture goal",base,[{task:{...spec("P").task,retrySafe:true},execution:spec("P").execution}]);
 const trace=join(root,"trace");const integration=await workspace.create("integration",1,base);
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[{id:"verify",command:process.execPath,args:["-e","process.exit(0)"]}],
	 workers:[{identity:{id:"w0",capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path,env:{TRACE:trace,PI861_FIXTURE_MARKDIR:root,PI861_FIXTURE_DELAY_ONCE:"P:800"}})}]});
 const settled=runner.start();
 for(let i=0;i<200&&!existsSync(trace);i++)await setTimeout(10); // task P is mid-flight
 await runner.pause();
 const paused=(await coordinator.state()).board.tasks.find(t=>t.id==="P");
 assert.equal(paused.status,"queued");assert.match(paused.reason,/Requeued after pause/);
 await coordinator.control("resume");await runner.start();await settled;
 const final=await coordinator.state();assert.equal(final.status,"review");assert.equal(final.board.tasks.find(t=>t.id==="P").status,"done");
 }finally{await rm(root,{recursive:true,force:true});}});
test("expired ghost leases recover through the maintenance loop, not only claims",async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("fixture goal",base,[{task:{...spec("R").task,retrySafe:true},execution:spec("R").execution}]);
 // A dead coordinator's claim: lease never renewed, task stuck running.
 const ghost=await coordinator.claim({id:"ghost",capabilities:[],roleIds:["dev"],modelIds:["test"]},"ghost-1",250);
 assert.ok(ghost);
 const integration=await workspace.create("integration",1,base);
 const wake=new InProcessWakeChannel();
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[{id:"verify",command:process.execPath,args:["-e","process.exit(0)"]}],
	 workers:[{identity:{id:"w0",capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path})}],
	 idle:"hold",wake,maintenanceMs:150,leaseMs:30_000});
 const settled=runner.start();
 for(let i=0;i<200;i++){const task=(await coordinator.state()).board.tasks.find(t=>t.id==="R");if(task?.status==="done")break;await setTimeout(50);}
 const final=await coordinator.state();assert.equal(final.status,"review");
 const task=final.board.tasks.find(t=>t.id==="R");assert.equal(task.status,"done");assert.equal(task.attempts,2);
 await runner.pause();await settled;
 }finally{await rm(root,{recursive:true,force:true});}});
test("AX2: unverified or rejected dependency work never unlocks dependents",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-ax2-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("goal","a".repeat(40),[spec("A"),spec("C")]);
 const worker={id:"good",capabilities:[],roleIds:["dev"],modelIds:["test"]};
 const claim=await coordinator.claim(worker,"c1");
 assert.equal(claim.task.id,"A");
 await coordinator.submit("good",claim.task.lease,["artifact:a"],"s1");
 // Submitted-but-unverified: dependent work stays locked.
 assert.equal(await coordinator.claim(worker,"c2"),null);
 await coordinator.verify(claim.task.lease,{accepted:false,evidence:[],reason:"integration failed"},"v1");
 // Rejected verification blocks A; the dependent remains locked (no completion fact is published).
 const state=await coordinator.state();
 assert.equal(state.board.tasks.find(t=>t.id==="A").status,"blocked");
 assert.equal(await coordinator.claim(worker,"c3"),null);
 }finally{await rm(root,{recursive:true,force:true});}});
test("receipts stay bounded under high-frequency mutations",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-receipts-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2},100,8);
 await coordinator.create("goal","a".repeat(40),[spec("A")]);
 const worker={id:"good",capabilities:[],roleIds:["dev"],modelIds:["test"]};
 for(let i=0;i<30;i++)await coordinator.claim(worker,`noise-${i}`);
 const receipts=(await coordinator.state()).receipts;
 assert.ok(Object.keys(receipts).length<=8);
 // Recent user-level requests still replay idempotently after pruning.
 assert.equal(await coordinator.claim(worker,"noise-29"),null);
 }finally{await rm(root,{recursive:true,force:true});}});
// R3.11 (goal/run/task/attempt workspace identity, Workspaces.createTask) is owned by P2-W and
// not present in this baseline; its collision test moves with that package's published interface.
test("duplicate goals, double resume and double verify are refused",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-controls-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("first goal","a".repeat(40),[spec("A")],{sealed:false});
 await assert.rejects(coordinator.create("second goal","a".repeat(40),[spec("B")]),/unfinished goal/);
 const worker={id:"good",capabilities:[],roleIds:["dev"],modelIds:["test"]};
 const claim=await coordinator.claim(worker,"c1");
 await coordinator.submit("good",claim.task.lease,["artifact:a"],"s1");
 await coordinator.verify(claim.task.lease,{accepted:true,evidence:["verified"]},"v1");
 // Settled attempts cannot settle again: repeated verify is a stale execution lease.
 await assert.rejects(coordinator.verify(claim.task.lease,{accepted:true,evidence:["again"]},"v2"),/Stale or expired execution lease/);
 // Resume of an active goal is refused; only a paused goal may resume.
 await assert.rejects(coordinator.control("resume","r1"),/Only a paused goal may resume/);
 await coordinator.control("pause","p1");
 await coordinator.control("resume","r2");
 await assert.rejects(coordinator.control("resume","r3"),/Only a paused goal may resume/);
 // Each resume issued a fresh run generation; in-flight attempts must converge first.
 const state=await coordinator.state();
 assert.ok(state.goal.generation>=2,`resume must advance the generation, got ${state.goal.generation}`);
 }finally{await rm(root,{recursive:true,force:true});}});
test("AX2: failed review opens a traceable rework chain, then the repair unlocks the original",async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:3});
 // The repair task's fixture writes w-repair-1.txt, so both files stay inside declared scopes.
 const reworkable={task:{...spec("W").task,writeScopes:["w.txt","w-repair-1.txt"]},execution:spec("W").execution};
 await coordinator.create("fixture goal",base,[reworkable]);
 const events=[];const integration=await workspace.create("integration",1,base);
 let reviews=0;
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[{id:"verify",command:process.execPath,args:["-e","if(!require('fs').existsSync('README'))process.exit(1)"]}],
	 workers:[{identity:{id:"w0",capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path})}],
	 reviewerId:"reviewer-1",audit:async(task)=>{reviews++;return task.reworkFor!==undefined;},
	 onProgress:e=>events.push(`${e.taskId}:${e.state}`)});
 await runner.start();
 const final=await coordinator.state();
 // Reviewer != implementer; the first candidate was rejected with recorded evidence.
 assert.ok(reviews>=1);
 const stages=final.stages.filter(s=>s.kind==="review");
 assert.ok(stages.some(s=>s.status==="failed"));
 assert.ok(final.evidence.some(e=>e.kind==="independent-review"&&e.recordedBy==="reviewer-1"));
 // The rework chain is traceable: a repair task names its origin and carries the evidence.
 const repair=final.board.tasks.find(t=>t.reworkFor==="W");
 assert.ok(repair,`repair task for W must exist: ${final.board.tasks.map(t=>t.id).join(",")}`);
 assert.match(repair.id,/^W-repair-/);
 assert.ok(final.execution[repair.id].instructions.includes("Review evidence"));
 // Both the original and its repair are done only after the repair passed verification.
 assert.equal(final.board.tasks.find(t=>t.id==="W").status,"done");
 assert.equal(repair.status,"done");
 assert.equal(final.status,"review");
 assert.ok(events.includes("W:rework"),events.join(","));
 }finally{await rm(root,{recursive:true,force:true});}});
test("durable wake queue records all seven sources and survives restart",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-wakes-"));try{
 const statePath=join(root,"state.json");
 const coordinator=new ProjectCoordinator(new FileStateStore(statePath,emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("goal","a".repeat(40),[spec("A"),spec("C")]);
 const worker={id:"good",capabilities:[],roleIds:["dev"],modelIds:["test"]};
 const claim=await coordinator.claim(worker,"c1");
 await coordinator.submit("good",claim.task.lease,["artifact"],"s1");
 await coordinator.verify(claim.task.lease,{accepted:true,evidence:["verified"]},"v1");
 // acceptance-recorded + dependency-released (C was queued waiting on A).
 // A ghost claim of C expires; maintenance recovers it into blocked (lease-recovered).
 const ghost=await coordinator.claim({id:"ghost",capabilities:[],roleIds:["dev"],modelIds:["test"]},"ghost-1",1);
 assert.ok(ghost);await setTimeout(30);
 assert.equal(await coordinator.maintain(),1);
 const blocked=(await coordinator.state()).board.tasks.find(t=>t.id==="C");
 assert.equal(blocked.status,"blocked");
 await coordinator.unblock("C","test unblock","operator reason");
 await coordinator.control("pause","p1");
 await coordinator.control("resume","r1");
 await coordinator.noteNodeRecovered("worker-node-2");
 const reasons=new Set((await coordinator.pendingWakes()).map(event=>event.reason));
 for(const reason of ["task-finished","acceptance-recorded","dependency-released","plan-appended","node-recovered","manual-unblock","lease-recovered"])
  assert.ok(reasons.has(reason),`missing wake reason ${reason}: ${[...reasons].join(",")}`);
 // The queue is durable: a fresh coordinator instance over the same file still sees the events.
 const restarted=new ProjectCoordinator(new FileStateStore(statePath,emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 assert.equal((await restarted.pendingWakes()).length,(await coordinator.pendingWakes()).length);
 // Drain acknowledges delivery; replaying drain returns nothing until new events arrive.
 const drained=await restarted.drainWakes();
 assert.ok(drained.length>0);
 assert.equal((await restarted.pendingWakes()).length,0);
 assert.equal((await restarted.drainWakes()).length,0);
 }finally{await rm(root,{recursive:true,force:true});}});
test("planning results with unknown references, cycles or unapproved checks are refused",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-planval-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2},100,256,{roleIds:["dev"],modelIds:["test"],checkIds:["verify"]});
 await coordinator.create("goal","a".repeat(40),[spec("A")],{sealed:false});
 // Unapproved check command: the model cannot mint its own validation vocabulary.
 const foreignCheck={task:{...spec("X").task},execution:{instructions:"x",roleId:"dev",modelId:"test",checkIds:["shell"]}};
 await assert.rejects(coordinator.append([foreignCheck],1),/Unapproved task contract/);
 // Unknown dependency reference inside a planner append.
 await assert.rejects(coordinator.append([{task:{...spec("Y").task,dependsOn:["ghost"]},execution:spec("Y").execution}],1),/unknown dependency: ghost/);
 // Dependency cycle inside one append batch.
 const cyclicA={task:{...spec("P").task,dependsOn:["Q"]},execution:spec("P").execution};
 const cyclicB={task:{...spec("Q").task,dependsOn:["P"]},execution:spec("Q").execution};
 await assert.rejects(coordinator.append([cyclicA,cyclicB],1),/dependency cycle/);
 // A cycle through existing board tasks is equally refused.
 await assert.rejects(coordinator.append([{task:{...spec("A2").task,dependsOn:["A2"]},execution:spec("A2").execution}],1),/dependency cycle through A2/);
 // Plan-version CAS: a stale expectedVersion append cannot mutate the board.
 const state=await coordinator.state();
 assert.equal(state.goal.planVersion,1);
 await assert.rejects(coordinator.append([spec("D")],0),/Stale plan version/);
 }finally{await rm(root,{recursive:true,force:true});}});
