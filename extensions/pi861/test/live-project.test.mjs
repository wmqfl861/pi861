import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStateStore } from "../src/live/store.ts";
import { ProjectCoordinator,emptyProject } from "../src/live/coordinator.ts";
import { ProjectRunner } from "../src/live/project-runner.ts";
import { Workspaces } from "../src/live/workspace.ts";
const exec=promisify(execFile);
const spec=id=>({task:{id,title:id,dependsOn:id==="C"?["A"]:[],writeScopes:[`${id.toLowerCase()}.txt`],capabilities:[],acceptance:["Candidate check succeeds"]},execution:{instructions:`implement ${id}`,roleId:"dev",modelId:"test",checkIds:["verify"]}});
async function repo(){const root=await mkdtemp(join(tmpdir(),"pi861-project-"));const path=join(root,"repo");await mkdir(path);await exec("git",["init",path]);await writeFile(join(path,"README"),"fixture\n");await exec("git",["add","README"],{cwd:path});await exec("git",["-c","user.name=Test","-c","user.email=test@localhost","commit","-m","base"],{cwd:path});return {root,path};}
test("actual child processes refill before unrelated slow job, then verify and integrate",async()=>{
 const {root,path}=await repo();
 try{
 const workspace=new Workspaces(path,join(root,"trees"));const base=await workspace.head();
 const coordinator=new ProjectCoordinator(new FileStateStore(join(root,"state.json"),emptyProject("fixture")),{maxConcurrent:2,maxAttempts:2});
 await coordinator.create("fixture goal",base,[spec("A"),spec("B"),spec("C")]);
 const trace=join(root,"trace");const events=[];const integration=await workspace.create("integration",1,base);
 const runner=new ProjectRunner({coordinator,workspaces:workspace,integration,checks:[{id:"verify",command:process.execPath,args:["-e","if(!require('fs').existsSync('README'))process.exit(1)"]}],
 workers:[0,1].map(id=>({identity:{id:`w${id}`,capabilities:[],roleIds:["dev"],modelIds:["test"]},process:ws=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:ws.path,env:{TRACE:trace}})})),onProgress:e=>events.push(`${e.taskId}:${e.state}`)});
 await runner.start();
 assert.equal((await coordinator.state()).status,"review");assert.ok(events.indexOf("C:running")<events.indexOf("B:done"),events.join(","));
 assert.equal(await readFile(join(integration.path,"c.txt"),"utf8"),"C");assert.equal(await workspace.head(),base,"main must remain unchanged");
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
