// Pure state and polling control for the live output panel: folds pages from
// the `live` RPC into the bounded text the panel shows, and sequences the
// reads. No React, so both are easy to test.
import type { Graph, GraphNode } from "./server";
import { isActive } from "./layout.ts";
import type { LiveEntry } from "./live-types.ts";

/** Where the backend read the text from, weakest last. */
export type LiveSource = "process" | "events" | "transcript" | "preview";

/** One page of live output, as the `live` RPC returns it. */
export interface LivePage {
  text: string;
  cursor: string | null;
  /** The backend lost the old position: replace the text instead of appending. */
  reset: boolean;
  hasMore: boolean;
  source: LiveSource;
  warning: string | null;
  /** Structured entries, when the backend sends them; older ones send none. */
  entries?: readonly LiveEntry[];
}

/** Characters kept in the panel; older output is dropped from the front. */
export const LIVE_TEXT_CAP = 200_000;
/** Entries kept in the panel; older ones are dropped from the front. */
export const LIVE_ENTRY_CAP = 1000;
/** Characters kept in one entry, so a single endless stream cannot fill the panel. */
export const LIVE_ENTRY_TEXT_CAP = 20_000;

export interface LiveState {
  text: string;
  /** Retained structured entries; empty when the backend sends none. */
  entries: LiveEntry[];
  /** Characters across `entries`, tracked so folding a delta stays cheap. */
  entryChars: number;
  cursor: string | null;
  source: LiveSource | null;
  warning: string | null;
  /** Output was dropped from the front to stay under the cap. */
  truncated: boolean;
  hasMore: boolean;
  /** Last failed read; the text before it is kept. */
  error: string | null;
  /** At least one page has arrived for the current target. */
  loaded: boolean;
  /** Client clock at the last successful read, not any entry's timestamp. */
  updatedAt: number | null;
}

export const emptyLiveState: LiveState = {
  text: "",
  entries: [],
  entryChars: 0,
  cursor: null,
  source: null,
  warning: null,
  truncated: false,
  hasMore: false,
  error: null,
  loaded: false,
  updatedAt: null,
};

const tail = (text: string): string =>
  text.length > LIVE_ENTRY_TEXT_CAP ? text.slice(text.length - LIVE_ENTRY_TEXT_CAP) : text;

/**
 * Merges a page's entries into the retained ones: a delta extends the entry it
 * names, anything else replaces it, and the oldest are dropped to stay under
 * the caps. Deltas almost always land on the newest entry, so the common case
 * costs one comparison however long the stream runs.
 */
function foldEntries(
  retained: LiveEntry[],
  chars: number,
  incoming: readonly LiveEntry[],
): { entries: LiveEntry[]; chars: number; dropped: boolean } {
  if (incoming.length === 0) return { entries: retained, chars, dropped: false };
  const entries = [...retained];
  let total = chars;
  for (const next of incoming) {
    const { append, ...fields } = next;
    let index = entries.length - 1;
    if (index < 0 || entries[index]!.id !== next.id) {
      index = -1;
      for (let probe = entries.length - 1; probe >= 0; probe -= 1) {
        if (entries[probe]!.id === next.id) {
          index = probe;
          break;
        }
      }
    }
    if (index < 0) {
      const created = { ...fields, text: tail(next.text) };
      entries.push(created);
      total += created.text.length;
      continue;
    }
    const current = entries[index]!;
    const text = tail(append === true ? current.text + next.text : next.text);
    entries[index] =
      append === true
        ? { ...current, ...fields, at: current.at ?? next.at, text }
        : { ...fields, text };
    total += text.length - current.text.length;
  }
  let dropped = false;
  while (entries.length > LIVE_ENTRY_CAP || total > LIVE_TEXT_CAP) {
    total -= entries.shift()!.text.length;
    dropped = true;
  }
  return { entries, chars: total, dropped };
}

export function applyLivePage(
  state: LiveState,
  page: LivePage,
  now: number = Date.now(),
): LiveState {
  const joined = (page.reset ? "" : state.text) + page.text;
  const excess = joined.length - LIVE_TEXT_CAP;
  const folded = foldEntries(
    page.reset ? [] : state.entries,
    page.reset ? 0 : state.entryChars,
    page.entries ?? [],
  );
  return {
    text: excess > 0 ? joined.slice(excess) : joined,
    entries: folded.entries,
    entryChars: folded.chars,
    cursor: page.cursor,
    source: page.source,
    warning: page.warning,
    truncated: excess > 0 || folded.dropped || (!page.reset && state.truncated),
    hasMore: page.hasMore,
    error: null,
    loaded: true,
    updatedAt: now,
  };
}

export function applyLiveError(state: LiveState, cause: unknown): LiveState {
  return {
    ...state,
    error: cause instanceof Error ? cause.message : String(cause),
  };
}

/**
 * Whether the graph shows pi-pi work in flight, which is the only reason to
 * refresh the whole graph faster than the slow heartbeat. A queued worker
 * counts: it starts between two slow beats. So does a process still running
 * under a worker that has already finished.
 */
export function hasRunningPiWork(graph: Graph | null): boolean {
  return (graph?.nodes ?? []).some(
    (node) =>
      ((node.meta.piWorkerId ?? "") !== "" || (node.meta.piProcessId ?? "") !== "") &&
      isActive(node.status),
  );
}

/** What one node's Live panel follows. */
export interface LiveTarget {
  threadId: string;
  itemId: string | null;
  workerId: string | null;
  /** pi-pi process whose own stream the backend prefers over the worker's log. */
  processId: string | null;
}

/**
 * The live target for a node, or null when there is nothing to follow. A
 * native delegation that spawned its own thread is followed as that thread,
 * whose log is the full story; everything else is followed inside the node's
 * own thread, narrowed to a pi process, a pi worker or a tool call when it
 * names one.
 */
export function liveTargetFor(node: GraphNode): LiveTarget | null {
  if (node.kind === "more") return null;
  const workerId = node.meta.piWorkerId || null;
  const processId = node.meta.piProcessId || null;
  const child = node.meta.thread ?? "";
  if (workerId === null && node.kind === "subagent" && child.startsWith("thr_")) {
    return { threadId: child, itemId: null, workerId: null, processId: null };
  }
  if (node.threadId === null) return null;
  return { threadId: node.threadId, itemId: node.meta.itemId || null, workerId, processId };
}

/** Idle cadence between reads of active work. */
export const LIVE_POLL_MS = 1000;
/** Idle cadence once the node has stopped: its log can still grow, slowly. */
export const LIVE_SLOW_POLL_MS = 10_000;
/** Pause between pages while draining a backlog, and how many to drain at once. */
export const LIVE_DRAIN_MS = 120;
export const LIVE_MAX_DRAIN = 5;
/** A failed read waits longer, so a broken target never spins. */
export const LIVE_ERROR_MS = 5000;

export interface LiveControllerDeps<Timer> {
  read: () => Promise<LivePage>;
  onPage: (page: LivePage) => void;
  onError: (cause: unknown) => void;
  /** Cadence between reads once the backlog is drained. */
  pollMs: number;
  /** Reads stop while the panel cannot be seen; `wake` resumes them. */
  isHidden: () => boolean;
  schedule: (run: () => void, delay: number) => Timer;
  cancel: (timer: Timer) => void;
}

export interface LiveController {
  start(): void;
  /** The panel became visible again. */
  wake(): void;
  stop(): void;
}

/**
 * Sequences reads of one target: never two at once, never a tight retry, and
 * nothing delivered after `stop` — so a target change cannot interleave pages
 * or rewind the cursor.
 */
export function createLiveController<Timer>(
  deps: LiveControllerDeps<Timer>,
): LiveController {
  let stopped = false;
  let inFlight = false;
  let timer: Timer | null = null;
  let drained = 0;

  const schedule = (delay: number) => {
    if (stopped || inFlight || timer !== null) return;
    timer = deps.schedule(read, delay);
  };

  const read = () => {
    timer = null;
    if (stopped || inFlight) return;
    // Nothing to watch while hidden: leave no timer, and wait for `wake`.
    if (deps.isHidden()) return;
    inFlight = true;
    const fail = (cause: unknown) => {
      inFlight = false;
      if (stopped) return;
      drained = 0;
      deps.onError(cause);
      schedule(LIVE_ERROR_MS);
    };
    try {
      deps.read().then((page) => {
        inFlight = false;
        if (stopped) return;
        deps.onPage(page);
        const drain = page.hasMore && drained < LIVE_MAX_DRAIN;
        drained = drain ? drained + 1 : 0;
        schedule(drain ? LIVE_DRAIN_MS : deps.pollMs);
      }, fail);
    } catch (cause) {
      // A read that throws before returning a promise must not wedge the loop.
      fail(cause);
    }
  };

  return {
    start: read,
    wake: () => schedule(0),
    stop: () => {
      stopped = true;
      if (timer !== null) {
        deps.cancel(timer);
        timer = null;
      }
    },
  };
}
