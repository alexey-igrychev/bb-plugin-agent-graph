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

function host(options: { workers?: Array<Record<string, unknown>>; events?: unknown[]; secondPi?: boolean } = {}) {
  const files = new Map<string, string>([
    [`/storage/${PI_THREAD}/pi-pi/state.json`, piState(options.workers ?? WORKERS)],
    [TRANSCRIPT, transcript],
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
  return { bb: bb as BbPluginApi, harness, loaded: plugin(bb) };
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
