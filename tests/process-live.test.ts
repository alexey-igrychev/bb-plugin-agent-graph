import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveReader, type LiveApi, type WorkerSource } from "../live.ts";

const target = {threadId:"thread-a",workerId:"worker-a",itemId:null,processId:"process-a",cursor:null};
function setup() {
  let content = "";
  let encoding = "utf8";
  const paths:string[]=[];
  const process = {id:"process-a",rootId:"process-a",toolCallId:"tool-a",toolName:"bash",pid:123,command:"printf hello",status:"running",startedAt:1000,logFile:"/storage/pi-pi/processes/process-a.jsonl",outputCapture:"pipes"} as const;
  const source:WorkerSource={hostId:"host-a",state:{workers:[{id:"worker-a",outputTail:"",processes:[process]}]}};
  const api:LiveApi={threads:{events:{list:async()=>[]}},files:{read:async({hostId,path})=>{assert.equal(hostId,"host-a");paths.push(path);return{content,contentEncoding:encoding};}}};
  return {read:createLiveReader(api,async()=>source),paths,source,
    setLines(rows:unknown[]){content=rows.map(row=>JSON.stringify(row)).join("\n")+"\n";},
    setRaw(text:string){content=text;},
    setEncoding(value:string){encoding=value;}};
}

/** Runs `fn` with Date.now() pinned to `time`: the reader holds a log briefly by wall clock. */
async function at<T>(time:number,fn:()=>Promise<T>):Promise<T>{
  const real=Date.now;
  Date.now=()=>time;
  try{return await fn();}finally{Date.now=real;}
}

const LONE_SURROGATE=/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const NOW=1_700_000_000_000;

test("process target streams only its server-selected log with timestamp/channel/exit entries", async()=>{
  const h=setup();
  h.setLines([{seq:1,at:1000,kind:"start",text:"printf hello"},{seq:2,at:1100,kind:"stdout",text:"hello\n"},{seq:3,at:1200,kind:"stderr",text:"warning\n"},{seq:4,at:1300,kind:"exit",exitCode:0,status:"exited"}]);
  const page=await h.read(target);
  assert.equal(page.source,"process");assert.equal(page.warning,null);
  assert.match(page.text,/hello/);assert.match(page.text,/warning/);
  assert.equal(page.entries?.find(e=>e.kind==="stdout")?.at,1100);
  assert.equal(page.entries?.find(e=>e.kind==="stderr")?.text,"warning\n");
  assert.equal(page.entries?.find(e=>e.kind==="command"&&e.status==="exited")?.exitCode,0);
  assert.deepEqual(h.paths,["/storage/pi-pi/processes/process-a.jsonl"]);
  const next=await h.read({...target,cursor:page.cursor});assert.equal(next.text,"");assert.deepEqual(next.entries,[]);
  assert.ok(!JSON.stringify(page).includes("/storage/"));
});

test("process membership is checked before any file read and paths are never client-selected", async()=>{
  const h=setup();
  await assert.rejects(h.read({...target,workerId:"other"}),/Worker/);
  await assert.rejects(h.read({...target,processId:"process-other"}),/Process/);
  await assert.rejects(h.read({...target,processId:"../../private"}),/process/i);
  assert.deepEqual(h.paths,[]);
  h.setLines([{seq:1,at:1,kind:"stdout",text:"safe"}]);
  const injected={...target,path:"/private/secrets"};
  assert.equal((await h.read(injected)).source,"process");
  assert.deepEqual(h.paths,["/storage/pi-pi/processes/process-a.jsonl"]);
});

test("descendant output is explicitly labelled shared instead of claiming per-pid capture", async()=>{
  const h=setup();
  h.source.state.workers[0]!.processes!.push({...h.source.state.workers[0]!.processes![0]!,id:"child-a",rootId:"process-a",pid:124,parentId:"process-a",outputCapture:"shared"});
  h.setLines([{seq:1,at:1,kind:"stdout",text:"root and children share this pipe"}]);
  const page=await h.read({...target,processId:"child-a"});
  assert.equal(page.source,"process");assert.match(page.warning!,/shared|root/i);assert.match(page.text,/share this pipe/);
});

test("uncaptured process exposes an honest metadata preview, not the worker transcript", async()=>{
  const h=setup();
  const p=h.source.state.workers[0]!.processes![0]!;
  delete p.logFile;p.outputCapture="unavailable";
  const page=await h.read(target);
  assert.equal(page.source,"process");assert.match(page.warning!,/captured|unavailable|redirect/i);
  assert.deepEqual(h.paths,[]);
});

test("process cursor resets across process ids and bounded log input rejects oversized data", async()=>{
  const h=setup();
  h.source.state.workers[0]!.processes!.push({...h.source.state.workers[0]!.processes![0]!,id:"process-b",rootId:"process-b",pid:125,logFile:"/storage/pi-pi/processes/process-b.jsonl"});
  h.setLines([{seq:1,at:1,kind:"stdout",text:"first"}]);
  const page=await h.read(target);
  const other=await h.read({...target,processId:"process-b",cursor:page.cursor});assert.equal(other.reset,true);assert.match(other.text,/first/);
  h.source.state.workers[0]!.processes!.push({...h.source.state.workers[0]!.processes![0]!,id:"process-c",rootId:"process-c",pid:126,logFile:"/storage/pi-pi/processes/process-c.jsonl"});
  h.setLines([{seq:1,at:1,kind:"stdout",text:"x".repeat(2*1024*1024)}]);
  await assert.rejects(h.read({...target,processId:"process-c"}),/size limit/);
});

test("provider command entries keep one stable identity across start, deltas and completion",async()=>{
  const events=[
    {seq:1,createdAt:1,type:"item/started",data:{item:{id:"call-a",type:"toolCall",tool:"bash",arguments:{command:"echo hi"}}}},
    {seq:2,createdAt:2,type:"item/commandExecution/outputDelta",data:{itemId:"call-a",delta:"hi\n"}},
    {seq:3,createdAt:3,type:"item/completed",data:{item:{id:"call-a",type:"toolCall",tool:"bash",arguments:{command:"echo hi"},status:"completed",exitCode:0,result:"hi\n"}}},
  ];
  const api:LiveApi={threads:{events:{list:async()=>events}},files:{read:async()=>({content:"",contentEncoding:"utf8"})}};
  const page=await createLiveReader(api,async()=>null)({...target,workerId:null,processId:null});
  assert.equal(new Set(page.entries?.map(e=>e.id)).size,1);
  assert.equal(page.entries?.[0]?.command,"echo hi");assert.equal(page.entries?.[0]?.text,"");
  assert.equal(page.entries?.[1]?.text,"hi\n");assert.equal(page.entries?.[1]?.append,true);
  assert.equal(page.entries?.[2]?.text,"");assert.equal(page.entries?.[2]?.exitCode,0);assert.equal(page.entries?.[2]?.append,true);
});

test("provider and transcript entries retain semantic roles rather than parsing plain text headers",async()=>{
  let content=JSON.stringify({type:"message",id:"m1",timestamp:"2026-10-31T12:00:00Z",message:{role:"assistant",content:[{type:"thinking",thinking:"consider"},{type:"text",text:"[stderr] is harmless prose"},{type:"toolCall",id:"call1",name:"bash",arguments:{command:"echo hi"}}]}})+"\n";
  const api:LiveApi={threads:{events:{list:async()=>[{seq:1,createdAt:1234,type:"item/agentMessage/delta",data:{itemId:"reply",delta:"live text"}}]}},files:{read:async()=>({content,contentEncoding:"utf8"})}};
  const source:WorkerSource={hostId:"host-a",state:{workers:[{id:"worker-a",outputTail:"",transcriptFile:"/safe/a.jsonl"}]}};
  const read=createLiveReader(api,async()=>source);
  const transcript=await read({...target,processId:null});
  assert.deepEqual(transcript.entries?.map(e=>e.kind),["thinking","assistant","command"]);
  assert.equal(transcript.entries?.[1]?.text,"[stderr] is harmless prose");assert.equal(transcript.entries?.[2]?.command,"echo hi");
  assert.equal(transcript.entries?.[0]?.at,Date.parse("2026-10-31T12:00:00Z"));
  const provider=await read({...target,workerId:null,processId:null});
  assert.equal(provider.entries?.[0]?.kind,"assistant");assert.equal(provider.entries?.[0]?.append,true);assert.equal(provider.entries?.[0]?.at,1234);
  content="";
});

test("a half-written trailing line is held back whole, then streamed once the log is refreshed",async()=>{
  const h=setup();
  const first=JSON.stringify({seq:1,at:1000,kind:"stdout",text:"done\n"});
  const second=JSON.stringify({seq:2,at:1100,kind:"stdout",text:"ok 😀\n"});
  // pi-pi appends to this log while it is read: the tail can stop inside a
  // JSON row, and inside a multi-byte character.
  const split=second.indexOf("😀")+1;
  const h1=await at(NOW,()=>h.read(target));
  assert.equal(h1.text,"");
  h.setRaw(`${first}\n${second.slice(0,split)}`);
  const page=await at(NOW+20_000,()=>h.read({...target,cursor:h1.cursor}));
  assert.match(page.text,/done/);
  assert.doesNotMatch(page.text,/ok/);
  assert.equal(LONE_SURROGATE.test(JSON.stringify(page)),false);
  assert.equal(page.warning,null);
  assert.equal(page.hasMore,false);
  h.setRaw(`${first}\n${second}\n`);
  const rest=await at(NOW+40_000,()=>h.read({...target,cursor:page.cursor}));
  assert.equal(rest.reset,false);
  assert.match(rest.text,/ok 😀/);
  assert.equal(rest.entries?.length,1);
  assert.equal(rest.entries?.[0]?.text,"ok 😀\n");
});

test("a malformed or unknown log row is skipped and said so, the rest still streams",async()=>{
  const h=setup();
  h.setRaw([
    JSON.stringify({seq:1,at:1,kind:"stdout",text:"before"}),
    "{not json at all",
    JSON.stringify({seq:2,at:2,kind:"debug",text:"not a channel"}),
    JSON.stringify({seq:3,at:3,kind:"stderr",text:"after"}),
  ].join("\n")+"\n");
  const page=await h.read(target);
  assert.match(page.warning!,/malformed/i);
  assert.match(page.text,/before/);
  assert.match(page.text,/after/);
  assert.doesNotMatch(page.text,/not a channel/);
  assert.deepEqual(page.entries?.map(e=>e.kind),["stdout","stderr"]);
});

test("a long log is capped per page and the next page resumes where it stopped",async()=>{
  const h=setup();
  h.setLines(Array.from({length:600},(_,index)=>({seq:index+1,at:index,kind:"stdout",text:`line ${index}\n`})));
  const page=await at(NOW,()=>h.read(target));
  assert.equal(page.entries?.length,500);
  assert.equal(page.hasMore,true);
  assert.match(page.text,/line 0\n/);
  assert.doesNotMatch(page.text,/line 500\n/);
  const next=await at(NOW,()=>h.read({...target,cursor:page.cursor}));
  assert.equal(next.entries?.length,100);
  assert.equal(next.hasMore,false);
  assert.match(next.text,/line 500\n/);
  assert.equal(new Set([...page.entries!,...next.entries!].map(e=>e.id)).size,600);
});

test("an exit with no code reports its signal, or unknown, and never 0",async()=>{
  const h=setup();
  h.setLines([{seq:1,at:1,kind:"exit",signal:"SIGKILL",status:"failed"}]);
  const killed=await at(NOW,()=>h.read(target));
  assert.match(killed.text,/\[exit SIGKILL\]/);
  assert.doesNotMatch(killed.text,/\[exit 0\]/);
  const entry=killed.entries?.[0]!;
  assert.equal(entry.kind,"command");
  assert.equal(entry.status,"failed");
  assert.equal(entry.exitCode,undefined);
  assert.equal(entry.append,true);
  h.source.state.workers[0]!.processes!.push({...h.source.state.workers[0]!.processes![0]!,id:"process-d",rootId:"process-d",pid:127,logFile:"/storage/pi-pi/processes/process-d.jsonl"});
  h.setLines([{seq:1,at:1,kind:"exit"}]);
  const unknown=await at(NOW+60_000,()=>h.read({...target,processId:"process-d"}));
  assert.match(unknown.text,/\[exit unknown\]/);
});

test("a recording that hit its limit says so rather than looking complete",async()=>{
  const h=setup();
  h.source.state.workers[0]!.processes![0]!.logTruncated=true;
  h.setLines([{seq:1,at:1,kind:"stdout",text:"all that was kept"}]);
  const page=await h.read(target);
  assert.match(page.warning!,/limit|truncat/i);
  assert.match(page.text,/all that was kept/);
});

test("a descendant reads its root's log, never a path of its own",async()=>{
  const h=setup();
  h.source.state.workers[0]!.processes!.push({...h.source.state.workers[0]!.processes![0]!,id:"child-c",rootId:"process-a",parentId:"process-a",pid:128,logFile:"/storage/pi-pi/processes/child-c.jsonl"});
  h.setLines([{seq:1,at:1,kind:"stdout",text:"shared pipe"}]);
  const page=await h.read({...target,processId:"child-c"});
  assert.deepEqual(h.paths,["/storage/pi-pi/processes/process-a.jsonl"]);
  assert.match(page.text,/shared pipe/);
});

test("a log path the state does not vouch for is refused before any read",async()=>{
  const h=setup();
  const refuse=async(logFile:string)=>{
    h.source.state.workers[0]!.processes![0]!.logFile=logFile;
    await assert.rejects(h.read(target),/Invalid process log path/);
  };
  await refuse("/storage/pi-pi/transcripts/worker-a.jsonl");
  await refuse("/storage/pi-pi/processes/../../etc/passwd");
  await refuse("pi-pi/processes/process-a.jsonl");
  await refuse("/storage/pi-pi/processes/process-a.log");
  assert.deepEqual(h.paths,[]);
  h.source.state.workers[0]!.processes![0]!.logFile="/storage/pi-pi/processes/process-a.jsonl";
  h.setEncoding("base64");
  await assert.rejects(h.read(target),/UTF-8/);
});

test("a process whose capture is unavailable shows metadata even when a log path survives",async()=>{
  const h=setup();
  // pi-pi may keep a stale log path for a process it could not capture; the
  // path must not be what decides whether output is claimed to be real.
  h.source.state.workers[0]!.processes![0]!.outputCapture="unavailable";
  h.setLines([{seq:1,at:1,kind:"stdout",text:"stale bytes from an earlier run"}]);
  const page=await h.read(target);
  assert.deepEqual(h.paths,[]);
  assert.doesNotMatch(page.text,/stale bytes/);
  assert.match(page.warning!,/captured|unavailable|redirect/i);
});

test("the same process id with a new log file restarts that log instead of resuming its offset",async()=>{
  const h=setup();
  const p=h.source.state.workers[0]!.processes![0]!;
  h.setLines([{seq:1,at:1,kind:"stdout",text:"first attempt line one"},{seq:2,at:2,kind:"stdout",text:"first attempt line two"}]);
  const first=await at(NOW,()=>h.read(target));
  assert.match(first.text,/line two/);
  // A re-exec keeps the process id pi-pi assigned but records to a new file;
  // the old offset points into the middle of a log this page has never shown.
  p.logFile="/storage/pi-pi/processes/process-a-2.jsonl";
  h.setLines([{seq:1,at:3,kind:"stdout",text:"second attempt line one"},{seq:2,at:4,kind:"stdout",text:"second attempt line two"},{seq:3,at:5,kind:"stdout",text:"second attempt line three"}]);
  const again=await at(NOW+20_000,()=>h.read({...target,cursor:first.cursor}));
  assert.equal(again.reset,true);
  assert.equal(h.paths.at(-1),"/storage/pi-pi/processes/process-a-2.jsonl");
  assert.match(again.text,/second attempt line one/);
  assert.equal(again.entries?.length,3);
  assert.doesNotMatch(again.text,/first attempt/);
});
