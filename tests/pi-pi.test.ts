import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPiReader,
  mergePiWorkers,
  type PiReaderApi,
  type PiProcess,
  type PiSnapshot,
  type PiWorker,
} from "../pi-pi.ts";
import type { GraphNode } from "../server.ts";

const THREAD = "thr_demo";
const HEARTBEAT = 1_700_000_000_000;

type FakeApi = PiReaderApi & {
  warnings: string[];
  locations: number;
  reads: string[];
  signals: Array<AbortSignal | undefined>;
  file: string | null;
  fail: Error | null;
};

function fakeApi(file: string | null): FakeApi {
  const api: FakeApi = {
    warnings: [],
    locations: 0,
    reads: [],
    signals: [],
    file,
    fail: null,
    sdk: {
      threads: {
        storageLocation: async ({ threadId, signal }) => {
          api.locations++;
          api.signals.push(signal);
          return { hostId: "host-1", storageRootPath: `/storage/${threadId}` };
        },
      },
      files: {
        read: async ({ path, signal }) => {
          api.reads.push(path);
          api.signals.push(signal);
          if (api.fail) throw api.fail;
          if (api.file === null) throw new Error("ENOENT: no such file or directory");
          return { content: api.file, contentEncoding: "utf8" as const };
        },
      },
    },
    log: { warn: (message: string) => api.warnings.push(message) },
  };
  return api;
}

// `processes` stays loose: these fixtures feed the reader shapes it must survive.
function worker(
  overrides: Partial<Omit<PiWorker, "processes">> & { id: string; processes?: unknown },
): Record<string, unknown> {
  return {
    type: "task",
    description: "Do the thing",
    prompt: "Please do the thing",
    status: "running",
    model: "anthropic/claude",
    createdAt: HEARTBEAT - 60_000,
    startedAt: HEARTBEAT - 59_000,
    lastEventAt: HEARTBEAT - 1_000,
    silent: false,
    toolUses: 7,
    tokens: 1234,
    outputTail: "thinking about it",
    ...overrides,
  };
}

function proc(overrides: Partial<PiProcess> & { id: string }): Record<string, unknown> {
  return {
    rootId: overrides.id,
    toolCallId: "call-1",
    toolName: "bash",
    command: "npm test",
    pid: 4321,
    ppid: 4320,
    startedAt: HEARTBEAT - 30_000,
    status: "running",
    outputCapture: "pipes",
    outputTail: "running tests",
    ...overrides,
  };
}

function stateJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    pid: 42,
    live: true,
    heartbeatAt: HEARTBEAT,
    piPiVersion: "1.2.3",
    status: { text: "Thinking", level: "normal", since: HEARTBEAT - 5_000 },
    tasks: [],
    workers: [worker({ id: "task-1" })],
    commandResults: [],
    notices: [],
    ...extra,
  });
}

/** Runs `fn` with Date.now() pinned to `at`. */
async function at<T>(time: number, fn: () => Promise<T>): Promise<T> {
  const real = Date.now;
  Date.now = () => time;
  try {
    return await fn();
  } finally {
    Date.now = real;
  }
}

test("reads the thread's pi-pi state and times it on the reader's clock", async () => {
  const api = fakeApi(stateJson());
  const reader = createPiReader(api);
  const snapshot = await at(HEARTBEAT + 2_000, () => reader.read(THREAD));
  assert.ok(snapshot);
  assert.equal(snapshot.hostId, "host-1");
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.clockOffsetMs, 2_000);
  assert.equal(snapshot.state.workers.length, 1);
  assert.equal(snapshot.state.workers[0]!.id, "task-1");
  assert.deepEqual(api.reads, [`/storage/${THREAD}/pi-pi/state.json`]);
  assert.deepEqual(api.warnings, []);
});

test("caches the storage location across reads", async () => {
  const api = fakeApi(stateJson());
  const reader = createPiReader(api);
  await at(HEARTBEAT, () => reader.read(THREAD));
  await at(HEARTBEAT, () => reader.read(THREAD));
  assert.equal(api.locations, 1);
  assert.equal(api.reads.length, 2);
});

test("a missing state file is not an error and says nothing", async () => {
  const api = fakeApi(null);
  const reader = createPiReader(api);
  assert.equal(await reader.read(THREAD), null);
  assert.deepEqual(api.warnings, []);
});

test("ENOENT is silent even when a host uses a different error message", async () => {
  const api=fakeApi(null);
  api.fail=Object.assign(new Error("host path unavailable"),{code:"ENOENT"});
  assert.equal(await createPiReader(api).read(THREAD),null);
  assert.deepEqual(api.warnings,[]);
});

test("a read failure warns once per thread and reports no state", async () => {
  const api = fakeApi(stateJson());
  api.fail = new Error("host offline");
  const reader = createPiReader(api);
  assert.equal(await reader.read(THREAD), null);
  assert.equal(await reader.read(THREAD), null);
  assert.equal(api.warnings.length, 1);
  assert.match(api.warnings[0]!, /host offline/);
});

test("every probe carries a deadline", async () => {
  const api = fakeApi(stateJson());
  const reader = createPiReader(api);
  await reader.read(THREAD);
  assert.equal(api.signals.length, 2);
  for (const signal of api.signals) {
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  }
});

test("a failed read keeps serving the last good state, marked stale", async () => {
  const api = fakeApi(stateJson());
  const reader = createPiReader(api);
  const fresh = await at(HEARTBEAT, () => reader.read(THREAD));
  assert.equal(fresh!.stale, false);
  api.fail = new Error("host offline");
  const kept = await at(HEARTBEAT + 1_000, () => reader.read(THREAD));
  assert.equal(kept!.stale, true);
  assert.deepEqual(
    kept!.state.workers.map((entry) => entry.id),
    ["task-1"],
  );
  // A worker the transient failure caught mid-run must not look finished.
  const merged = mergePiWorkers([threadNode()], THREAD, kept!);
  assert.equal(merged[1]!.status, "interrupted");
});

test("a state file that goes away drops the last good state", async () => {
  const api = fakeApi(stateJson());
  const reader = createPiReader(api);
  await at(HEARTBEAT, () => reader.read(THREAD));
  api.file = null;
  assert.equal(await reader.read(THREAD), null);
  assert.deepEqual(api.warnings, []);
});

test("malformed or future state warns once and reports no state", async () => {
  const api = fakeApi("{not json");
  const reader = createPiReader(api);
  assert.equal(await at(HEARTBEAT, () => reader.read(THREAD)), null);
  assert.equal(api.warnings.length, 1);
  api.file = stateJson({ version: 2 });
  assert.equal(await at(HEARTBEAT, () => reader.read(THREAD)), null);
  assert.equal(api.warnings.length, 2);
  api.file = stateJson();
  assert.ok(await at(HEARTBEAT, () => reader.read(THREAD)));
  assert.equal(api.warnings.length, 2);
});

test("drops a worker whose id or status it cannot trust, and keeps the rest", async () => {
  const api = fakeApi(
    stateJson({
      workers: [
        worker({ id: "task-1", status: "exploded" as PiWorker["status"] }),
        worker({ id: "x".repeat(200) }),
        worker({ id: "task-2" }),
      ],
    }),
  );
  const reader = createPiReader(api);
  const snapshot = await at(HEARTBEAT, () => reader.read(THREAD));
  assert.deepEqual(
    snapshot!.state.workers.map((entry) => entry.id),
    ["task-2"],
  );
  assert.deepEqual(api.warnings, []);
});

test("keeps a transcript path whole, and drops an implausible one", async () => {
  const path = `/storage/${THREAD}/pi-pi/transcripts/${"deep/".repeat(60)}task-1.jsonl`;
  const api = fakeApi(
    stateJson({
      workers: [
        worker({ id: "task-1", transcriptFile: path }),
        worker({ id: "task-2", transcriptFile: "/x".repeat(4000) }),
      ],
    }),
  );
  const reader = createPiReader(api);
  const snapshot = await at(HEARTBEAT, () => reader.read(THREAD));
  assert.equal(snapshot!.state.workers[0]!.transcriptFile, path);
  assert.equal(snapshot!.state.workers[1]!.transcriptFile, undefined);
});

test("a shut-down session is stale", async () => {
  const api = fakeApi(stateJson({ live: false }));
  const reader = createPiReader(api);
  const snapshot = await at(HEARTBEAT, () => reader.read(THREAD));
  assert.equal(snapshot!.stale, true);
});

test("a heartbeat that stops moving goes stale on the reader's clock", async () => {
  const api = fakeApi(stateJson());
  const reader = createPiReader(api);
  // The pi clock is an hour behind the reader's: skew alone must not age it.
  const first = await at(HEARTBEAT + 3_600_000, () => reader.read(THREAD));
  assert.equal(first!.stale, false);
  const soon = await at(HEARTBEAT + 3_610_000, () => reader.read(THREAD));
  assert.equal(soon!.stale, false);
  const later = await at(HEARTBEAT + 3_620_000, () => reader.read(THREAD));
  assert.equal(later!.stale, true);
  api.file = stateJson({ heartbeatAt: HEARTBEAT + 3_619_000 });
  const beating = await at(HEARTBEAT + 3_620_100, () => reader.read(THREAD));
  assert.equal(beating!.stale, false);
  assert.equal(beating!.clockOffsetMs, 1_100);
});

function snapshotOf(
  workers: Array<Record<string, unknown>>,
  overrides: Partial<PiSnapshot> = {},
): PiSnapshot {
  return {
    state: {
      version: 1,
      live: true,
      heartbeatAt: HEARTBEAT,
      piPiVersion: "1.2.3",
      status: { text: "Thinking", level: "normal", since: HEARTBEAT },
      workers: workers as unknown as PiWorker[],
    },
    hostId: "host-1",
    stale: false,
    clockOffsetMs: 0,
    ...overrides,
  };
}

function node(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    parentId: THREAD,
    kind: "subagent",
    label: "Do the thing",
    sublabel: "task · 0 steps",
    status: "done",
    threadId: THREAD,
    startedAt: HEARTBEAT - 60_000,
    completedAt: HEARTBEAT - 59_000,
    input: "Do the thing",
    output: "Started worker task-1 (task: Do the thing); it is still running. Its result will arrive as a worker update; keep working.",
    meta: { itemId: "item-9", type: "task" },
    ...overrides,
  };
}

const threadNode = (status: GraphNode["status"] = "idle"): GraphNode => ({
  id: THREAD,
  parentId: "project:p1",
  kind: "thread",
  label: "A thread",
  sublabel: null,
  status,
  threadId: THREAD,
  startedAt: null,
  completedAt: null,
  input: null,
  output: null,
  meta: {},
});

test("enriches the delegation that launched a worker, and adds no second node", async () => {
  const nodes = [threadNode(), node({ id: "n1" })];
  const merged = mergePiWorkers(nodes, THREAD, snapshotOf([worker({ id: "task-1" })]));
  assert.equal(merged.length, 2);
  const delegation = merged.find((entry) => entry.id === "n1")!;
  assert.equal(delegation.kind, "subagent");
  assert.equal(delegation.status, "running");
  assert.equal(delegation.meta.piWorkerId, "task-1");
  assert.equal(delegation.meta.itemId, "item-9");
  assert.equal(delegation.meta.model, "anthropic/claude");
  assert.equal(delegation.meta["tool calls"], "7");
  assert.equal(delegation.completedAt, null);
  assert.match(delegation.output!, /thinking about it/);
  assert.doesNotMatch(delegation.output!, /Started worker/);
});

test("matches a node that already carries the worker id", () => {
  const nodes = [
    threadNode(),
    node({ id: "n1", output: "no receipt here", meta: { piWorkerId: "task-1" } }),
  ];
  const merged = mergePiWorkers(nodes, THREAD, snapshotOf([worker({ id: "task-1" })]));
  assert.equal(merged.length, 2);
  assert.equal(merged[1]!.status, "running");
});

test("turns a plain Agent tool call into a subagent", () => {
  const nodes = [threadNode(), node({ id: "n1", kind: "tool", label: "Agent", meta: {} })];
  const merged = mergePiWorkers(nodes, THREAD, snapshotOf([worker({ id: "task-1" })]));
  assert.equal(merged[1]!.kind, "subagent");
  assert.equal(merged[1]!.meta.piWorkerId, "task-1");
});

test("adds a node for a worker no delegation matches, under its thread", () => {
  const nodes = [threadNode()];
  const merged = mergePiWorkers(nodes, THREAD, snapshotOf([worker({ id: "task-9" })]));
  assert.equal(merged.length, 2);
  const added = merged[1]!;
  assert.equal(added.id, `${THREAD}:pi:task-9`);
  assert.equal(added.parentId, THREAD);
  assert.equal(added.kind, "subagent");
  assert.equal(added.meta.piWorkerId, "task-9");
  assert.equal(added.threadId, THREAD);
});

test("ignores nodes from another thread", () => {
  const other = node({ id: "n1", threadId: "thr_other", parentId: "thr_other" });
  const merged = mergePiWorkers([threadNode(), other], THREAD, snapshotOf([worker({ id: "task-1" })]));
  assert.equal(other.status, "done");
  assert.equal(merged.length, 3);
  assert.equal(merged[2]!.id, `${THREAD}:pi:task-1`);
});

test("ignores a turn or thread node that quotes the receipt", () => {
  const turn = node({ id: "t1", kind: "turn", label: "A turn" });
  const merged = mergePiWorkers([threadNode(), turn], THREAD, snapshotOf([worker({ id: "task-1" })]));
  assert.equal(turn.kind, "turn");
  assert.equal(turn.status, "done");
  assert.equal(merged[2]!.id, `${THREAD}:pi:task-1`);
});

test("a reused worker id lands on the newest launch, not the old one", () => {
  const old = node({ id: "n1", startedAt: HEARTBEAT - 900_000, completedAt: HEARTBEAT - 899_000 });
  const latest = node({ id: "n2", startedAt: HEARTBEAT - 60_000 });
  const merged = mergePiWorkers(
    [threadNode(), old, latest],
    THREAD,
    snapshotOf([worker({ id: "task-1" })]),
  );
  assert.equal(merged.length, 3);
  assert.equal(latest.status, "running");
  assert.equal(latest.meta.piWorkerId, "task-1");
  assert.equal(old.status, "done");
  assert.equal(old.meta.piWorkerId, undefined);
});

test("a stale snapshot leaves an active worker interrupted, never done", () => {
  const merged = mergePiWorkers(
    [threadNode(), node({ id: "n1" })],
    THREAD,
    snapshotOf([worker({ id: "task-1", status: "running" })], { stale: true }),
  );
  assert.equal(merged[1]!.status, "interrupted");
  assert.equal(merged[0]!.status, "idle");
});

test("maps each worker status, and a question waits", () => {
  const statuses = (entries: Array<Record<string, unknown>>) =>
    mergePiWorkers([threadNode()], THREAD, snapshotOf(entries))
      .slice(1)
      .map((entry) => entry.status);
  assert.deepEqual(
    statuses([
      worker({ id: "a", status: "queued" }),
      worker({ id: "b", status: "running" }),
      worker({ id: "c", status: "idle" }),
      worker({ id: "d", status: "completed", settledAt: HEARTBEAT }),
      worker({ id: "e", status: "failed", error: "it broke" }),
      worker({ id: "f", status: "stopped" }),
      worker({ id: "g", status: "killed" }),
      worker({ id: "h", status: "running", question: "which one?" }),
      worker({ id: "i", status: "idle", question: "which one?" }),
    ]),
    ["queued", "running", "done", "done", "error", "interrupted", "interrupted", "waiting", "waiting"],
  );
});

test("an idle worker neither runs nor keeps its thread waiting", () => {
  const merged = mergePiWorkers(
    [threadNode("idle")],
    THREAD,
    snapshotOf([worker({ id: "task-1", status: "idle" })]),
  );
  assert.equal(merged[0]!.status, "idle");
  assert.equal(merged[1]!.status, "done");
});

test("a stale question is no longer being asked", () => {
  const merged = mergePiWorkers(
    [threadNode("idle")],
    THREAD,
    snapshotOf([worker({ id: "task-1", status: "idle", question: "which one?" })], { stale: true }),
  );
  assert.equal(merged[1]!.status, "done");
  assert.equal(merged[0]!.status, "idle");
});

test("an active worker wakes its thread and ancestors, but never clears error or waiting", () => {
  const project: GraphNode = { ...threadNode(), id: "project:p1", parentId: "root", kind: "project", threadId: null };
  const root: GraphNode = { ...project, id: "root", parentId: null, kind: "root" };
  const merged = mergePiWorkers(
    [root, project, threadNode("idle")],
    THREAD,
    snapshotOf([worker({ id: "task-1", status: "running" })]),
  );
  assert.deepEqual(
    merged.slice(0, 3).map((entry) => entry.status),
    ["running", "running", "running"],
  );
  const kept = mergePiWorkers(
    [threadNode("error")],
    THREAD,
    snapshotOf([worker({ id: "task-1", status: "running" })]),
  );
  assert.equal(kept[0]!.status, "error");
  const waiting = mergePiWorkers(
    [threadNode("waiting")],
    THREAD,
    snapshotOf([worker({ id: "task-1", status: "running" })]),
  );
  assert.equal(waiting[0]!.status, "waiting");
});

test("settled workers leave the thread's status alone", () => {
  const merged = mergePiWorkers(
    [threadNode("idle")],
    THREAD,
    snapshotOf([worker({ id: "task-1", status: "completed", settledAt: HEARTBEAT })]),
  );
  assert.equal(merged[0]!.status, "idle");
});

test("shows a worker's result, bounded, and never its transcript path", () => {
  const body = "x".repeat(4000);
  const merged = mergePiWorkers(
    [threadNode()],
    THREAD,
    snapshotOf([
      worker({
        id: "task-1",
        status: "completed",
        settledAt: HEARTBEAT,
        transcriptFile: "/storage/thr_demo/pi-pi/transcripts/task-1.jsonl",
        result: { status: "done", summary: "All good", body },
      }),
    ]),
  );
  const added = merged[1]!;
  assert.ok(added.output!.length <= 1500);
  assert.match(added.output!, /All good/);
  const text = JSON.stringify(added);
  assert.doesNotMatch(text, /transcripts/);
});

test("puts remote timestamps on the reader's clock", () => {
  const merged = mergePiWorkers(
    [threadNode()],
    THREAD,
    snapshotOf([worker({ id: "task-1", status: "completed", startedAt: HEARTBEAT, settledAt: HEARTBEAT + 1_000 })], {
      clockOffsetMs: 10_000,
    }),
  );
  assert.equal(merged[1]!.startedAt, HEARTBEAT + 10_000);
  assert.equal(merged[1]!.completedAt, HEARTBEAT + 11_000);
});

test("a worker from an older pi-pi has no processes and adds no process nodes", () => {
  const merged = mergePiWorkers([threadNode()], THREAD, snapshotOf([worker({ id: "task-1" })]));
  assert.equal(merged.length, 2);
  assert.equal(merged[1]!.meta.piProcessId, undefined);
  assert.equal(merged[1]!.meta["active processes"], undefined);
});

test("an unknown processes shape drops the processes, and says one record was unreadable", async () => {
  const api = fakeApi(
    stateJson({ workers: [worker({ id: "task-1", processes: "not a list" })] }),
  );
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  assert.deepEqual(snapshot!.state.workers.map((entry) => entry.id), ["task-1"]);
  assert.deepEqual(snapshot!.state.workers[0]!.processes, []);
  assert.match(snapshot!.state.workers[0]!.processWarning!, /1 process entry could not be read/);
});

test("a worker that never mentions processes stays silent about them", async () => {
  const api = fakeApi(stateJson({ workers: [worker({ id: "task-1" })] }));
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  assert.equal(snapshot!.state.workers[0]!.processes, undefined);
  assert.equal(snapshot!.state.workers[0]!.processWarning, undefined);
});

test("hangs a worker's processes off it, roots first, children under their parent", () => {
  const merged = mergePiWorkers(
    [threadNode(), node({ id: "n1" })],
    THREAD,
    snapshotOf([
      worker({
        id: "task-1",
        processes: [
          proc({ id: "p3", rootId: "p1", parentId: "p2", command: "grandchild" }),
          proc({ id: "p2", rootId: "p1", parentId: "p1", command: "child" }),
          proc({ id: "p1", command: "npm test" }),
          proc({ id: "q1", command: "tail -f log" }),
        ],
      }),
    ]),
  );
  const ids = merged.map((entry) => entry.id);
  assert.deepEqual(ids.slice(2), [
    `${THREAD}:pi:task-1:process:p1`,
    `${THREAD}:pi:task-1:process:q1`,
    `${THREAD}:pi:task-1:process:p2`,
    `${THREAD}:pi:task-1:process:p3`,
  ]);
  const byId = new Map(merged.map((entry) => [entry.id, entry]));
  assert.equal(byId.get(`${THREAD}:pi:task-1:process:p1`)!.parentId, "n1");
  assert.equal(byId.get(`${THREAD}:pi:task-1:process:q1`)!.parentId, "n1");
  assert.equal(
    byId.get(`${THREAD}:pi:task-1:process:p2`)!.parentId,
    `${THREAD}:pi:task-1:process:p1`,
  );
  assert.equal(
    byId.get(`${THREAD}:pi:task-1:process:p3`)!.parentId,
    `${THREAD}:pi:task-1:process:p2`,
  );
  // Every node appears after the node it hangs from.
  merged.forEach((entry, index) => {
    if (entry.parentId === null) return;
    const parent = ids.indexOf(entry.parentId);
    if (parent !== -1) assert.ok(parent < index, `${entry.id} before its parent`);
  });
  const root = byId.get(`${THREAD}:pi:task-1:process:p1`)!;
  assert.equal(root.kind, "tool");
  assert.equal(root.threadId, THREAD);
  assert.equal(root.meta.piWorkerId, "task-1");
  assert.equal(root.meta.piProcessId, "p1");
  assert.equal(root.meta.kind, "process");
  assert.equal(root.meta.pid, "4321");
  assert.equal(root.label, "npm test");
  assert.match(root.sublabel!, /PID 4321/);
  assert.match(root.sublabel!, /running/);
  assert.equal(root.input, "npm test");
  assert.match(root.output!, /running tests/);
});

test("process nodes hang off a worker the graph added itself", () => {
  const merged = mergePiWorkers(
    [threadNode()],
    THREAD,
    snapshotOf([worker({ id: "task-9", processes: [proc({ id: "p1" })] })]),
  );
  assert.equal(merged[2]!.parentId, `${THREAD}:pi:task-9`);
});

test("a process node is never mistaken for the worker's own delegation", () => {
  const nodes = [threadNode(), node({ id: "n1" })];
  const snapshot = () =>
    snapshotOf([worker({ id: "task-1", processes: [proc({ id: "p1" })] })]);
  mergePiWorkers(nodes, THREAD, snapshot());
  const again = mergePiWorkers(nodes, THREAD, snapshot());
  assert.deepEqual(
    again.map((entry) => entry.id),
    [THREAD, "n1", `${THREAD}:pi:task-1:process:p1`],
  );
  const processNode = again[2]!;
  assert.equal(processNode.parentId, "n1");
  assert.equal(processNode.kind, "tool");
  assert.equal(processNode.meta.kind, "process");
});

test("never exports a process log path", () => {
  const merged = mergePiWorkers(
    [threadNode()],
    THREAD,
    snapshotOf([
      worker({
        id: "task-1",
        processes: [
          proc({
            id: "p1",
            logFile: "/storage/thr_demo/pi-pi/processes/p1.log",
            logTruncated: true,
          }),
        ],
      }),
    ]),
  );
  assert.doesNotMatch(JSON.stringify(merged), /\/storage\/|logFile/);
});

test("two processes that reused one pid stay two nodes", () => {
  const merged = mergePiWorkers(
    [threadNode()],
    THREAD,
    snapshotOf([
      worker({
        id: "task-1",
        processes: [
          proc({ id: "p1", pid: 777, status: "exited", exitCode: 0, endedAt: HEARTBEAT }),
          proc({ id: "p2", pid: 777 }),
        ],
      }),
    ]),
  );
  assert.deepEqual(
    merged.slice(2).map((entry) => entry.id),
    [`${THREAD}:pi:task-1:process:p1`, `${THREAD}:pi:task-1:process:p2`],
  );
  assert.deepEqual(
    merged.slice(2).map((entry) => entry.status),
    ["done", "running"],
  );
});

test("maps each process status, and a missing exit code is unknown rather than 0", () => {
  const merged = mergePiWorkers(
    [threadNode()],
    THREAD,
    snapshotOf([
      worker({
        id: "task-1",
        status: "completed",
        settledAt: HEARTBEAT,
        processes: [
          proc({ id: "a", status: "running" }),
          proc({ id: "b", status: "exited", exitCode: 0, endedAt: HEARTBEAT }),
          proc({ id: "c", status: "exited", endedAt: HEARTBEAT }),
          proc({ id: "d", status: "failed", exitCode: null, signal: "SIGKILL" }),
          proc({ id: "e", status: "unknown" }),
        ],
      }),
    ]),
  );
  const processes = merged.slice(2);
  assert.deepEqual(
    processes.map((entry) => entry.status),
    ["running", "done", "done", "error", "idle"],
  );
  assert.deepEqual(
    processes.map((entry) => entry.meta.exit),
    [undefined, "0", "unknown", "unknown", undefined],
  );
  assert.equal(processes[3]!.meta.signal, "SIGKILL");
  assert.equal(processes[4]!.meta.status, "unknown");
});

test("a done worker with a live process wakes the thread but stays done", () => {
  const project: GraphNode = { ...threadNode(), id: "project:p1", parentId: "root", kind: "project", threadId: null };
  const root: GraphNode = { ...project, id: "root", parentId: null, kind: "root" };
  const merged = mergePiWorkers(
    [root, project, threadNode("idle")],
    THREAD,
    snapshotOf([
      worker({
        id: "task-1",
        status: "completed",
        settledAt: HEARTBEAT,
        processes: [proc({ id: "p1", status: "running" })],
      }),
    ]),
  );
  assert.deepEqual(
    merged.slice(0, 3).map((entry) => entry.status),
    ["running", "running", "running"],
  );
  const workerNode = merged[3]!;
  assert.equal(workerNode.status, "done");
  assert.equal(workerNode.meta["active processes"], "1");
  assert.equal(merged[4]!.status, "running");
});

test("a stale snapshot leaves a running process interrupted, and wakes nothing", () => {
  const merged = mergePiWorkers(
    [threadNode("idle")],
    THREAD,
    snapshotOf(
      [
        worker({
          id: "task-1",
          status: "completed",
          settledAt: HEARTBEAT,
          processes: [proc({ id: "p1", status: "running" })],
        }),
      ],
      { stale: true },
    ),
  );
  assert.equal(merged[0]!.status, "idle");
  assert.equal(merged[2]!.status, "interrupted");
  assert.equal(merged[2]!.meta.state, "stale");
});

test("drops a process it cannot trust, keeps the rest of the worker", async () => {
  const api = fakeApi(
    stateJson({
      workers: [
        worker({
          id: "task-1",
          processes: [
            proc({ id: "bad-pid", pid: -1 }),
            proc({ id: "nan-pid", pid: Number.NaN }),
            proc({ id: "x".repeat(200) }),
            proc({ id: "no-status", status: "zombie" as PiProcess["status"] }),
            proc({ id: "ok" }),
          ],
        }),
      ],
    }),
  );
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  assert.deepEqual(
    snapshot!.state.workers[0]!.processes!.map((entry) => entry.id),
    ["ok"],
  );
  assert.deepEqual(api.warnings, []);
});

test("keeps a process whose metrics make no sense, without them", async () => {
  const api = fakeApi(
    stateJson({
      workers: [
        worker({
          id: "task-1",
          processes: [
            proc({ id: "p1", cpuPercent: -4, rssBytes: Number.POSITIVE_INFINITY, sampledAt: "soon" as unknown as number }),
            proc({ id: "p2", cpuPercent: 12.5, rssBytes: 48 * 1024 * 1024, sampledAt: HEARTBEAT }),
          ],
        }),
      ],
    }),
  );
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  const processes = snapshot!.state.workers[0]!.processes!;
  assert.deepEqual(processes.map((entry) => entry.id), ["p1", "p2"]);
  assert.equal(processes[0]!.cpuPercent, undefined);
  assert.equal(processes[0]!.rssBytes, undefined);
  assert.equal(processes[0]!.sampledAt, undefined);
  const merged = mergePiWorkers([threadNode()], THREAD, { ...snapshotOf([]), state: snapshot!.state });
  const measured = merged[3]!;
  assert.equal(measured.meta.cpu, "12.5%");
  assert.match(measured.meta.rss!, /48/);
  assert.match(measured.sublabel!, /48/);
  assert.ok(measured.sublabel!.length <= 80);
  assert.equal(merged[2]!.meta.cpu, undefined);
});

test("a missing or circular process parent still leaves a tree", () => {
  const merged = mergePiWorkers(
    [threadNode()],
    THREAD,
    snapshotOf([
      worker({
        id: "task-1",
        processes: [
          proc({ id: "orphan", rootId: "gone", parentId: "gone" }),
          proc({ id: "self", parentId: "self" }),
          proc({ id: "a", parentId: "b" }),
          proc({ id: "b", parentId: "a" }),
        ],
      }),
    ]),
  );
  const ids = new Set(merged.map((entry) => entry.id));
  const parentOf = new Map(merged.map((entry) => [entry.id, entry.parentId]));
  assert.equal(merged.length, 6);
  for (const entry of merged.slice(2)) {
    assert.ok(entry.parentId !== null && ids.has(entry.parentId), `${entry.id} is an orphan`);
    const seen = new Set<string>([entry.id]);
    let up = entry.parentId;
    while (up != null && parentOf.has(up)) {
      assert.ok(!seen.has(up), `${entry.id} is in a cycle`);
      seen.add(up);
      up = parentOf.get(up)!;
    }
  }
});

test("bounds how many processes one worker contributes", async () => {
  const many = Array.from({ length: 400 }, (_, index) => proc({ id: `p${index}` }));
  const api = fakeApi(stateJson({ workers: [worker({ id: "task-1", processes: many })] }));
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  assert.equal(snapshot!.state.workers[0]!.processes!.length, 128);
  const merged = mergePiWorkers([threadNode()], THREAD, snapshot!);
  assert.equal(merged.length, 130);
});

test("says what a process printed, bounded, with why it may be missing", () => {
  const merged = mergePiWorkers(
    [threadNode()],
    THREAD,
    snapshotOf([
      worker({
        id: "task-1",
        processWarning: "process sampling unavailable",
        processes: [
          proc({
            id: "p1",
            outputTail: "y".repeat(4000),
            outputCapture: "unavailable",
            warning: "could not sample",
            status: "failed",
            exitCode: 2,
            endedAt: HEARTBEAT,
          }),
        ],
      }),
    ]),
  );
  const added = merged[2]!;
  assert.ok(added.output!.length <= 1500);
  assert.match(added.output!, /exit 2/);
  assert.match(added.output!, /could not sample/);
  assert.equal(added.meta.outputCapture, "unavailable");
  assert.equal(merged[1]!.meta["process warning"], "process sampling unavailable");
});

test("puts process timestamps on the reader's clock", () => {
  const merged = mergePiWorkers(
    [threadNode()],
    THREAD,
    snapshotOf(
      [
        worker({
          id: "task-1",
          processes: [
            proc({ id: "p1", status: "exited", exitCode: 0, startedAt: HEARTBEAT, endedAt: HEARTBEAT + 1_000 }),
          ],
        }),
      ],
      { clockOffsetMs: 10_000 },
    ),
  );
  assert.equal(merged[2]!.startedAt, HEARTBEAT + 10_000);
  assert.equal(merged[2]!.completedAt, HEARTBEAT + 11_000);
});

test("does nothing when there are no workers", () => {
  const nodes = [threadNode(), node({ id: "n1" })];
  const merged = mergePiWorkers(nodes, THREAD, snapshotOf([]));
  assert.equal(merged.length, 2);
  assert.equal(merged[1]!.status, "done");
});

test("the process cap keeps what is still running, not merely what started first", async () => {
  const history = Array.from({ length: 129 }, (_, index) =>
    proc({
      id: `old-${index}`,
      status: "exited",
      exitCode: 0,
      startedAt: HEARTBEAT - 600_000 + index,
      endedAt: HEARTBEAT - 500_000 + index,
    }),
  );
  const api = fakeApi(
    stateJson({
      workers: [
        worker({
          id: "task-1",
          status: "completed",
          settledAt: HEARTBEAT,
          processes: [...history, proc({ id: "live-1", status: "running" })],
        }),
      ],
    }),
  );
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  const kept = snapshot!.state.workers[0]!.processes!;
  assert.equal(kept.length, 128);
  assert.equal(kept[0]!.id, "live-1");
  // The cap drops the oldest finished processes, never a live one.
  assert.equal(kept[1]!.id, "old-128");
  assert.equal(kept.at(-1)!.id, "old-2");
  assert.equal(
    kept.some((entry) => entry.id === "old-0" || entry.id === "old-1"),
    false,
  );
  assert.equal(snapshot!.state.workers[0]!.processWarning, undefined);

  const merged = mergePiWorkers([threadNode("idle")], THREAD, snapshot!);
  assert.equal(merged[0]!.status, "running");
  assert.equal(merged[1]!.status, "done");
  assert.equal(merged[1]!.meta["active processes"], "1");
  assert.ok(merged.some((entry) => entry.meta.piProcessId === "live-1" && entry.status === "running"));
});

test("a process whose parent the cap dropped hangs off its worker", async () => {
  const history = Array.from({ length: 128 }, (_, index) =>
    proc({ id: `old-${index}`, status: "exited", exitCode: 0, startedAt: HEARTBEAT - 600_000 + index }),
  );
  const api = fakeApi(
    stateJson({
      workers: [
        worker({
          id: "task-1",
          processes: [...history, proc({ id: "child", rootId: "old-0", parentId: "old-0" })],
        }),
      ],
    }),
  );
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  const merged = mergePiWorkers([threadNode()], THREAD, snapshot!);
  const child = merged.find((entry) => entry.meta.piProcessId === "child")!;
  assert.equal(child.parentId, `${THREAD}:pi:task-1`);
  assert.equal(merged.filter((entry) => entry.parentId === null).length, 0);
});

test("a process entry it cannot read is said to be missing, in the worker's own warning", async () => {
  const api = fakeApi(
    stateJson({
      workers: [
        worker({
          id: "task-1",
          processWarning: "sampling is unavailable on this host",
          processes: [proc({ id: "ok" }), proc({ id: "bad", pid: -1 }), { not: "a process" }],
        }),
      ],
    }),
  );
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  const parsed = snapshot!.state.workers[0]!;
  assert.deepEqual(parsed.processes!.map((entry) => entry.id), ["ok"]);
  assert.match(parsed.processWarning!, /sampling is unavailable on this host/);
  assert.match(parsed.processWarning!, /2 process entries/);
  assert.ok(parsed.processWarning!.length <= 200);
  const merged = mergePiWorkers([threadNode()], THREAD, snapshot!);
  assert.match(merged[1]!.meta["process warning"]!, /2 process entries/);
});

test("the cap alone is not reported as a failure to read", async () => {
  const many = Array.from({ length: 200 }, (_, index) => proc({ id: `p${index}` }));
  const api = fakeApi(stateJson({ workers: [worker({ id: "task-1", processes: many })] }));
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  assert.equal(snapshot!.state.workers[0]!.processes!.length, 128);
  assert.equal(snapshot!.state.workers[0]!.processWarning, undefined);
});

test("the producer's own process contract parses whole, and loses no field", async () => {
  const full = {
    id: "proc-1",
    rootId: "proc-1",
    parentId: undefined,
    toolCallId: "call-1",
    toolName: "bash",
    command: "npm run build",
    pid: 4321,
    ppid: 4320,
    startedAt: HEARTBEAT - 30_000,
    endedAt: HEARTBEAT - 1_000,
    status: "exited",
    exitCode: 0,
    signal: null,
    cpuPercent: 12.5,
    rssBytes: 48 * 1024 * 1024,
    sampledAt: HEARTBEAT - 2_000,
    outputTail: "built",
    logFile: "/storage/thr_demo/pi-pi/processes/proc-1.jsonl",
    logTruncated: false,
    outputCapture: "pipes",
    warning: "sampled once",
  };
  const api = fakeApi(stateJson({ workers: [worker({ id: "task-1", processes: [full] })] }));
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  const parsed = snapshot!.state.workers[0]!.processes![0]!;
  assert.deepEqual({ ...parsed, parentId: undefined }, { ...full, parentId: undefined });
  assert.equal(snapshot!.state.workers[0]!.processWarning, undefined);
});

test("a process without the identity or start the producer promises is dropped, and counted", async () => {
  const incomplete = (overrides: Record<string, unknown>) => {
    const entry = proc({ id: "p" }) as Record<string, unknown>;
    return { ...entry, ...overrides };
  };
  const api = fakeApi(
    stateJson({
      workers: [
        worker({
          id: "task-1",
          processes: [
            incomplete({ id: undefined }),
            incomplete({ rootId: undefined }),
            incomplete({ pid: undefined }),
            incomplete({ status: undefined }),
            incomplete({ startedAt: undefined }),
            proc({ id: "whole" }),
          ],
        }),
      ],
    }),
  );
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  const parsed = snapshot!.state.workers[0]!;
  assert.deepEqual(parsed.processes!.map((entry) => entry.id), ["whole"]);
  assert.match(parsed.processWarning!, /5 process entries/);
  assert.deepEqual(api.warnings, []);
});

test("the unreadable count reaches the node, and the producer's reason survives beside it", async () => {
  const reason = "Commands are no longer logged: this session has written as much as it keeps.".padEnd(80, ".");
  assert.equal(reason.length, 80);
  const api = fakeApi(
    stateJson({
      workers: [
        worker({
          id: "task-1",
          processWarning: reason,
          processes: [proc({ id: "valid" }), { id: "unreadable" }],
        }),
      ],
    }),
  );
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  const parsed = snapshot!.state.workers[0]!;
  assert.match(parsed.processWarning!, /^1 process entry could not be read/);
  assert.ok(parsed.processWarning!.includes(reason));
  const visible = mergePiWorkers([threadNode()], THREAD, snapshot!)[1]!.meta["process warning"]!;
  assert.match(visible, /1 process entry could not be read/);
  assert.ok(visible.includes(reason), "the producer's own reason reaches the node");
  assert.ok(visible.length <= 200);
});

test("a producer warning that fills the bound still leaves the count visible", async () => {
  const reason = "Host sampling unavailable: ".padEnd(200, "x");
  const api = fakeApi(
    stateJson({
      workers: [
        worker({
          id: "task-1",
          processWarning: reason,
          processes: [proc({ id: "valid" }), { id: "unreadable" }],
        }),
      ],
    }),
  );
  const snapshot = await at(HEARTBEAT, () => createPiReader(api).read(THREAD));
  const visible = mergePiWorkers([threadNode()], THREAD, snapshot!)[1]!.meta["process warning"]!;
  assert.match(visible, /1 process entry could not be read/);
  assert.match(visible, /Host sampling unavailable/);
  assert.ok(visible.length <= 200);
});
