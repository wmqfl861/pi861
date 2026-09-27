// Protocol fixture, NOT an AI developer. Exercises actual process and Git boundaries.
import { writeFileSync, readFileSync, appendFileSync, existsSync } from "node:fs";
let buffer="";
function send(value){process.stdout.write(`${JSON.stringify(value)}\n`);}
process.stdin.on("data",chunk=>{
 buffer+=chunk;while(buffer.includes("\n")){
 const n=buffer.indexOf("\n"),line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!line.trim())continue;
 const request=JSON.parse(line);
 if(request.type!=="prompt"){send({type:"response",id:request.id,command:request.type,success:true,data:{}});continue;}
 send({type:"response",id:request.id,command:"prompt",success:true});send({type:"agent_start"});
 const task=/Task: ([^\n]+)/.exec(request.message)?.[1]??"task";
 if(process.env.TRACE)appendFileSync(process.env.TRACE,`${task}:start\n`);
 const succeed=()=>{
  try{
   if(task==="C"&&readFileSync("a.txt","utf8")!=="A")throw new Error("Dependency code not present");
   writeFileSync(`${task.toLowerCase()}.txt`,task);
   const message={role:"assistant",content:[{type:"text",text:`Implemented fixture ${task}`}],stopReason:"stop",usage:{input:1,output:1}};
   send({type:"message_end",message});send({type:"agent_end",messages:[message]});
  }catch{send({type:"agent_end",messages:[{role:"assistant",stopReason:"error"}]});}
 };
 // Deterministic fault injection: fail or slow the FIRST attempt of a named task. Markers live outside
 // the task workspace (they are fixture bookkeeping, not task output) so write-scope checks stay honest.
 const mark=(suffix)=>process.env.PI861_FIXTURE_MARKDIR?`${process.env.PI861_FIXTURE_MARKDIR}/${task}${suffix}`:null;
 if(process.env.PI861_FIXTURE_FAIL_ONCE===task&&mark(".failed")&&!existsSync(mark(".failed"))){
  writeFileSync(mark(".failed"),"1");
  setTimeout(()=>send({type:"agent_end",messages:[{role:"assistant",stopReason:"error"}]}),5);
  continue;
 }
 const delayOnce=process.env.PI861_FIXTURE_DELAY_ONCE?process.env.PI861_FIXTURE_DELAY_ONCE.split(":"):[];
 if(delayOnce[0]===task&&mark(".slow")&&!existsSync(mark(".slow"))){
  writeFileSync(mark(".slow"),"1");
  setTimeout(succeed,Number(delayOnce[1]??800));
  continue;
 }
 const ms=task==="B"?300:5;
 setTimeout(succeed,ms);
 }
});
