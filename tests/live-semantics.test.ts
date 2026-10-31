import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveReader, type LiveApi, type WorkerSource } from "../live.ts";
import { applyLivePage, emptyLiveState } from "../live-stream.ts";

const target={threadId:"thread-test",workerId:null,itemId:null,cursor:null};
function eventsReader(events:unknown[]) {
  const api:LiveApi={threads:{events:{list:async()=>events}},files:{read:async()=>({content:"",contentEncoding:"utf8"})}};
  return createLiveReader(api,async()=>null);
}

test("native delegation label, progress and final result survive reader-to-panel folding",async()=>{
  const item={id:"agent-1",type:"delegation",label:"Review the change"};
  const read=eventsReader([
    {seq:1,createdAt:1,type:"item/started",data:{item}},
    {seq:2,createdAt:2,type:"item/delegation/progress",data:{item:{...item,summary:"Checking callers"}}},
    {seq:3,createdAt:3,type:"item/delegation/progress",data:{item:{...item,summary:"Running tests"}}},
    {seq:4,createdAt:4,type:"item/delegation/completed",data:{item:{...item,summary:"No issues found",status:"completed"}}},
  ]);
  const state=applyLivePage(emptyLiveState,await read(target));
  assert.equal(state.entries.length,1);
  for(const text of ["Review the change","Checking callers","Running tests","No issues found"])assert.match(state.entries[0]!.text,new RegExp(text));
  assert.equal(state.entries[0]!.status,"completed");
});

test("failed completion appends its error to streamed diagnostics instead of deleting them",async()=>{
  const read=eventsReader([
    {seq:1,createdAt:1,type:"item/started",data:{item:{id:"patch",type:"fileChange",changes:[]}}},
    {seq:2,createdAt:2,type:"item/fileChange/outputDelta",data:{itemId:"patch",delta:"Important failure context\n"}},
    {seq:3,createdAt:3,type:"item/completed",data:{item:{id:"patch",type:"fileChange",changes:[],status:"failed",error:"Patch failed"}}},
  ]);
  const state=applyLivePage(emptyLiveState,await read(target));
  assert.equal(state.entries.length,1);
  assert.match(state.entries[0]!.text,/Important failure context[\s\S]*Patch failed/);
  assert.equal(state.entries[0]!.status,"failed");
});

test("reasoning completion closes the same thinking entry without a phantom running tool",async()=>{
  const read=eventsReader([
    {seq:1,createdAt:1,type:"item/reasoning/textDelta",data:{itemId:"reason",delta:"consider this"}},
    {seq:2,createdAt:2,type:"item/completed",data:{item:{id:"reason",type:"reasoning",status:"completed",text:"consider this"}}},
  ]);
  const state=applyLivePage(emptyLiveState,await read(target));
  assert.equal(state.entries.length,1);assert.equal(state.entries[0]!.kind,"thinking");
  assert.equal(state.entries[0]!.status,"completed");assert.equal(state.entries[0]!.text,"consider this");
});

function processReader(options:{content?:string;error?:Error;childCapture?:"pipes"|"shared";truncated?:boolean;missingStatus?:boolean}={}) {
  const process={id:"root",rootId:"root",toolCallId:"tool",toolName:"bash",pid:5,command:"npm run build",status:"exited",startedAt:1,logFile:"/storage/pi-pi/processes/root.jsonl",logTruncated:options.truncated,outputCapture:"pipes" as const};
  const source:WorkerSource={hostId:"host",state:{workers:[{id:"worker",outputTail:"",processes:[process,{...process,id:"child",rootId:"root",pid:6,outputCapture:options.childCapture??"shared",warning:"Child resource sample is stale."}]}]}};
  let content=options.content??[
    {seq:1,at:1,kind:"start",text:"npm run build"},
    {seq:2,at:2,kind:"stdout",text:"building…\n"},
    {seq:3,at:3,kind:"exit",exitCode:0,...(options.missingStatus?{}:{status:"exited"})},
  ].map(row=>JSON.stringify(row)).join("\n")+"\n";
  const api:LiveApi={threads:{events:{list:async()=>[]}},files:{read:async()=>{if(options.error)throw options.error;return{content,contentEncoding:"utf8"};}}};
  return {read:createLiveReader(api,async()=>source),setContent:(next:string)=>{content=next;}};
}
const processTarget={...target,workerId:"worker",processId:"root"};

test("process start does not duplicate its command and an exit without status is terminal",async()=>{
  const {read}=processReader({missingStatus:true});
  const page=await read(processTarget);const state=applyLivePage(emptyLiveState,page);
  const command=state.entries.find(e=>e.kind==="command")!;
  assert.equal(command.command,"npm run build");assert.equal(command.text,"");
  assert.equal(command.status,"exited");assert.equal(command.exitCode,0);
  assert.match(page.text,/npm run build\nbuilding/);
});

test("shared, stale and truncated notices coexist and host file errors stay private",async()=>{
  const {read}=processReader({truncated:true,childCapture:"pipes"});
  const page=await read({...processTarget,processId:"child"});
  assert.match(page.warning!,/shared|root/i);assert.match(page.warning!,/stale/i);assert.match(page.warning!,/limit/i);
  const failure=processReader({error:new Error("ENOENT: open '/storage/pi-pi/processes/private-root.jsonl'")});
  await assert.rejects(failure.read(processTarget),error=>error instanceof Error&&!error.message.includes("/storage/")&&/unavailable|read|captured/i.test(error.message));
});

test("shrinking a process log at the same path resets both retained offset and visible stream",async()=>{
  const h=processReader();const page=await h.read(processTarget);
  h.setContent(JSON.stringify({seq:1,at:1,kind:"stdout",text:"new"})+"\n");
  const clock=Date.now;Date.now=()=>clock()+10001;
  try {
    const fresh=await h.read({...processTarget,cursor:page.cursor});
    assert.equal(fresh.reset,true);assert.match(fresh.text,/new/);
  }finally{Date.now=clock;}
});
