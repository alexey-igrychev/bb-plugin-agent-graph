// Wiring tests for the plugin itself: the real server.ts loaded into the
// SDK's fake plugin host, driven only through its registered RPC methods.
// Everything below the RPC boundary (timeline, live, pi-pi helpers) has its
// own unit tests; these check that the plugin plugs them together.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Graph } from "../server.ts";
import type { LivePage } from "../live.ts";

// The plugin's sources are written for the bb bundler: sibling imports have
// no extension, and server.ts uses syntax (constructor parameter
// properties) that node's strip-only mode refuses. Both are handled here so
// the real module can be loaded as it ships.
registerHooks({
  resolve(specifier, context, next) {
    const relative = specifier.startsWith("./") || specifier.startsWith("../");
    return next(relative && !/\.[cm]?[jt]sx?$/.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith("file:") || !url.endsWith(".ts")) return next(url, context);
    const source = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true },
    }).outputText;
    return { format: "module", shortCircuit: true, source };
  },
});
const plugin = (await import("../server.ts")).default;

const NOW = Date.now();
const PI_THREAD = "thr_pi";
const NATIVE_THREAD = "thr_native";
const TRANSCRIPT = "/storage/thr_pi/pi-pi/workers/sess/task-1.jsonl";

type Thread = Record<string, unknown>;

const piThread: Thread = {
  id: PI_THREAD,
  projectId: "p1",
  title: "Pi thread",
  titleFallback: null,
  status: "active",
  parentThreadId: null,
  providerId: "pi",
  updatedAt: NOW - 1_000,
  createdAt: NOW - 600_000,
};
const nativeThread: Thread = {
  ...piThread,
  id: NATIVE_THREAD,
  title: "Native thread",
  status: "idle",
  providerId: "claude-code",
  updatedAt: NOW - 2_000,
};

/** One finished turn: a shell call and the delegation that launched task-1. */
const piRows = () => [
  { kind: "conversation", role: "user", id: "prompt-1", text: "Build the thing", turnId: null, createdAt: NOW - 500_000 },
  {
    kind: "turn",
    turnId: "t1",
    status: "completed",
    startedAt: NOW - 500_000,
    completedAt: NOW - 400_000,
    children: [
      { kind: "work", workKind: "command", id: "w1", callId: "call-1", command: "npm test", status: "completed", output: "ok", startedAt: NOW - 499_000, completedAt: NOW - 498_000 },
      {
        kind: "work",
        workKind: "delegation",
        id: "w2",
        callId: "item-9",
        description: "Do the thing",
        subagentType: "task",
        status: "completed",
        startedAt: NOW - 497_000,
        completedAt: NOW - 496_000,
        output: "Started worker task-1 (task: Do the thing); it is still running. Its result will arrive as a worker update; keep working.",
        childRows: [],
      },
    ],
  },
  { kind: "conversation", role: "assistant", turnId: "t1", text: "On it" },
];

const piWorker = (overrides: Record<string, unknown> & { id: string }) => ({
  type: "task",
  description: "Do the thing",
  prompt: "Please do the thing",
  status: "running",
  model: "anthropic/claude",
  createdAt: NOW - 60_000,
  startedAt: NOW - 59_000,
  lastEventAt: NOW - 1_000,
  silent: false,
  toolUses: 7,
  tokens: 1234,
  outputTail: "thinking about it",
  ...overrides,
});

const piState = (workers: Array<Record<string, unknown>>) =>
  JSON.stringify({
    version: 1,
    pid: 42,
    live: true,
    heartbeatAt: NOW,
    piPiVersion: "1.17.0",
    status: { text: "Thinking", level: "normal", since: NOW - 5_000 },
    tasks: [],
    workers,
    commandResults: [],
    notices: [],
  });

const transcript = [
  JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/repo" }),
  JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "worker prompt" } }),
  JSON.stringify({ type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "worker answer" }] } }),
  "",
].join("\n");

const WORKERS = [
  piWorker({ id: "task-1", transcriptFile: TRANSCRIPT }),
  piWorker({ id: "task-7", status: "queued", description: "Unmatched worker" }),
  piWorker({ id: "task-8", status: "completed", settledAt: NOW - 10_000, result: { status: "done", summary: "finished", body: "body" } }),
  piWorker({ id: "task-9", status: "failed", settledAt: NOW - 5_000, error: "worker crashed after its first step" }),
];

/** The log pi-pi records for one process, under the thread's storage root. */
const processLog = (processId: string) => `/storage/${PI_THREAD}/pi-pi/processes/${processId}.jsonl`;

const piProcess = (overrides: Record<string, unknown> & { id: string }) => ({
  rootId: overrides.id,
  toolCallId: "call-77",
  toolName: "bash",
  command: "npm run build",
  pid: 4242,
  ppid: 42,
  startedAt: NOW - 30_000,
  status: "running",
  outputCapture: "pipes",
  logFile: processLog(String(overrides.id)),
  ...overrides,
});

const processRows = (rows: Array<Record<string, unknown>>) =>
  `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

function host(options: { workers?: Array<Record<string, unknown>>; events?: unknown[]; secondPi?: boolean; logs?: Record<string, string> } = {}) {
  const files = new Map<string, string>([
    [`/storage/${PI_THREAD}/pi-pi/state.json`, piState(options.workers ?? WORKERS)],
    [TRANSCRIPT, transcript],
    ...Object.entries(options.logs ?? {}),
  ]);
  if (options.secondPi) files.set(`/storage/${NATIVE_THREAD}/pi-pi/state.json`, piState(options.workers ?? WORKERS));
  const secondThread = options.secondPi ? { ...nativeThread, providerId: "pi" } : nativeThread;
  const { bb, harness } = createFakePluginHost({
    pluginId: "agent-graph",
    sdk: {
      subscribe: () => () => {},
      projects: { list: async () => [{ id: "p1", name: "Personal" }] },
      threads: {
        get: async ({ threadId }: { threadId: string }) => (threadId === PI_THREAD ? piThread : secondThread),
        list: async (args?: { parentThreadId?: string }) => (args?.parentThreadId === undefined ? [piThread, secondThread] : []),
        timeline: async ({ threadId }: { threadId: string }) => ({ rows: threadId === PI_THREAD ? piRows() : [] }),
        storageLocation: async ({ threadId }: { threadId: string }) => ({ hostId: "host-1", storageRootPath: `/storage/${threadId}` }),
        events: { list: async ({ limit }: { limit?: string }) => {
          assert.ok(Number(limit ?? 100) <= 100, "Thread event limit cannot exceed 100");
          return (options.events ?? []).slice(0, Number(limit ?? 100));
        } },
      },
      files: {
        read: async ({ path }: { path: string }) => {
          const content = files.get(path);
          if (content === undefined) throw new Error(`ENOENT: no such file or directory, open '${path}'`);
          return { content, contentEncoding: "utf8" };
        },
      },
    },
  });
  return { bb: bb as BbPluginApi, harness, files, loaded: plugin(bb) };
}

const graph = (harness: ReturnType<typeof host>["harness"], threadId: string | null) =>
  harness.callRpc("graph", { threadId }) as Promise<Graph>;
const live = (harness: ReturnType<typeof host>["harness"], input: Record<string, unknown>) =>
  harness.callRpc("live", { itemId: null, workerId: null, cursor: null, ...input }) as Promise<LivePage>;

test("the focused graph of a pi thread carries tool call ids and folds workers into the delegations that launched them", async () => {
  const { harness, loaded } = host();
  await loaded;
  const result = await graph(harness, PI_THREAD);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));

  const thread = byId.get(PI_THREAD)!;
  assert.equal(thread.kind, "thread");
  assert.equal(thread.status, "running");

  const bash = result.nodes.find((node) => node.label === "Bash")!;
  assert.equal(bash.kind, "tool");
  assert.equal(bash.meta.itemId, "call-1");
  assert.equal(bash.parentId, `${PI_THREAD}:turn:t1`);

  // The delegation row and the worker it launched are one node, not two.
  const delegations = result.nodes.filter((node) => node.meta.piWorkerId === "task-1");
  assert.equal(delegations.length, 1);
  const delegation = delegations[0]!;
  assert.equal(delegation.id, `${PI_THREAD}:w2`);
  assert.equal(delegation.kind, "subagent");
  assert.equal(delegation.status, "running");
  assert.equal(delegation.meta.itemId, "item-9");
  assert.equal(byId.has(`${PI_THREAD}:pi:task-1`), false);

  // Workers with no delegation of their own still show up, under the thread.
  const unmatched = byId.get(`${PI_THREAD}:pi:task-7`)!;
  assert.equal(unmatched.parentId, PI_THREAD);
  assert.equal(unmatched.status, "queued");
  assert.equal(byId.get(`${PI_THREAD}:pi:task-8`)!.status, "done");

  // A worker that failed says so, with what went wrong.
  const failed = byId.get(`${PI_THREAD}:pi:task-9`)!;
  assert.equal(failed.status, "error");
  assert.match(failed.output!, /worker crashed after its first step/);

  // Nothing in the graph names a file on the host.
  assert.doesNotMatch(JSON.stringify(result.nodes), /\.jsonl/);
});

test("the overview reads pi state only for pi threads", async () => {
  const { harness, loaded } = host();
  await loaded;
  const result = await graph(harness, null);
  const ids = new Set(result.nodes.map((node) => node.id));
  assert.ok(ids.has("root"));
  assert.ok(ids.has("project:p1"));
  assert.ok(ids.has(PI_THREAD));
  assert.ok(ids.has(NATIVE_THREAD));
  assert.ok(ids.has(`${PI_THREAD}:pi:task-7`));
  assert.equal(
    result.nodes.some((node) => node.meta.piWorkerId !== undefined && node.threadId !== PI_THREAD),
    false,
  );
  assert.deepEqual(
    harness.sdk.callsTo("threads.storageLocation").map(([args]) => (args as { threadId: string }).threadId),
    [PI_THREAD],
  );
});

test("pi-pi workers respect the graph's node cap and report truncation", async () => {
  const workers=Array.from({length:1000},(_,i)=>piWorker({id:`task-${i}`}));
  const {harness,loaded}=host({workers,secondPi:true});
  await loaded;
  const result=await graph(harness,null);
  assert.equal(result.nodes.length,1500);
  assert.equal(result.truncated,true);
  const ids=new Set(result.nodes.map(node=>node.id));
  assert.ok(result.nodes.every(node=>node.parentId===null || ids.has(node.parentId)));
});

test("live on a selected tool call streams that item's output and not another's", async () => {
  const events = [
    { seq: 1, type: "item/started", data: { item: { id: "tool-1", type: "commandExecution", command: "npm test" } }, createdAt: 1 },
    { seq: 2, type: "item/commandExecution/outputDelta", data: { itemId: "tool-1", delta: "tests pass\n" }, createdAt: 2 },
    { seq: 3, type: "item/commandExecution/outputDelta", data: { itemId: "tool-other", delta: "other-item-output\n" }, createdAt: 3 },
  ];
  const { harness, loaded } = host({ events });
  await loaded;
  const page = await live(harness, { threadId: NATIVE_THREAD, itemId: "tool-1" });
  assert.equal(page.source, "events");
  assert.match(page.text, /npm test/);
  assert.match(page.text, /tests pass/);
  assert.doesNotMatch(page.text, /other-item-output/);
  assert.ok(page.cursor);
});

test("live on a worker reads the transcript the thread's own pi state names, and nothing a caller asks for", async () => {
  const { harness, loaded } = host();
  await loaded;
  const page = await live(harness, { threadId: PI_THREAD, workerId: "task-1" });
  assert.equal(page.source, "transcript");
  assert.match(page.text, /worker prompt/);
  assert.match(page.text, /worker answer/);
  assert.equal(page.warning, null);

  const reads = harness.sdk.callsTo("files.read").map(([args]) => args as { hostId: string; path: string });
  assert.deepEqual(
    reads.map((args) => args.path),
    [`/storage/${PI_THREAD}/pi-pi/state.json`, TRANSCRIPT],
  );
  assert.equal(reads[1]!.hostId, "host-1");

  // A path the caller names is not part of the request: it is dropped, and
  // the read still goes to the file the thread's own state named.
  const named = await live(harness, { threadId: PI_THREAD, workerId: "task-1", path: "/etc/passwd" } as Record<string, unknown>);
  assert.equal(named.source, "transcript");
  assert.match(named.text, /worker answer/);
  // A worker the thread's state does not list has no file to read.
  await assert.rejects(live(harness, { threadId: PI_THREAD, workerId: "task-404" }), /Worker state is unavailable/);
  assert.deepEqual(
    harness.sdk.callsTo("files.read").map(([args]) => (args as { path: string }).path),
    [`/storage/${PI_THREAD}/pi-pi/state.json`, TRANSCRIPT, `/storage/${PI_THREAD}/pi-pi/state.json`, `/storage/${PI_THREAD}/pi-pi/state.json`],
  );
});

test("a worker whose pi-pi does not expose a transcript falls back to its output tail", async () => {
  const { harness, loaded } = host({ workers: [piWorker({ id: "task-1" })] });
  await loaded;
  const page = await live(harness, { threadId: PI_THREAD, workerId: "task-1" });
  assert.equal(page.source, "preview");
  assert.match(page.text, /thinking about it/);
  assert.match(page.warning!, /only the latest output/);
  assert.deepEqual(
    harness.sdk.callsTo("files.read").map(([args]) => (args as { path: string }).path),
    [`/storage/${PI_THREAD}/pi-pi/state.json`],
  );
});

test("a worker's processes hang under it as tool nodes, root before child, and never as a second worker", async () => {
  const processes = [
    piProcess({ id: "proc-1", command: "npm run build" }),
    piProcess({
      id: "proc-2",
      rootId: "proc-1",
      parentId: "proc-1",
      command: "node build.js",
      pid: 4243,
      ppid: 4242,
      status: "exited",
      endedAt: NOW - 20_000,
      exitCode: 0,
      outputCapture: "shared",
      // A child's output tail quotes a launch receipt; it is still a process.
      outputTail: "Started worker task-1 (task: Do the thing); it is still running.",
    }),
    piProcess({ id: "proc-3", command: "npm test", pid: 4244, status: "failed", endedAt: NOW - 15_000, exitCode: 1, signal: null }),
  ];
  const { harness, loaded } = host({ workers: [piWorker({ id: "task-1", transcriptFile: TRANSCRIPT, processes })] });
  await loaded;
  const result = await graph(harness, PI_THREAD);
  const byProcess = new Map(
    result.nodes.filter((node) => node.meta.piProcessId !== undefined).map((node) => [node.meta.piProcessId!, node]),
  );
  assert.deepEqual([...byProcess.keys()].sort(), ["proc-1", "proc-2", "proc-3"]);

  // A process node may name the worker it belongs to, but it is not one: a
  // process whose output quotes a launch receipt must not become a worker.
  const worker = result.nodes.filter(
    (node) => node.meta.piWorkerId === "task-1" && node.meta.piProcessId === undefined,
  );
  assert.equal(worker.length, 1, "the worker is one node, not one per process");
  assert.equal(worker[0]!.kind, "subagent");

  const root = byProcess.get("proc-1")!;
  assert.equal(root.kind, "tool");
  assert.equal(root.parentId, worker[0]!.id);
  assert.equal(root.status, "running");
  assert.equal(root.threadId, PI_THREAD);
  assert.match(JSON.stringify(root), /npm run build/, "the user can see what is running");

  // A descendant hangs off the process that spawned it, not off the worker.
  const child = byProcess.get("proc-2")!;
  assert.equal(child.parentId, root.id);
  assert.equal(child.status, "done");
  assert.equal(byProcess.get("proc-3")!.status, "error");

  // Nothing in the graph names a file or a thread's storage on the host.
  assert.doesNotMatch(JSON.stringify(result.nodes), /\.jsonl|\/storage\//);
});

test("a process still running under a finished worker wakes the thread, not the worker", async () => {
  const workers = [
    piWorker({
      id: "task-8",
      status: "completed",
      settledAt: NOW - 10_000,
      result: { status: "done", summary: "finished", body: "body" },
      processes: [piProcess({ id: "proc-1", status: "running" })],
    }),
  ];
  const { harness, loaded } = host({ workers });
  await loaded;
  const result = await graph(harness, null);
  const byId = new Map(result.nodes.map((node) => [node.id, node]));

  const worker = result.nodes.find((node) => node.meta.piWorkerId === "task-8")!;
  assert.equal(worker.status, "done", "the worker handed back; its process outliving it does not undo that");
  const process = result.nodes.find((node) => node.meta.piProcessId === "proc-1")!;
  assert.equal(process.status, "running");
  assert.equal(byId.get(PI_THREAD)!.status, "running");
  assert.equal(byId.get("project:p1")!.status, "running");
});

test("live on a selected process streams that process's own stdout and stderr, and stops at the cursor", async () => {
  const processes = [
    piProcess({ id: "proc-1" }),
    piProcess({ id: "proc-2", command: "npm test", pid: 4244 }),
  ];
  const logs = {
    [processLog("proc-1")]: processRows([
      { seq: 1, at: NOW - 30_000, kind: "start", text: "npm run build", status: "running" },
      { seq: 2, at: NOW - 29_000, kind: "stdout", text: "building…\n" },
    ]),
    [processLog("proc-2")]: processRows([{ seq: 1, at: NOW - 28_000, kind: "stdout", text: "other-process-output\n" }]),
  };
  const { harness, files, loaded } = host({ workers: [piWorker({ id: "task-1", transcriptFile: TRANSCRIPT, processes })], logs });
  await loaded;
  const page = await live(harness, { threadId: PI_THREAD, workerId: "task-1", processId: "proc-1" });
  assert.equal(page.source, "process");
  assert.match(page.text, /building…/);
  assert.doesNotMatch(page.text, /other-process-output/);
  assert.doesNotMatch(page.text, /worker answer/, "the worker's transcript is a different target");
  assert.equal(page.entries?.find((entry) => entry.kind === "stdout")?.at, NOW - 29_000);
  assert.deepEqual(
    harness.sdk.callsTo("files.read").map(([args]) => (args as { path: string }).path),
    [`/storage/${PI_THREAD}/pi-pi/state.json`, processLog("proc-1")],
  );
  assert.doesNotMatch(JSON.stringify(page), /\/storage\//, "neither the page nor its cursor carries a host path");

  // Output written after the page was served arrives once, without repeating
  // what was already shown. The wait is past the reader's short re-read
  // window for a running process.
  files.set(
    processLog("proc-1"),
    files.get(processLog("proc-1"))! +
      processRows([
        { seq: 3, at: NOW - 28_000, kind: "stderr", text: "warn: slow\n" },
        { seq: 4, at: NOW - 27_000, kind: "exit", exitCode: 3, signal: null, status: "exited" },
      ]),
  );
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const next = await live(harness, { threadId: PI_THREAD, workerId: "task-1", processId: "proc-1", cursor: page.cursor });
  assert.equal(next.reset, false);
  assert.doesNotMatch(next.text, /building…/);
  assert.equal(next.entries?.find((entry) => entry.kind === "stderr")?.text, "warn: slow\n");
  const exited = next.entries?.find((entry) => entry.exitCode !== undefined && entry.exitCode !== null)!;
  assert.equal(exited.exitCode, 3);
  assert.equal(exited.kind, "command");

  // A cursor from one process does not carry into another.
  const sibling = await live(harness, { threadId: PI_THREAD, workerId: "task-1", processId: "proc-2", cursor: next.cursor });
  assert.equal(sibling.reset, true);
  assert.match(sibling.text, /other-process-output/);
});

test("live refuses a process the thread's own state does not list, and reads no file a caller names", async () => {
  const processes = [piProcess({ id: "proc-1" })];
  const logs = { [processLog("proc-1")]: processRows([{ seq: 1, at: NOW - 30_000, kind: "stdout", text: "mine\n" }]) };
  const { harness, loaded } = host({ workers: [piWorker({ id: "task-1", transcriptFile: TRANSCRIPT, processes })], logs });
  await loaded;
  await assert.rejects(live(harness, { threadId: PI_THREAD, workerId: "task-1", processId: "proc-404" }), /Process/);
  await assert.rejects(live(harness, { threadId: PI_THREAD, workerId: "task-404", processId: "proc-1" }), /Worker/);
  await assert.rejects(live(harness, { threadId: PI_THREAD, workerId: "task-1", processId: "../../../etc/passwd" }), /process/i);
  await assert.rejects(live(harness, { threadId: PI_THREAD, workerId: null, processId: "proc-1" }), /process/i);
  assert.equal(
    harness.sdk.callsTo("files.read").some(([args]) => (args as { path: string }).path !== `/storage/${PI_THREAD}/pi-pi/state.json`),
    false,
    "a rejected target reads nothing but the thread's own state",
  );

  // Paths and log files a caller passes are not part of the request.
  const injected = await live(harness, {
    threadId: PI_THREAD,
    workerId: "task-1",
    processId: "proc-1",
    path: "/etc/passwd",
    logFile: "/etc/passwd",
  } as Record<string, unknown>);
  assert.equal(injected.source, "process");
  assert.match(injected.text, /mine/);
  assert.deepEqual(
    harness.sdk.callsTo("files.read").map(([args]) => (args as { path: string }).path).filter((path) => path.endsWith(".jsonl")),
    [processLog("proc-1")],
  );
});

test("a process that only shares its root's pipes says so instead of claiming its own output", async () => {
  const processes = [
    piProcess({ id: "proc-1" }),
    piProcess({ id: "proc-2", rootId: "proc-1", parentId: "proc-1", pid: 4243, outputCapture: "shared", logFile: undefined }),
    piProcess({ id: "proc-3", outputCapture: "unavailable", pid: 4244, logFile: undefined, outputTail: "stdout went somewhere else" }),
  ];
  const logs = { [processLog("proc-1")]: processRows([{ seq: 1, at: NOW - 30_000, kind: "stdout", text: "root and children share this pipe\n" }]) };
  const { harness, loaded } = host({ workers: [piWorker({ id: "task-1", transcriptFile: TRANSCRIPT, processes })], logs });
  await loaded;
  const shared = await live(harness, { threadId: PI_THREAD, workerId: "task-1", processId: "proc-2" });
  assert.equal(shared.source, "process");
  assert.match(shared.text, /share this pipe/);
  assert.match(shared.warning!, /shared|root/i);

  const uncaptured = await live(harness, { threadId: PI_THREAD, workerId: "task-1", processId: "proc-3" });
  assert.equal(uncaptured.source, "process");
  assert.match(uncaptured.text, /stdout went somewhere else/);
  assert.match(uncaptured.warning!, /captured|redirect|unavailable/i);
  assert.equal(
    harness.sdk.callsTo("files.read").filter(([args]) => (args as { path: string }).path.includes("/processes/")).length,
    1,
    "the uncaptured process has no log to read",
  );
});

test("a pi-pi that reports no processes is unchanged", async () => {
  const { harness, loaded } = host();
  await loaded;
  const result = await graph(harness, PI_THREAD);
  assert.equal(result.nodes.some((node) => node.meta.piProcessId !== undefined), false);
  const page = await live(harness, { threadId: PI_THREAD, workerId: "task-1" });
  assert.equal(page.source, "transcript");
  await assert.rejects(live(harness, { threadId: PI_THREAD, workerId: "task-1", processId: "proc-1" }), /Process/);
});

test("processes respect the graph's node cap too", async () => {
  const workers = Array.from({ length: 600 }, (_, index) =>
    piWorker({
      id: `task-${index}`,
      processes: [piProcess({ id: `proc-${index}-a` }), piProcess({ id: `proc-${index}-b`, rootId: `proc-${index}-a`, parentId: `proc-${index}-a` })],
    }),
  );
  const { harness, loaded } = host({ workers });
  await loaded;
  const result = await graph(harness, null);
  assert.equal(result.nodes.length, 1500);
  assert.equal(result.truncated, true);
});

test("a process killed by a signal reports its unknown exit code as null, not as a missing one", async () => {
  const processes = [piProcess({ id: "proc-1", status: "failed", exitCode: null, signal: "SIGKILL" })];
  const logs = {
    [processLog("proc-1")]: processRows([
      { seq: 1, at: NOW - 30_000, kind: "stdout", text: "working\n" },
      { seq: 2, at: NOW - 29_000, kind: "exit", exitCode: null, signal: "SIGKILL", status: "failed" },
    ]),
  };
  const { harness, loaded } = host({ workers: [piWorker({ id: "task-1", transcriptFile: TRANSCRIPT, processes })], logs });
  await loaded;
  const page = await live(harness, { threadId: PI_THREAD, workerId: "task-1", processId: "proc-1" });
  const exit = page.entries!.at(-1)!;
  assert.equal(exit.kind, "command");
  assert.equal(exit.exitCode, null);
  assert.ok("exitCode" in exit, "an unknown exit code is reported, not dropped with the absent keys");
  assert.match(page.text, /SIGKILL/);
});
