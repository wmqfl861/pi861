import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp,mkdir,writeFile,readFile,rm,readdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { PiRpcSession } from "../src/live/pi-rpc.ts";
const sourceHost=process.env.PI861_TEST_SOURCE_HOST==="1";
const cli=sourceHost?fileURLToPath(new URL("../../../packages/coding-agent/src/experimental/cli.ts",import.meta.url)):process.env.PI861_TEST_PI_CLI;
if(process.env.PI861_REQUIRE_HOST_TESTS==="1"&&!cli)throw new Error("PI861_TEST_PI_CLI is required for host acceptance; a skipped host test is not a pass");
/** Optional JSON string array inserted before the CLI entry, e.g. a tsx source-host launch: ["<tsx>/cli.mjs","--tsconfig","<tsconfig>"]. */
function launchPrefix(){if(sourceHost)return[fileURLToPath(new URL("../../../node_modules/tsx/dist/cli.mjs",import.meta.url)),"--tsconfig",fileURLToPath(new URL("../../../tsconfig.json",import.meta.url))];const raw=process.env.PI861_TEST_PI_LAUNCH_PREFIX;if(!raw)return[];const parsed=JSON.parse(raw);
if(!Array.isArray(parsed)||parsed.some(part=>typeof part!=="string"))throw new Error("PI861_TEST_PI_LAUNCH_PREFIX must be a JSON array of strings");return parsed;}
/** Windows releases child working-directory handles slightly after process exit; retry a bounded number of times. */
async function removeTree(path){for(let attempt=0;attempt<20;attempt++){try{await rm(path,{recursive:true,force:true});return}catch(error){if(!["EBUSY","ENOTEMPTY","EPERM"].includes(error?.code))throw error;await sleep(250)}}await rm(path,{recursive:true,force:true});}
/** The host fires tool_execution_end without awaiting the extension's async capture; poll bounded for durable writes. */
async function waitFor(accept,label,attempts=50){for(let attempt=0;attempt<attempts;attempt++){if(await accept())return;await sleep(100)}assert.fail(label)}
const timeoutMs=Number(process.env.PI861_TEST_TIMEOUT_MS??60000);
test("real Pi runtime: incremental managed model, C3 metered failover, governed memory, no whole-block snapshots",{skip:!cli,timeout:timeoutMs},async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-live-host-"));let session;
 try{
 const home=join(root,"home"),work=join(root,"project"),state=join(root,"state"),configFile=join(root,"config.json");await mkdir(home);await mkdir(work);
 const config={version:2,projectId:"host-test",stateDirectory:state,role:{id:"developer",skillIds:[],grants:[]},
 models:{targets:[{id:"cheap",revision:"1",provider:"pi861-fixture",model:"cheap",quality:1,costRank:1,contextWindow:200000,capabilities:["tools"],enabled:true},
 {id:"strong",revision:"1",provider:"pi861-fixture",model:"strong",quality:3,costRank:3,contextWindow:200000,capabilities:["tools"],enabled:true}],
 preferred:"cheap",intakeId:"cheap",enableRouting:false,requirements:{minQuality:1,contextTokens:100,capabilities:["tools"],allowedIds:["cheap","strong"]},
 recovery:{failoverEnabled:true,failbackEnabled:false,probeIntervalMs:100,maxProbeIntervalMs:1000,requiredProbeSuccesses:2},maxAttempts:3,requestTimeoutMs:10000,maxRequests:20,maxProbeRequests:2},
 memory:{autoRecall:true,autoCapture:true,autoEnrich:false,modelId:"strong"},budget:{maxRequests:50}};
 await writeFile(configFile,JSON.stringify(config));
 const env={HOME:home,USERPROFILE:home,PI_CODING_AGENT_DIR:join(home,".pi","agent"),PI861_CONFIG:configFile,PI861_FIXTURE_FAIL:"1",PI861_FIXTURE_LOG:join(root,"calls.jsonl"),NO_COLOR:"1"};
 const processSpec={command:process.execPath,args:[...launchPrefix(),cli,"--mode","rpc","--no-extensions","--no-skills","-e",fileURLToPath(new URL("./fixtures/native-provider.mjs",import.meta.url)),"-e",fileURLToPath(new URL("../runtime.ts",import.meta.url))],cwd:work,env};
 session=new PiRpcSession(processSpec,{waitForSettled:true});const signal=AbortSignal.timeout(timeoutMs-5000);
 const commands=await session.command("get_commands",{},signal);for(const name of ["skills","mcp","memory-maintain","model-policy"])assert.ok(commands.commands.some(c=>c.name===name),`Missing ${name}`);
 const run=await session.prompt("fixture-write: write fixture.txt once using the write tool",signal);
 assert.equal(await readFile(join(work,"fixture.txt"),"utf8"),"written through real Pi");assert.equal(run.toolCalls,1);
 const entries=await session.command("get_entries",{},signal);
 const routing=entries.entries.filter(e=>e.customType==="pi861.model-runtime.v2");assert.ok(routing.some(e=>e.data.active==="strong"&&e.data.preferred==="cheap"));
 // Wiring acceptance: dispatch is metered on the C3 service, never the legacy request counter.
 for(const entry of routing)assert.equal(entry.data.metering,"service");
 const stateFiles=await readdir(state);
 assert.ok(stateFiles.includes("model-usage.json"),"the model usage ledger must exist");
 assert.ok(!stateFiles.includes("budget.json"),"the legacy RequestBudget store must not be created");
 const ledger=JSON.parse(await readFile(join(state,"model-usage.json"),"utf8"));
 assert.ok(ledger.byPurpose.execution>=1,"physical model attempts must be settled on the service");
 assert.equal(ledger.records.every(r=>r.reservationId),true);
 // Wiring acceptance: memory capture runs through governance; whole-snapshot entries are gone.
 assert.equal(entries.entries.filter(e=>e.customType==="pi861.memory.v1").length,0,"whole-block memory JSON entries must not be written");
 await waitFor(async()=>{try{const governed=JSON.parse(await readFile(join(state,"memory.json"),"utf8"));return governed.memory?.items?.some(x=>x.full&&x.full.includes('"tool":"write"'))}catch{return false}},"tool execution must be captured by memory governance");
 await session.command("prompt",{message:"/remember durable-native-host-marker"},signal);
 await session.command("prompt",{message:"/memory-maintain"},signal);
 await waitFor(async()=>{try{const saved=JSON.parse(await readFile(join(state,"memory.json"),"utf8"));return saved.memory?.items?.some(x=>x.full==="durable-native-host-marker")}catch{return false}},"explicit /remember must persist in the governed authority");
 await session.close();session=undefined;
 session=new PiRpcSession({...processSpec,env:{...env,PI861_FIXTURE_FAIL:"0"}},{waitForSettled:true});
 await session.prompt("Find durable-native-host-marker in prior memory",signal);
 const calls=(await readFile(join(root,"calls.jsonl"),"utf8")).trim().split("\n").map(JSON.parse);assert.ok(calls.some(c=>c.model==="strong"));
 await waitFor(async()=>{try{const persisted=JSON.parse(await readFile(join(state,"memory.json"),"utf8"));return persisted.memory?.items?.some(x=>x.full==="durable-native-host-marker")}catch{return false}},"the remembered marker must survive the host restart");
 }finally{await session?.close();await removeTree(root);}
});
test("real Pi runtime: loading the full runtime twice keeps exactly one goal owner",{skip:!cli,timeout:timeoutMs},async()=>{
 const root=await mkdtemp(join(tmpdir(),"pi861-live-host-dup-"));
 try{
 const home=join(root,"home"),work=join(root,"project"),state=join(root,"state"),configFile=join(root,"config.json");
 await mkdir(home);await mkdir(work);await mkdir(state);
 const config={version:2,projectId:"host-dup",stateDirectory:state,role:{id:"developer",skillIds:[],grants:[]},
 models:{targets:[{id:"cheap",revision:"1",provider:"pi861-fixture",model:"cheap",quality:1,costRank:1,contextWindow:200000,capabilities:["tools"],enabled:true}],
 preferred:"cheap",intakeId:"cheap",enableRouting:false,requirements:{minQuality:1,contextTokens:100,capabilities:["tools"],allowedIds:["cheap"]},
 recovery:{failoverEnabled:true,failbackEnabled:false,probeIntervalMs:1000,maxProbeIntervalMs:5000,requiredProbeSuccesses:2},maxAttempts:2,requestTimeoutMs:10000,maxRequests:10,maxProbeRequests:1}};
 await writeFile(configFile,JSON.stringify(config));
 const runtimeEntry=fileURLToPath(new URL("../runtime.ts",import.meta.url));
 let output="",closed=false;
 const child=spawn(process.execPath,[...launchPrefix(),cli,"--mode","rpc","--no-session","--no-skills","-e",runtimeEntry,"-e",runtimeEntry],{cwd:work,
 env:{PATH:process.env.PATH??"",HOME:home,USERPROFILE:home,PI_CODING_AGENT_DIR:join(home,".pi","agent"),PI861_CONFIG:configFile,NO_COLOR:"1"},stdio:["pipe","pipe","pipe"]});
 const exited=new Promise((resolve)=>child.once("exit",resolve));
 child.stderr.resume();child.stdout.setEncoding("utf8");
 const reply=new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(new Error("duplicate-load host did not answer get_commands")),30000);
 child.stdout.on("data",(chunk)=>{output+=chunk;for(const line of output.split("\n")){if(!line.trim())continue;let message;try{message=JSON.parse(line)}catch{continue}
 if(message.type==="response"&&message.id===1){clearTimeout(timer);resolve(message)}}});
 setTimeout(()=>child.stdin.write(`${JSON.stringify({id:1,type:"get_commands"})}\n`),250);
 });
 try{
 const message=await reply;
 assert.equal(message.success,true);
 const names=message.data.commands.map((command)=>command.name);
 assert.equal(names.filter((name)=>name==="goal").length,1,`duplicate full-runtime load must leave exactly one goal owner: ${JSON.stringify(names)}`);
 assert.equal(names.filter((name)=>name==="skills").length,1);
 }finally{
 if(!closed)child.kill("SIGTERM");
 let killTimer;
 await Promise.race([exited,new Promise((resolve)=>{killTimer=setTimeout(()=>{if(!closed)child.kill("SIGKILL");resolve()},3000)})]);
 clearTimeout(killTimer);closed=true;
 }
 }finally{await removeTree(root);}
});
