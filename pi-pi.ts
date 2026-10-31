// pi-pi workers in the graph.
//
// pi-pi (the orchestrator extension for pi) runs its workers inside the main
// agent's process. bb's timeline carries what the main agent's tools report —
// the launch receipt, and later a worker's summary or handback — but not the
// per-worker stream: the delegation row completes at launch and has no child
// rows, so a running worker's steps are not in the timeline at all.
// Under bb, pi-pi mirrors what its workers are doing into the thread's storage
// directory (`pi-pi/state.json`), which is what this module reads — read-only,
// through the SDK's host file API, never the local filesystem.
//
// `createPiReader` turns that file into a snapshot; `mergePiWorkers` folds the
// snapshot into the graph server.ts has already built.
import { z } from "zod";
import type { GraphNode, NodeStatus } from "./server";

/** Where pi-pi writes its state, under the thread's storage root. */
const STATE_PATH = "pi-pi/state.json";
const TEXT_CAP = 1500;
const LABEL_CAP = 80;
/** Far above any real run; the graph's own node cap decides what is drawn. */
const MAX_WORKERS = 1000;
/** pi-pi rewrites the file every 5s while it lives; three misses mean gone. */
const STALE_MS = 15_000;
const MAX_CACHE = 200;
/** No probe of a possibly unreachable host may hold a graph build longer. */
const READ_TIMEOUT_MS = 10_000;
const MAX_PATH = 4096;

const piWorkerStatusSchema = z.enum([
  "queued",
  "running",
  "idle",
  "completed",
  "failed",
  "stopped",
  "killed",
]);

/** A string kept to `cap` characters rather than rejected: the file is foreign input. */
function bounded(cap: number) {
  return z
    .string()
    .transform((value) => (value.length > cap ? `${value.slice(0, cap - 1)}…` : value));
}

const piWorkerSchema = z.object({
  // Never clipped: a shortened id would collide with another worker's.
  id: z.string().min(1).max(120),
  type: bounded(80),
  description: bounded(200),
  prompt: bounded(TEXT_CAP).default(""),
  status: piWorkerStatusSchema,
  model: bounded(120).default(""),
  createdAt: z.number(),
  startedAt: z.number().optional(),
  settledAt: z.number().optional(),
  lastEventAt: z.number().default(0),
  toolUses: z.number().default(0),
  tokens: z.number().default(0),
  step: z.object({ label: bounded(LABEL_CAP), since: z.number() }).optional(),
  progress: bounded(200).optional(),
  outputTail: bounded(TEXT_CAP).default(""),
  question: bounded(TEXT_CAP).optional(),
  result: z
    .object({
      status: bounded(40),
      summary: bounded(400),
      body: bounded(TEXT_CAP),
    })
    .optional(),
  error: bounded(TEXT_CAP).optional(),
  // Newer pi-pi points at the worker's transcript. Never clipped — a shortened
  // path would name a different file — and dropped if it is implausibly long.
  // It stays server-side: the frontend gets worker ids, never host paths.
  transcriptFile: z.string().min(1).max(MAX_PATH).optional().catch(undefined),
});

const piStateSchema = z.object({
  version: z.literal(1),
  live: z.boolean(),
  heartbeatAt: z.number(),
  piPiVersion: bounded(40).default(""),
  status: z
    .object({
      text: bounded(200),
      level: z.enum(["normal", "attention", "alarm", "idle"]).catch("normal"),
      since: z.number().default(0),
    })
    .optional(),
  // One worker pi-pi writes in a shape this version does not know is dropped;
  // the others still show.
  workers: z
    .array(piWorkerSchema.nullable().catch(null))
    .transform((list) =>
      list.filter((entry) => entry !== null).slice(0, MAX_WORKERS),
    ),
});

export type PiWorker = z.infer<typeof piWorkerSchema>;
export type PiWorkerStatus = z.infer<typeof piWorkerStatusSchema>;
export type PiState = z.infer<typeof piStateSchema>;

export interface PiSnapshot {
  state: PiState;
  /** The host the thread's storage lives on; a worker's transcript is read there. */
  hostId: string;
  /** The session that wrote the file has shut down, or stopped beating. */
  stale: boolean;
  /** Add to a pi timestamp to put it on this process's clock. */
  clockOffsetMs: number;
}

/** The slice of `BbPluginApi` the reader uses; `BbPluginApi` satisfies it. */
export interface PiReaderApi {
  sdk: {
    threads: {
      storageLocation(args: {
        threadId: string;
        signal?: AbortSignal;
      }): Promise<{ hostId: string; storageRootPath: string }>;
    };
    files: {
      read(args: { hostId?: string; path: string; signal?: AbortSignal }): Promise<{
        content: string;
        contentEncoding?: "base64" | "utf8";
      }>;
    };
  };
  log: { warn(message: string): void };
}

export interface PiReader {
  /** The thread's pi-pi state, or null when there is none to show. */
  read(threadId: string): Promise<PiSnapshot | null>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A thread whose agent is not pi, or a pi that has never run under bb. */
function isMissingFile(error: unknown): boolean {
  return (error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT") ||
    /enoent|not found|no such file|does not exist/i.test(message(error));
}

function remember<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function createPiReader(bb: PiReaderApi): PiReader {
  const locations = new Map<string, { hostId: string; storageRootPath: string }>();
  // The last heartbeat seen for a thread and when this process saw it: pi's
  // clock may be minutes off, so only a heartbeat that stops *changing* ages.
  const beats = new Map<string, { heartbeatAt: number; seenAt: number; offset: number }>();
  // The last state read cleanly, per thread. A failed read serves it marked
  // stale rather than nothing: dropping it would snap every worker back to the
  // launch receipt's "done, 0 steps" for as long as the host is unreachable.
  const lastGood = new Map<string, { state: PiState; hostId: string }>();
  // One warning per thread per reason, until that thread reads cleanly again.
  const warned = new Set<string>();

  const warnOnce = (threadId: string, reason: string, detail: string) => {
    const key = `${threadId}:${reason}`;
    if (warned.has(key)) return;
    if (warned.size > MAX_CACHE) warned.clear();
    warned.add(key);
    bb.log.warn(`pi-pi state ${reason} for ${threadId}: ${detail}`);
  };

  const locate = async (threadId: string) => {
    const cached = locations.get(threadId);
    if (cached) return cached;
    const location = await bb.sdk.threads.storageLocation({
      threadId,
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    remember(locations, threadId, location);
    return location;
  };

  /** What is still known about a thread when this read failed. */
  const fallback = (threadId: string): PiSnapshot | null => {
    const kept = lastGood.get(threadId);
    if (kept === undefined) return null;
    return {
      state: kept.state,
      hostId: kept.hostId,
      stale: true,
      clockOffsetMs: beats.get(threadId)?.offset ?? 0,
    };
  };

  return {
    async read(threadId) {
      let hostId: string;
      let text: string;
      try {
        const location = await locate(threadId);
        hostId = location.hostId;
        const file = await bb.sdk.files.read({
          hostId,
          path: `${location.storageRootPath.replace(/\/+$/, "")}/${STATE_PATH}`,
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        text =
          file.contentEncoding === "base64"
            ? Buffer.from(file.content, "base64").toString("utf8")
            : file.content;
      } catch (error) {
        locations.delete(threadId);
        if (isMissingFile(error)) {
          // pi-pi never ran here, or its state was removed: nothing to show.
          beats.delete(threadId);
          lastGood.delete(threadId);
          return null;
        }
        warnOnce(threadId, "unreadable", message(error));
        return fallback(threadId);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        warnOnce(threadId, "unparsable", message(error));
        return fallback(threadId);
      }
      const result = piStateSchema.safeParse(parsed);
      if (!result.success) {
        // A newer pi-pi bumps `version`; the graph shows bb's own data until
        // this plugin learns the new shape.
        warnOnce(threadId, "unsupported", result.error.issues[0]?.message ?? "invalid");
        return fallback(threadId);
      }
      warned.delete(`${threadId}:unreadable`);
      warned.delete(`${threadId}:unparsable`);
      warned.delete(`${threadId}:unsupported`);
      const state = result.data;
      remember(lastGood, threadId, { state, hostId });
      const now = Date.now();
      let beat = beats.get(threadId);
      if (!beat || beat.heartbeatAt !== state.heartbeatAt) {
        beat = {
          heartbeatAt: state.heartbeatAt,
          seenAt: now,
          offset: now - state.heartbeatAt,
        };
        remember(beats, threadId, beat);
      }
      return {
        state,
        hostId,
        stale: !state.live || now - beat.seenAt > STALE_MS,
        clockOffsetMs: beat.offset,
      };
    },
  };
}

/**
 * The worker a pi-pi launch receipt in a node's output started. Only a tool
 * call or a subagent can be one: a turn or a thread node may quote the same
 * receipt in the agent's own reply.
 */
function workerIdFrom(node: GraphNode): string | null {
  if (node.kind !== "tool" && node.kind !== "subagent") return null;
  const known = node.meta.piWorkerId;
  if (known !== undefined && known.length > 0) return known;
  const receipt = /\bStarted worker (\S+) \(/.exec(node.output ?? "");
  return receipt ? receipt[1]! : null;
}

// pi-pi's own ACTIVE_STATUSES: an idle worker has finished its run and is only
// still retained, so it is done unless it is waiting on an answer.
const ACTIVE: ReadonlySet<PiWorkerStatus> = new Set(["queued", "running"]);

function workerStatus(worker: PiWorker, stale: boolean): NodeStatus {
  if (ACTIVE.has(worker.status)) {
    // The session that drove this worker is gone, so it stopped where it was:
    // calling it done would claim a result that never arrived.
    if (stale) return "interrupted";
    if (worker.question !== undefined) return "waiting";
    return worker.status === "queued" ? "queued" : "running";
  }
  // A question nobody can answer any more is not still being asked.
  if (worker.question !== undefined && !stale) return "waiting";
  if (worker.status === "completed" || worker.status === "idle") return "done";
  if (worker.status === "failed") return "error";
  return "interrupted";
}

function clip(value: string, cap: number): string {
  const flat = value.trim();
  return flat.length > cap ? `${flat.slice(0, cap - 1)}…` : flat;
}

function preview(worker: PiWorker): string | null {
  const text = worker.result
    ? `${worker.result.summary}\n\n${worker.result.body}`
    : (worker.error ?? worker.outputTail);
  const trimmed = clip(text, TEXT_CAP);
  return trimmed.length > 0 ? trimmed : null;
}

function workerMeta(worker: PiWorker, stale: boolean): Record<string, string> {
  return {
    piWorkerId: worker.id,
    type: worker.type,
    status: worker.status,
    ...(worker.model ? { model: worker.model } : {}),
    ...(worker.step ? { "last step": worker.step.label } : {}),
    ...(worker.progress ? { progress: worker.progress } : {}),
    ...(worker.toolUses ? { "tool calls": String(worker.toolUses) } : {}),
    ...(worker.tokens ? { tokens: String(worker.tokens) } : {}),
    ...(worker.question ? { question: clip(worker.question, LABEL_CAP) } : {}),
    ...(worker.result ? { result: worker.result.status } : {}),
    ...(stale ? { state: "stale" } : {}),
  };
}

function sublabelFor(worker: PiWorker, status: NodeStatus): string {
  const parts = [worker.type, `${worker.toolUses} step${worker.toolUses === 1 ? "" : "s"}`];
  if (status === "running" && worker.step) parts.push(worker.step.label);
  return clip(parts.join(" · ").replace(/\s+/g, " "), LABEL_CAP);
}

/** A pi timestamp on this process's clock. */
function local(at: number | undefined, offsetMs: number): number | null {
  return at === undefined ? null : at + offsetMs;
}

/**
 * Folds a thread's pi-pi workers into its graph: enriches the delegation node
 * that launched each worker (adding one only for workers no node matches),
 * and wakes the thread and its ancestors while a worker is still going.
 *
 * Mutates and returns `nodes`; call it after the thread's turns are built.
 */
export function mergePiWorkers(
  nodes: GraphNode[],
  threadId: string,
  snapshot: PiSnapshot,
): GraphNode[] {
  const { stale, clockOffsetMs } = snapshot;
  const byId = new Map(snapshot.state.workers.map((worker) => [worker.id, worker]));
  if (byId.size === 0) return nodes;
  const statuses = new Map<string, NodeStatus>(
    snapshot.state.workers.map((worker) => [worker.id, workerStatus(worker, stale)]),
  );
  const taken = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.threadId !== threadId) continue;
    const workerId = workerIdFrom(node);
    if (workerId === null || !byId.has(workerId)) continue;
    // A worker id is only unique within one pi session, so an old turn may
    // hold a receipt for a different run of the same id: the newest launch is
    // the one this state describes.
    const held = taken.get(workerId);
    if (held === undefined || (node.startedAt ?? 0) >= (held.startedAt ?? 0))
      taken.set(workerId, node);
  }
  for (const [workerId, node] of taken) {
    const worker = byId.get(workerId)!;
    const status = statuses.get(workerId)!;
    // A pi worker launched through the plain Agent tool is still a subagent.
    node.kind = "subagent";
    node.status = status;
    node.sublabel = sublabelFor(worker, status);
    node.input = clip(worker.prompt || worker.description, TEXT_CAP) || node.input;
    // The node's own output is just the launch receipt.
    node.output = preview(worker);
    node.startedAt = local(worker.startedAt ?? worker.createdAt, clockOffsetMs) ?? node.startedAt;
    node.completedAt = local(worker.settledAt, clockOffsetMs);
    Object.assign(node.meta, workerMeta(worker, stale));
  }
  for (const worker of snapshot.state.workers) {
    if (taken.has(worker.id)) continue;
    const status = statuses.get(worker.id)!;
    nodes.push({
      id: `${threadId}:pi:${worker.id}`,
      parentId: threadId,
      kind: "subagent",
      label: clip(worker.description || worker.type, 60),
      sublabel: sublabelFor(worker, status),
      status,
      threadId,
      startedAt: local(worker.startedAt ?? worker.createdAt, clockOffsetMs),
      completedAt: local(worker.settledAt, clockOffsetMs),
      input: clip(worker.prompt || worker.description, TEXT_CAP) || null,
      output: preview(worker),
      meta: workerMeta(worker, stale),
    });
  }
  const live = [...statuses.values()];
  const wake: NodeStatus | null = live.includes("waiting")
    ? "waiting"
    : live.includes("running") || live.includes("queued")
      ? "running"
      : null;
  if (wake !== null) wakeAncestors(nodes, threadId, wake);
  return nodes;
}

/** The thread and the project/root above it are working while a worker is. */
function wakeAncestors(nodes: GraphNode[], threadId: string, status: NodeStatus): void {
  const byNodeId = new Map(nodes.map((node) => [node.id, node]));
  let node = byNodeId.get(threadId);
  while (node !== undefined) {
    // What bb itself reports about the thread wins: a worker is no reason to
    // hide an error, or a question the user still has to answer.
    if (node.status !== "error" && node.status !== "waiting") node.status = status;
    node = node.parentId === null ? undefined : byNodeId.get(node.parentId);
  }
}
