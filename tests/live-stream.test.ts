import assert from "node:assert/strict";
import { test } from "node:test";
import type { GraphNode } from "../server.ts";
import {
  applyLiveError,
  applyLivePage,
  createLiveController,
  emptyLiveState,
  hasRunningPiWork,
  LIVE_DRAIN_MS,
  LIVE_ENTRY_CAP,
  LIVE_ENTRY_TEXT_CAP,
  LIVE_ERROR_MS,
  LIVE_MAX_DRAIN,
  LIVE_POLL_MS,
  LIVE_SLOW_POLL_MS,
  LIVE_TEXT_CAP,
  liveTargetFor,
  type LivePage,
} from "../live-stream.ts";
import type { LiveEntry } from "../live-types.ts";

const entry = (overrides: Partial<LiveEntry> = {}): LiveEntry => ({
  id: "e1",
  at: 1_700_000_000_000,
  kind: "stdout",
  text: "out",
  ...overrides,
});

const page = (overrides: Partial<LivePage> = {}): LivePage => ({
  text: "",
  cursor: "c1",
  reset: false,
  hasMore: false,
  source: "events",
  warning: null,
  ...overrides,
});

const node = (overrides: Partial<GraphNode> = {}): GraphNode => ({
  id: "n1",
  parentId: null,
  kind: "subagent",
  label: "worker",
  sublabel: null,
  status: "running",
  threadId: "thr_1",
  startedAt: null,
  completedAt: null,
  input: null,
  output: null,
  meta: { piWorkerId: "w1" },
  ...overrides,
});

test("appends pages and follows the cursor", () => {
  const first = applyLivePage(emptyLiveState, page({ text: "hello " }));
  const second = applyLivePage(first, page({ text: "world", cursor: "c2", hasMore: true }));
  assert.equal(second.text, "hello world");
  assert.equal(second.cursor, "c2");
  assert.equal(second.hasMore, true);
  assert.equal(second.loaded, true);
  assert.equal(second.truncated, false);
});

test("a reset page replaces the text and clears the truncation note", () => {
  const long = applyLivePage(emptyLiveState, page({ text: "x".repeat(LIVE_TEXT_CAP + 10) }));
  assert.equal(long.truncated, true);
  assert.equal(long.text.length, LIVE_TEXT_CAP);
  const after = applyLivePage(long, page({ text: "fresh", reset: true }));
  assert.equal(after.text, "fresh");
  assert.equal(after.truncated, false);
});

test("drops the oldest output once the cap is passed", () => {
  const full = applyLivePage(emptyLiveState, page({ text: "a".repeat(LIVE_TEXT_CAP) }));
  const over = applyLivePage(full, page({ text: "bbb" }));
  assert.equal(over.text.length, LIVE_TEXT_CAP);
  assert.equal(over.text.endsWith("bbb"), true);
  assert.equal(over.text.startsWith("aa"), true);
  assert.equal(over.truncated, true);
});

test("an error keeps the text, and the next page clears it", () => {
  const some = applyLivePage(emptyLiveState, page({ text: "output", warning: "partial" }));
  const failed = applyLiveError(some, new Error("offline"));
  assert.equal(failed.text, "output");
  assert.equal(failed.error, "offline");
  assert.equal(applyLivePage(failed, page({ text: "!" })).error, null);
});

test("streamed deltas merge into the entry with the same id, snapshots replace", () => {
  const first = applyLivePage(
    emptyLiveState,
    page({ entries: [entry({ text: "he" }), entry({ id: "e2", text: "other" })] }),
  );
  const appended = applyLivePage(
    first,
    page({ entries: [entry({ text: "llo", append: true })] }),
  );
  assert.deepEqual(
    appended.entries.map((item) => [item.id, item.text]),
    [["e1", "hello"], ["e2", "other"]],
    "an append must merge in place and leave other entries alone",
  );
  const replaced = applyLivePage(
    appended,
    page({ entries: [entry({ text: "done", status: "ok", exitCode: 0 })] }),
  );
  assert.deepEqual(replaced.entries[0], entry({ text: "done", status: "ok", exitCode: 0 }));
  assert.equal(replaced.entries.length, 2);
});

test("an append for an unknown id starts a new entry", () => {
  const state = applyLivePage(
    emptyLiveState,
    page({ entries: [entry({ id: "e9", text: "tail", append: true })] }),
  );
  assert.deepEqual(
    state.entries.map((item) => [item.id, item.text, item.append]),
    [["e9", "tail", undefined]],
  );
});

test("a reset page clears retained entries", () => {
  const state = applyLivePage(emptyLiveState, page({ entries: [entry()] }));
  const after = applyLivePage(state, page({ reset: true, entries: [entry({ id: "e2" })] }));
  assert.deepEqual(after.entries.map((item) => item.id), ["e2"]);
});

test("retains at most LIVE_ENTRY_CAP entries, dropping the oldest", () => {
  const many = Array.from({ length: LIVE_ENTRY_CAP + 5 }, (_, index) =>
    entry({ id: `e${index}`, text: "x" }),
  );
  const state = applyLivePage(emptyLiveState, page({ entries: many }));
  assert.equal(state.entries.length, LIVE_ENTRY_CAP);
  assert.equal(state.entries[0]!.id, "e5");
  assert.equal(state.truncated, true);
});

test("retains at most LIVE_TEXT_CAP characters across entries", () => {
  const chunk = "y".repeat(LIVE_ENTRY_TEXT_CAP);
  const count = Math.ceil(LIVE_TEXT_CAP / LIVE_ENTRY_TEXT_CAP) + 2;
  let state = emptyLiveState;
  for (let index = 0; index < count; index += 1) {
    state = applyLivePage(state, page({ entries: [entry({ id: `e${index}`, text: chunk })] }));
  }
  const total = state.entries.reduce((sum, item) => sum + item.text.length, 0);
  assert.ok(total <= LIVE_TEXT_CAP, `kept ${total} characters`);
  assert.equal(state.entries.at(-1)!.id, `e${count - 1}`);
  assert.equal(state.truncated, true);
});

test("one giant entry keeps its tail instead of growing without bound", () => {
  let state = applyLivePage(emptyLiveState, page({ entries: [entry({ text: "start" })] }));
  for (let index = 0; index < 40; index += 1) {
    state = applyLivePage(
      state,
      page({ entries: [entry({ text: `${index}:`.padEnd(1000, "z"), append: true })] }),
    );
  }
  const only = state.entries[0]!;
  assert.equal(state.entries.length, 1);
  assert.equal(only.text.length, LIVE_ENTRY_TEXT_CAP);
  assert.equal(only.text.endsWith("z"), true);
  assert.equal(only.text.includes("start"), false, "the head must be dropped, not the tail");
  assert.equal(state.truncated, true, "clipping one entry is still lost output; say so");
});

test("a single oversized entry reports the loss even when little is retained", () => {
  const state = applyLivePage(
    emptyLiveState,
    page({ entries: [entry({ text: "m" + "x".repeat(LIVE_ENTRY_TEXT_CAP) })] }),
  );
  assert.equal(state.entries[0]!.text.length, LIVE_ENTRY_TEXT_CAP);
  assert.equal(state.entries[0]!.text.startsWith("m"), false, "the leading marker is gone");
  assert.equal(state.truncated, true);
});

test("a large stream stays bounded and cheap to fold", () => {
  const chunk = "q".repeat(1000);
  let state = emptyLiveState;
  const started = Date.now();
  for (let index = 0; index < 20_000; index += 1) {
    state = applyLivePage(
      state,
      page({
        entries: [
          entry({ id: `e${index % 500}`, text: chunk, append: true }),
        ],
      }),
    );
  }
  const total = state.entries.reduce((sum, item) => sum + item.text.length, 0);
  assert.ok(state.entries.length <= LIVE_ENTRY_CAP);
  assert.ok(total <= LIVE_TEXT_CAP, `kept ${total} characters`);
  assert.ok(Date.now() - started < 5000, "folding 20MB must not grow quadratically");
});

test("a command entry keeps its command while its output streams in", () => {
  const started = applyLivePage(
    emptyLiveState,
    page({
      entries: [entry({ id: "c1", kind: "command", text: "", command: "npm test", status: "running" })],
    }),
  );
  const streamed = applyLivePage(
    started,
    page({ entries: [entry({ id: "c1", kind: "command", text: "58 passing", append: true })] }),
  );
  const finished = applyLivePage(
    streamed,
    page({
      entries: [
        entry({ id: "c1", kind: "command", text: "", append: true, status: "failed", exitCode: 1 }),
      ],
    }),
  );
  assert.deepEqual(finished.entries[0]!.command, "npm test");
  assert.equal(finished.entries.length, 1);
  assert.equal(finished.entries[0]!.text, "58 passing");
  assert.equal(finished.entries[0]!.status, "failed");
  assert.equal(finished.entries[0]!.exitCode, 1);
});

test("a delta keeps the time the entry first appeared", () => {
  const started = applyLivePage(
    emptyLiveState,
    page({ entries: [entry({ id: "c1", at: 1000, text: "a" })] }),
  );
  const later = applyLivePage(
    started,
    page({ entries: [entry({ id: "c1", at: 9000, text: "b", append: true })] }),
  );
  assert.equal(later.entries[0]!.at, 1000, "a delta must not restamp the entry");
  assert.equal(later.entries[0]!.text, "ab");
  // An entry that arrived without a time takes the first one a delta brings.
  const unknown = applyLivePage(
    emptyLiveState,
    page({ entries: [entry({ id: "c2", at: null, text: "a" })] }),
  );
  assert.equal(
    applyLivePage(unknown, page({ entries: [entry({ id: "c2", at: 9000, text: "b", append: true })] }))
      .entries[0]!.at,
    9000,
  );
});

test("an error keeps retained entries", () => {
  const state = applyLivePage(emptyLiveState, page({ entries: [entry()] }));
  const failed = applyLiveError(state, new Error("offline"));
  assert.deepEqual(failed.entries, state.entries);
  assert.equal(failed.updatedAt, state.updatedAt, "a failed read is not a successful one");
});

test("updatedAt is the time of the read, never an entry timestamp", () => {
  const state = applyLivePage(emptyLiveState, page({ entries: [entry({ at: 1 })] }), 5000);
  assert.equal(state.updatedAt, 5000);
});

test("an old backend without entries leaves the text view alone", () => {
  const state = applyLivePage(emptyLiveState, page({ text: "plain" }));
  assert.deepEqual(state.entries, []);
  assert.equal(state.text, "plain");
});

test("only active pi workers ask for a faster graph refresh", () => {
  const graph = (nodes: GraphNode[]) => ({ nodes, generatedAt: 0, truncated: false });
  assert.equal(hasRunningPiWork(null), false);
  assert.equal(hasRunningPiWork(graph([node()])), true);
  assert.equal(hasRunningPiWork(graph([node({ status: "queued" })])), true);
  assert.equal(hasRunningPiWork(graph([node({ status: "done" })])), false);
  assert.equal(hasRunningPiWork(graph([node({ status: "idle" })])), false);
  assert.equal(hasRunningPiWork(graph([node({ meta: {} })])), false);
  // A process still running under a finished worker keeps the fast cadence.
  assert.equal(
    hasRunningPiWork(graph([node({ meta: { piProcessId: "p1" }, status: "running" })])),
    true,
  );
  assert.equal(
    hasRunningPiWork(graph([node({ meta: { piProcessId: "p1" }, status: "done" })])),
    false,
  );
});

/** A controller wired to a scheduler and a read the test resolves by hand. */
function harness(options: { hidden?: boolean; pollMs?: number; throws?: unknown } = {}) {
  const timers = new Map<number, { run: () => void; delay: number }>();
  const pending: {
    resolve: (page: LivePage) => void;
    reject: (cause: unknown) => void;
  }[] = [];
  const pages: LivePage[] = [];
  const errors: unknown[] = [];
  let hidden = options.hidden ?? false;
  let nextTimer = 0;
  const controller = createLiveController<number>({
    pollMs: options.pollMs ?? LIVE_POLL_MS,
    read: () => {
      if (options.throws !== undefined) throw options.throws;
      return new Promise<LivePage>((resolve, reject) => {
        pending.push({ resolve, reject });
      });
    },
    onPage: (received) => pages.push(received),
    onError: (cause) => errors.push(cause),
    isHidden: () => hidden,
    schedule: (run, delay) => {
      const id = nextTimer;
      nextTimer += 1;
      timers.set(id, { run, delay });
      return id;
    },
    cancel: (timer) => {
      timers.delete(timer);
    },
  });
  return {
    controller,
    pending,
    pages,
    errors,
    delays: () => [...timers.values()].map((timer) => timer.delay),
    show: () => {
      hidden = false;
    },
    /** Resolve the oldest read and let its continuation run. */
    deliver: async (overrides: Partial<LivePage> = {}) => {
      pending.shift()!.resolve(page(overrides));
      await Promise.resolve();
    },
    fail: async (cause: unknown) => {
      pending.shift()!.reject(cause);
      await Promise.resolve();
    },
    /** Run the one pending timer. */
    fire: () => {
      const [id, timer] = [...timers][0]!;
      timers.delete(id);
      timer.run();
    },
  };
}

test("waking while a read is in flight does not start a second one", async () => {
  const h = harness();
  h.controller.start();
  assert.equal(h.pending.length, 1);
  h.controller.wake();
  h.controller.wake();
  assert.equal(h.pending.length, 1);
  assert.deepEqual(h.delays(), [], "no timer may be armed while a read is in flight");
  await h.deliver({ text: "a" });
  assert.deepEqual(h.delays(), [LIVE_POLL_MS]);
});

test("a hidden panel reads nothing until it is woken", async () => {
  const h = harness({ hidden: true });
  h.controller.start();
  assert.equal(h.pending.length, 0);
  assert.deepEqual(h.delays(), [], "a hidden panel must not hold a timer");
  h.show();
  h.controller.wake();
  assert.deepEqual(h.delays(), [0]);
  h.fire();
  assert.equal(h.pending.length, 1);
});

test("drains a backlog at the drain cadence, then falls back to polling", async () => {
  const h = harness();
  h.controller.start();
  for (let index = 0; index < LIVE_MAX_DRAIN; index += 1) {
    await h.deliver({ hasMore: true });
    assert.deepEqual(h.delays(), [LIVE_DRAIN_MS]);
    h.fire();
  }
  await h.deliver({ hasMore: true });
  assert.deepEqual(h.delays(), [LIVE_POLL_MS]);
});

test("a failed read backs off and keeps polling", async () => {
  const h = harness();
  h.controller.start();
  await h.fail(new Error("offline"));
  assert.deepEqual(h.errors.map(String), ["Error: offline"]);
  assert.deepEqual(h.delays(), [LIVE_ERROR_MS]);
});

test("stopping drops the read in flight and cancels the timer", async () => {
  const h = harness();
  h.controller.start();
  h.controller.stop();
  await h.deliver({ text: "late" });
  assert.deepEqual(h.pages, []);
  assert.deepEqual(h.delays(), []);
  h.controller.wake();
  assert.deepEqual(h.delays(), [], "a stopped controller must stay stopped");
});

test("an inactive node polls on the slow cadence", async () => {
  const h = harness({ pollMs: LIVE_SLOW_POLL_MS });
  h.controller.start();
  await h.deliver();
  assert.deepEqual(h.delays(), [LIVE_SLOW_POLL_MS]);
});

test("a backlog still drains quickly on the slow cadence", async () => {
  const h = harness({ pollMs: LIVE_SLOW_POLL_MS });
  h.controller.start();
  await h.deliver({ hasMore: true });
  assert.deepEqual(h.delays(), [LIVE_DRAIN_MS]);
});

test("a read that throws synchronously backs off instead of wedging", async () => {
  const boom = new Error("read exploded");
  const h = harness({ throws: boom });
  h.controller.start();
  assert.deepEqual(h.errors, [boom]);
  assert.deepEqual(h.delays(), [LIVE_ERROR_MS]);
  // The failed read must not leave the controller believing one is in flight.
  h.fire();
  assert.deepEqual(h.errors, [boom, boom]);
});

test("stopping after a page cancels the armed timer", async () => {
  const h = harness();
  h.controller.start();
  await h.deliver({ text: "a" });
  assert.deepEqual(h.delays(), [LIVE_POLL_MS]);
  h.controller.stop();
  assert.deepEqual(h.delays(), [], "the pending timer must be cancelled");
});

test("picks the live target for each kind of node", () => {
  assert.deepEqual(liveTargetFor(node()), {
    threadId: "thr_1",
    itemId: null,
    workerId: "w1",
    processId: null,
  });
  assert.deepEqual(liveTargetFor(node({ kind: "tool", meta: { itemId: "itm_2" } })), {
    threadId: "thr_1",
    itemId: "itm_2",
    workerId: null,
    processId: null,
  });
  // A native delegation with its own thread: follow that thread's whole log.
  assert.deepEqual(
    liveTargetFor(node({ meta: { itemId: "itm_3", thread: "thr_child" } })),
    { threadId: "thr_child", itemId: null, workerId: null, processId: null },
  );
  // A pi worker is followed as a worker even when it has a child thread.
  assert.deepEqual(
    liveTargetFor(node({ meta: { piWorkerId: "w1", thread: "thr_child" } })),
    { threadId: "thr_1", itemId: null, workerId: "w1", processId: null },
  );
  // A process node streams its own output, inside its worker's thread.
  assert.deepEqual(
    liveTargetFor(
      node({
        kind: "tool",
        meta: { kind: "process", piProcessId: "p1", piWorkerId: "w1", itemId: "itm_4" },
      }),
    ),
    { threadId: "thr_1", itemId: "itm_4", workerId: "w1", processId: "p1" },
  );
  assert.equal(liveTargetFor(node({ kind: "more" })), null);
  assert.equal(liveTargetFor(node({ threadId: null, meta: {} })), null);
});
