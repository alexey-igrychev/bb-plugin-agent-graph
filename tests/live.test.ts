import assert from "node:assert/strict";
import { test } from "node:test";
import { createLiveReader, type LiveApi, type LiveInput, type WorkerSource } from "../live.ts";

const input: LiveInput = { threadId: "thread-test", itemId: null, workerId: null, cursor: null };
const event = (seq: number, type: string, data: unknown) => ({ seq, type, data, createdAt: seq });
function harness(events: unknown[] = [], source: WorkerSource | null = null) {
  let file = "";
  const calls: object[] = [];
  const api: LiveApi = {
    threads: { events: { list: async (args) => {
      calls.push(args);
      return events.filter((e) => (e as {seq:number}).seq > Number(args.afterSeq ?? 0)).slice(0, 200);
    } } },
    files: { read: async (args) => { calls.push(args); return { content: file, contentEncoding: "utf8" }; } },
  };
  return { read: createLiveReader(api, async () => source), calls, setFile(text: string) { file = text; } };
}

test("reads incremental provider deltas and suppresses duplicated final snapshots", async () => {
  const events = [
    event(1, "item/started", {item:{id:"tool-1",type:"commandExecution",command:"echo hello"}}),
    event(2, "item/commandExecution/outputDelta", {itemId:"tool-1",delta:"hello\n"}),
    event(3, "item/completed", {item:{id:"tool-1",type:"commandExecution",aggregatedOutput:"hello\n",status:"completed"}}),
  ];
  const h = harness(events);
  const page = await h.read(input);
  assert.match(page.text, /echo hello/);
  assert.equal(page.text, "\n[commandExecution] echo hello\nhello\n");
  const next = await h.read({...input,cursor:page.cursor});
  assert.equal(next.text, "");
  assert.equal((h.calls[1] as {afterSeq:string}).afterSeq, "3");
});

test("filters unrelated items and includes linked subagent descendants across pages", async () => {
  const events = [event(1,"item/started",{parentToolCallId:"agent-1",item:{id:"child-1",type:"toolCall",tool:"read"}})];
  const h = harness(events);
  const first = await h.read({...input,itemId:"agent-1"});
  events.push(event(2,"item/commandExecution/outputDelta",{itemId:"other",delta:"secret-other"}), event(3,"item/commandExecution/outputDelta",{itemId:"child-1",delta:"child-output"}));
  const next = await h.read({...input,itemId:"agent-1",cursor:first.cursor});
  assert.equal(next.text,"child-output");
  assert.doesNotMatch(next.text,/secret-other/);
});

test("falls back to completed tool results when no streaming deltas exist", async () => {
  const h = harness([event(1,"item/completed",{item:{id:"read-1",type:"toolCall",tool:"read",result:{content:[{type:"text",text:"file contents"}]},status:"completed"}})]);
  assert.match((await h.read(input)).text,/file contents/);
});

test("reads native delegation and background task lifecycle summaries", async () => {
  const h = harness([
    event(1,"item/started",{item:{id:"agent-1",type:"delegation",label:"Review the change"}}),
    event(2,"item/delegation/progress",{item:{id:"agent-1",type:"delegation",summary:"Checking callers"}}),
    event(3,"item/delegation/completed",{item:{id:"agent-1",type:"delegation",summary:"No issues found",status:"completed"}}),
    event(4,"item/backgroundTask/completed",{item:{id:"background-1",type:"backgroundTask",summary:"Build passed",status:"completed"}}),
  ]);
  const page=await h.read(input);
  assert.match(page.text,/Review the change/);
  assert.match(page.text,/Checking callers/);
  assert.match(page.text,/No issues found/);
  assert.match(page.text,/Build passed/);
});

test("retains one host read while draining a large transcript", async () => {
  const source={hostId:"remote",state:{workers:[{id:"worker-1",transcriptFile:"/safe/worker-1.jsonl",outputTail:""}]}};
  const h=harness([],source);
  h.setFile(Array.from({length:500},()=>JSON.stringify({type:"message",message:{role:"assistant",content:"x".repeat(1000)}})).join("\n")+"\n");
  let cursor:string|null=null;
  let pages=0;
  do {
    const page=await h.read({...input,workerId:"worker-1",cursor});
    cursor=page.cursor;pages++;
    if(!page.hasMore)break;
  }while(pages<10);
  assert.ok(pages>1);
  assert.equal(h.calls.length,1);
});

test("completed transcript polls reuse a snapshot until the slow refresh expires", async () => {
  const source={hostId:"remote",state:{workers:[{id:"worker-1",status:"completed",transcriptFile:"/safe/worker-1.jsonl",outputTail:""}]}};
  const h=harness([],source);
  const line=(text:string)=>JSON.stringify({type:"message",message:{role:"assistant",content:text}})+"\n";
  const clock=Date.now;let now=100000;Date.now=()=>now;
  try {
    h.setFile(line("first"));
    const first=await h.read({...input,workerId:"worker-1"});
    h.setFile(line("first")+line("late final write"));
    now+=2000;
    const quiet=await h.read({...input,workerId:"worker-1",cursor:first.cursor});
    assert.equal(quiet.text,"");assert.equal(h.calls.length,1);
    now+=10000;
    const final=await h.read({...input,workerId:"worker-1",cursor:quiet.cursor});
    assert.match(final.text,/late final write/);assert.equal(h.calls.length,2);
  }finally{Date.now=clock;}
});

test("shows user messages, suppresses repeated summaries, and labels output resets", async () => {
  const summary={id:"agent-1",type:"delegation",summary:"Review done",status:"completed"};
  const h=harness([
    event(1,"item/started",{item:{id:"user-1",type:"userMessage",content:[{type:"text",text:"Please build"}]}}),
    event(2,"item/completed",{item:{id:"user-1",type:"userMessage",content:[{type:"text",text:"Please build"}]}}),
    event(3,"item/delegation/progress",{item:summary}),
    event(4,"item/delegation/progress",{item:summary}),
    event(5,"item/delegation/completed",{item:summary}),
    event(6,"item/completed",{item:summary}),
    event(7,"item/commandExecution/outputDelta",{itemId:"tool-1",delta:"before"}),
    event(8,"item/commandExecution/outputDelta",{itemId:"tool-1",delta:"after",reset:true}),
  ]);
  const page=await h.read(input);
  assert.equal(page.text.match(/Please build/g)?.length,1);
  assert.equal(page.text.match(/Review done/g)?.length,1);
  assert.match(page.text,/before[\s\S]*\[output reset\][\s\S]*after/);
});

test("long-lived streams shed bounded cursor tracking instead of retrying forever", async () => {
  const events=Array.from({length:1200},(_,i)=>event(i+1,"item/agentMessage/delta",{itemId:`item-${i}`,delta:"x"}));
  const h=harness(events);
  let cursor:string|null=null;let warned=false;let text="";
  for(let i=0;i<6;i++){
    const page=await h.read({...input,cursor});cursor=page.cursor;warned ||= page.warning!==null;text+=page.text;
    assert.ok(cursor===null || cursor.length<=100000);
  }
  assert.equal(text.length,1200);
  assert.equal(warned,true);
  assert.equal((await h.read({...input,cursor})).text,"");
});

test("completed siblings do not evict a still-running descendant or inflate cursors", async () => {
  const events=[event(1,"item/started",{parentToolCallId:"agent",item:{id:"long-command",type:"commandExecution",command:"slow build"}})];
  for(let i=0;i<700;i++){
    events.push(event(i*2+2,"item/started",{parentToolCallId:"agent",item:{id:`sibling-${i}`,type:"toolCall",tool:"read"}}));
    events.push(event(i*2+3,"item/completed",{item:{id:`sibling-${i}`,type:"toolCall",result:"done"}}));
  }
  events.push(event(1402,"item/commandExecution/outputDelta",{itemId:"long-command",delta:"still running descendant"}));
  const h=harness(events);let cursor:string|null=null;let text="";
  for(let i=0;i<10;i++){
    const page=await h.read({...input,itemId:"agent",cursor});cursor=page.cursor;text+=page.text;
    assert.equal(page.warning,null);assert.ok(cursor!.length<20000);
    if(!page.hasMore)break;
  }
  assert.match(text,/still running descendant/);
});

test("dedupe stays small even when many native delegations finish", async () => {
  const events=Array.from({length:700},(_,i)=>event(i+1,"item/delegation/completed",{item:{id:`agent-${i}`,type:"delegation",summary:"done"}}));
  const h=harness(events);let cursor:string|null=null;
  for(let i=0;i<4;i++){
    const page=await h.read({...input,cursor});cursor=page.cursor;
    assert.equal(page.warning,null);assert.ok(cursor!.length<10000);
    const decoded=JSON.parse(Buffer.from(cursor!,"base64url").toString());
    assert.ok(Object.keys(decoded.printed).length<=64);
  }
});

test("the producer's recording cap stays visible in log text after the warning page", async () => {
  const h=harness([],{hostId:"remote",state:{workers:[{id:"worker-1",transcriptFile:"/safe/worker-1.jsonl",outputTail:""}]}});
  h.setFile(JSON.stringify({type:"custom",customType:"pi-pi-truncated",data:{reason:"size cap"}})+"\n");
  const first=await h.read({...input,workerId:"worker-1"});
  const next=await h.read({...input,workerId:"worker-1",cursor:first.cursor});
  assert.match(first.text+next.text,/pi-pi stopped recording/);
  assert.match(first.warning!,/size limit/);
});

test("pages through busy event streams without skipping the last event", async () => {
  const events = Array.from({length:201},(_,i)=>event(i+1,"item/agentMessage/delta",{itemId:"reply",delta:String(i+1)+","}));
  const h = harness(events);
  const first = await h.read(input);
  assert.equal(first.hasMore,true);
  const last = await h.read({...input,cursor:first.cursor});
  assert.equal(last.text,"201,");
  assert.equal(last.hasMore,false);
});

test("reads server-selected worker transcript with partial lines, Unicode and rotation", async () => {
  const source = {hostId:"remote-test",state:{workers:[{id:"worker-1",transcriptFile:"/safe/workers/worker-1.jsonl",outputTail:"preview"}]}};
  const h=harness([],source);
  const a=JSON.stringify({type:"message",message:{role:"assistant",content:[{type:"text",text:"Привет"}]}});
  h.setFile(a+"\n"+'{"type":"message"');
  const first=await h.read({...input,workerId:"worker-1"});
  assert.equal(first.source,"transcript");
  assert.match(first.text,/Привет/);
  assert.equal((h.calls[0] as {hostId:string}).hostId,"remote-test");
  h.setFile(a+"\n"+JSON.stringify({type:"message",message:{role:"toolResult",toolName:"bash",content:[{type:"text",text:"工具"}]}})+"\n");
  const clock=Date.now;
  Date.now=()=>clock()+1001;
  let next;
  try { next=await h.read({...input,workerId:"worker-1",cursor:first.cursor}); }
  finally { Date.now=clock; }
  assert.match(next.text,/工具/);
  assert.doesNotMatch(next.text,/Привет/);
  source.state.workers[0]!.transcriptFile="/safe/workers/worker-1-2.jsonl";
  h.setFile(JSON.stringify({type:"message",message:{role:"assistant",content:"resumed ".repeat(100)}})+"\n");
  const rotated=await h.read({...input,workerId:"worker-1",cursor:next.cursor});
  assert.equal(rotated.reset,true);
  assert.match(rotated.text,/resumed/);
});

test("old pi-pi exposes a labelled preview rather than fabricated full history", async () => {
  const h=harness([],{hostId:"remote",state:{workers:[{id:"worker-1",outputTail:"latest"}]}});
  const page=await h.read({...input,workerId:"worker-1"});
  assert.equal(page.source,"preview");
  assert.equal(page.text,"latest");
  assert.match(page.warning!,/pi-pi/i);
  assert.equal(h.calls.length,0);
});

test("rejects client-provided file paths and cursor reuse across targets", async () => {
  const h=harness([event(1,"item/agentMessage/delta",{itemId:"a",delta:"A"}),event(2,"item/agentMessage/delta",{itemId:"b",delta:"B"})]);
  const first=await h.read({...input,itemId:"a"});
  const next=await h.read({...input,itemId:"b",cursor:first.cursor});
  assert.equal(next.text,"B");
  assert.equal(next.reset,true);
  await assert.rejects(h.read({...input,workerId:"../../private"}),{message:"Invalid worker id"});
  assert.equal(h.calls.length,2);
});
