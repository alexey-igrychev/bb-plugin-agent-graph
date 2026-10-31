import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createPiReader,
  mergePiWorkers,
  type PiReaderApi,
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

function worker(overrides: Partial<PiWorker> & { id: string }): Record<string, unknown> {
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

test("does nothing when there are no workers", () => {
  const nodes = [threadNode(), node({ id: "n1" })];
  const merged = mergePiWorkers(nodes, THREAD, snapshotOf([]));
  assert.equal(merged.length, 2);
  assert.equal(merged[1]!.status, "done");
});
