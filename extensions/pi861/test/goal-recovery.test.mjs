import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { setTimeout } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStateStore } from "../src/live/store.ts";
import { ProjectCoordinator,emptyProject } from "../src/live/coordinator.ts";
import { ProjectRunner } from "../src/live/project-runner.ts";
import { Workspaces } from "../src/live/workspace.ts";
const exec=promisify(execFile);
const spec=id=>({task:{id,title:id,dependsOn:[],writeScopes:[`${id.toLowerCase()}.txt`],capabilities:[],acceptance:["Candidate check succeeds"]},execution:{instructions:`implement ${id}`,roleId:"dev",modelId:"test",checkIds:["verify"]}});
async function repo(){const root=await mkdtemp(join(tmpdir(),"pi861-recovery-"));const path=join(root,"repo");await mkdir(path);await exec("git",["init",path]);await writeFile(join(path,"README"),"fixture\n");await exec("git",["add","README"],{cwd:path});await exec("git",["-c","user.name=Test","-c","user.email=test@localhost","commit","-m","base"],{cwd:path});return {root,path};}
async function claimAndSubmit(coordinator,taskId){
 const worker={id:"w0",capabilities:[],roleIds:["dev"],modelIds:["test"]};
 for(let i=0;i<50;i++){const claim=await coordinator.claim(worker,`${taskId}-claim`);if(claim&&claim.task.id===taskId){await coordinator.submit("w0",claim.task.lease,["artifact"],`${taskId}-submit`);return claim.task.lease;}}
 throw new Error(`could not claim ${taskId}`);
}
test("AX9: integration lease is mutually exclusive and generations reject stale authorities",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-lease-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("goal","a".repeat(40),[spec("A")]);
 // Two authorities over one durable state: only the first acquisition wins.
 const first=await coordinator.acquireIntegrationLease("runner-1",60_000);
 const second=await coordinator.acquireIntegrationLease("runner-2",60_000);
 assert.ok(first);assert.equal(second,null);assert.equal(first.generation,1);
 // Releasing lets the next authority take over with a fresh generation.
 await coordinator.releaseIntegrationLease("runner-1",first);
 const third=await coordinator.acquireIntegrationLease("runner-2",60_000);
 assert.ok(third);assert.equal(third.generation,2);
 // The old authority can neither refresh nor verify a new base commit.
 await assert.rejects(coordinator.refreshIntegrationLease("runner-1",first,60_000),/authority stale or lost/);
 const lease=await claimAndSubmit(coordinator,"A");
 const staleHead="b".repeat(40);
 await assert.rejects(coordinator.verify(lease,{accepted:true,evidence:["late"]},"late-verify",staleHead,{owner:"runner-1",...first}),/stale/);
 assert.equal((await coordinator.state()).baseCommit,"a".repeat(40));
 // A foreign token on the CURRENT generation is equally rejected.
 await assert.rejects(coordinator.verify(lease,{accepted:true,evidence:["forged"]},"forged-verify",staleHead,{owner:"runner-2",token:"not-the-token",generation:third.generation}),/stale/);
 await coordinator.releaseIntegrationLease("runner-2",third);
 }finally{await rm(root,{recursive:true,force:true});}});
test("AX9: takeover waits out the grace window after lease expiry",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-grace-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("goal","a".repeat(40),[spec("A")]);
 const held=await coordinator.acquireIntegrationLease("runner-1",80,400);
 assert.ok(held);
 await setTimeout(120); // lease expired, but the takeover grace has not
 assert.equal(await coordinator.acquireIntegrationLease("runner-2",60_000,400),null);
 await setTimeout(420); // grace elapsed: takeover proceeds with the next generation
 const taken=await coordinator.acquireIntegrationLease("runner-2",60_000);
 assert.ok(taken);assert.equal(taken.generation,2);
 }finally{await rm(root,{recursive:true,force:true});}});
test("AX9: two runners over one store serialize merges through the persistent lease",async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const store=new FileStateStore(join(root,"state.json"),emptyProject("fixture"));
 const coordinator=new ProjectCoordinator(store,{maxConcurrent:4,maxAttempts:2});
 await coordinator.create("fixture goal",base,[spec("X1"),spec("X2")]);
 const integration=await workspace.create("integration",1,base);
 const events=[];
 const slowCheck={id:"verify",command:process.execPath,args:["-e","setTimeout(()=>process.exit(require('fs').existsSync('README')?0:1),300)"]};
 const makeRunner=(workerId)=>new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[slowCheck],
	 workers:[{identity:{id:workerId,capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path})}],
	 integrationLeaseMs:60_000,onProgress:e=>events.push(`${e.taskId}:${e.state}`)});
 const first=makeRunner("w1").start();
 await setTimeout(50); // let the first runner claim before the second exists (repeat-resume shape)
 const second=makeRunner("w2").start();
 await Promise.all([first,second]);
 const final=await coordinator.state();
 assert.equal(final.status,"review");
 // Both candidates merged into the integration workspace, no merge was lost or duplicated.
 assert.equal(await readFile(join(integration.path,"x1.txt"),"utf8"),"X1");
 assert.equal(await readFile(join(integration.path,"x2.txt"),"utf8"),"X2");
 const merges=(await exec("git",["log","--format=%s"],{cwd:integration.path})).stdout.split("\n").filter(line=>line.includes("Merge"));
 assert.equal(merges.length,2);
 assert.equal(final.baseCommit,(await exec("git",["rev-parse","HEAD"],{cwd:integration.path})).stdout.trim());
 assert.equal(await workspace.head(),base,"main must remain unchanged");
 // Every verification observed the current integration generation: no stale-authority verify succeeded.
 assert.ok(events.includes("X1:done")&&events.includes("X2:done"),events.join(","));
 assert.equal(final.integration.expiresAt,0,"integration authority must be released at rest");
 }finally{await rm(root,{recursive:true,force:true});}});
test("AX9: expired-lease integration takeover refuses to run without a handoff guard",async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("fixture goal",base,[spec("A")]);
 const stale=await coordinator.acquireIntegrationLease("old-runner",80,400);
 assert.ok(stale);
 const integration=await workspace.create("integration",1,base);
 await setTimeout(520); // lease expired and the takeover grace elapsed
 // Without P2-W's process-tree confirmation the runner must freeze the integration resource.
 const refused=new ProjectRunner({coordinator,workspaces:workspace,integration,
	 checks:[{id:"verify",command:process.execPath,args:["-e","process.exit(0)"]}],
	 workers:[{identity:{id:"w0",capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path})}]});
 await refused.start();
 let state=await coordinator.state();
 assert.equal(state.integration.owner,"old-runner","no takeover may occur without confirmation");
 assert.match(state.board.tasks[0].reason,/expired without release/);
 // With the guard confirming the former Git process tree exited, takeover proceeds safely.
 await coordinator.unblock("A","git tree confirmed exited","operator confirmed the old runner exited");
 const confirmed=[];
 const resumed=new ProjectRunner({coordinator,workspaces:workspace,integration,
	 checks:[{id:"verify",command:process.execPath,args:["-e","process.exit(0)"]}],
	 workers:[{identity:{id:"w1",capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path})}],
	 integrationHandoff:{confirmFormerHolderExited:async(former)=>{confirmed.push(former);}}});
 await resumed.start();
 state=await coordinator.state();
 assert.deepEqual(confirmed,[{owner:"old-runner",generation:1}]);
 assert.equal(state.status,"review");
 assert.equal(state.board.tasks[0].status,"done");
 assert.equal(state.integration.expiresAt,0,"released at rest");
 assert.equal(state.integration.generation,2,"takeover advanced the generation");
 }finally{await rm(root,{recursive:true,force:true});}});
test("plan-version CAS: stale planning results and duplicate planning leases are refused",async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-plancas-"));try{
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("goal","a".repeat(40),[spec("A")],{sealed:false});
 assert.equal(await coordinator.reservePlanning("planner-2",99,60_000),null,"unknown plan version cannot reserve");
 const lease=await coordinator.reservePlanning("planner-1",1,60_000);
 assert.ok(lease);
 assert.equal(await coordinator.reservePlanning("planner-2",1,60_000),null,"one planning lease at a time");
 // A concurrent append advances the plan version; the stale planning result is rejected.
 await coordinator.append([spec("Z")],1);
 await assert.rejects(coordinator.finishPlanning(lease,[spec("Y")],true),/Stale planning result/);
 const state=await coordinator.state();
 assert.ok(!state.board.tasks.some(task=>task.id==="Y"),"rejected plan never lands on the board");
 await coordinator.failPlanning(lease,"fixture");
 await assert.rejects(()=>coordinator.finishPlanning(lease,[spec("Y2")],false),/Stale planning result|token/);
 }finally{await rm(root,{recursive:true,force:true});}});
