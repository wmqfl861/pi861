import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,mkdir,writeFile,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FileStateStore } from "../src/live/store.ts";
import { RemoteWorkerServer,RemoteWorkerClient } from "../src/live/remote-worker.ts";
import { Workspaces } from "../src/live/workspace.ts";
const exec=promisify(execFile);
/** Shared harness: one HTTP worker on its own clone; tasks are dispatched directly through the
 * versioned protocol (coordinator-driven scheduling is covered by the scheduler package tests). */
async function withWorker(label,dispatch){
 const root=await mkdtemp(join(tmpdir(),"pi861-remote-"));let server;
 try{
 const source=join(root,"source"),remote=join(root,"node");await mkdir(source);await exec("git",["init",source]);await writeFile(join(source,"README"),"fixture");await exec("git",["add","README"],{cwd:source});await exec("git",["-c","user.name=Test","-c","user.email=test@localhost","commit","-m","base"],{cwd:source});await exec("git",["clone",source,remote]);
 const ws=new Workspaces(source,join(root,"controller-trees"));const remoteWs=new Workspaces(remote,join(root,"remote-trees"));const base=await ws.head();
 const check={id:"verify",command:process.execPath,args:["-e","if(!require('fs').existsSync('a.txt'))process.exit(1)"]};
 const identity={id:"node-1",capabilities:[],roleIds:["dev"],modelIds:["fixture"]};const token="local-test-only-"+"x".repeat(32);
 server=new RemoteWorkerServer(new FileStateStore(join(root,"remote-state.json"),{jobs:[]}),{identity,token,workspaces:remoteWs,maxConcurrent:1,checks:[check],
 process:workspace=>({command:process.execPath,args:[fileURLToPath(new URL("./fixtures/pi-worker.mjs",import.meta.url))],cwd:workspace.path})});
 const url=await server.listen();assert.equal((await fetch(url+"/jobs/unknown")).status,401);
 const task={id:"A",title:"A",status:"running",attempts:1,dependsOn:[],writeScopes:["a.txt"],capabilities:[],acceptance:["a.txt exists"],artifacts:[],evidence:[],leaseUntil:Date.now()+60000,lease:{taskId:"A",workerId:"node-1",token:"lease-token-1",attempt:1}};
 const execution={instructions:"create fixture A",modelId:"fixture",roleId:"dev",checkIds:["verify"]};
 const client=new RemoteWorkerClient({url,token,allowLoopbackHttp:true,pollMs:20});
 const candidate=await dispatch({client,task,execution,base,baseBundle:await ws.exportCommit(base)});
 await ws.importCommit(candidate.bundle,candidate.commit);
 const inspect=await ws.create("inspect-A",1,candidate.commit);
 assert.equal(await readFile(join(inspect.path,"a.txt"),"utf8"),"A");
 const integration=await ws.create("integrate",1,base);
 await ws.assertBase(integration,base);await ws.integrate(integration,candidate.commit,AbortSignal.timeout(30000));
 assert.equal(await readFile(join(integration.path,"a.txt"),"utf8"),"A");
 assert.equal(await ws.head(),base);
 const jobs=JSON.parse(await readFile(join(root,"remote-state.json"),"utf8"));assert.equal(jobs.jobs.length,1);assert.equal(jobs.jobs[0].state,"done");
 }finally{await server?.close();await rm(root,{recursive:true,force:true});}
}
test("HTTP worker v1 protocol: distinct repository, bundle transfer, local revalidation and integration",()=>withWorker("v1",({client,task,execution,base,baseBundle})=>
 client.run({version:1,identity:{tenantId:"tenant-1",projectId:"proj-1",goalId:"goal-1",runId:"run-1",taskId:task.id,attempt:1},task,execution,baseCommit:base,baseBundle},AbortSignal.timeout(30000))));
test("HTTP worker legacy dispatch (pre-P2G coordinator wiring) still transfers and integrates",()=>withWorker("legacy",({client,task,execution,base,baseBundle})=>
 client.run({task,execution,baseCommit:base,baseBundle},AbortSignal.timeout(30000))));
test("remote client refuses plaintext non-loopback and embedded URL secrets",()=>{
 assert.throws(()=>new RemoteWorkerClient({url:"http://example.test",token:"a".repeat(32)}));
 assert.throws(()=>new RemoteWorkerClient({url:"https://name:secret@example.test",token:"a".repeat(32)}));
});
