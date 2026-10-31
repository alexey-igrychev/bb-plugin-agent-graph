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
/** A worker shows the processes it is running, not every one it ever ran. */
const MAX_PROCESSES = 128;
const COMMAND_CAP = 60;

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

const piProcessStatusSchema = z.enum(["running", "exited", "failed", "unknown"]);

/** A sampled number: a negative or non-finite one is no measurement, so it is dropped. */
const metric = z.number().min(0).optional().catch(undefined);

// A child process a worker started. Its id is pi-pi's own, independent of the
// pid the OS may hand to another process once this one exits. A field this
// version cannot trust is dropped where the node can do without it; the rest
// (id, rootId, pid, status, startedAt) drop the whole entry rather than invent
// a process the producer never described.
const piProcessSchema = z.object({
  id: z.string().min(1).max(120),
  rootId: z.string().min(1).max(120),
  parentId: z.string().min(1).max(120).optional().catch(undefined),
  toolCallId: bounded(120).default(""),
  toolName: bounded(80).default(""),
  command: bounded(TEXT_CAP).default(""),
  pid: z.number().int().positive(),
  ppid: z.number().int().positive().optional().catch(undefined),
  startedAt: z.number(),
  endedAt: z.number().optional().catch(undefined),
  status: piProcessStatusSchema,
  exitCode: z.number().int().nullable().optional().catch(undefined),
  signal: bounded(40).nullable().optional().catch(undefined),
  cpuPercent: metric,
  rssBytes: metric,
  sampledAt: z.number().optional().catch(undefined),
  outputTail: bounded(TEXT_CAP).default(""),
  // Server-side only, like a worker's transcript: the frontend gets process
  // ids, never host paths.
  logFile: z.string().min(1).max(MAX_PATH).optional().catch(undefined),
  logTruncated: z.boolean().optional().catch(undefined),
  outputCapture: z.enum(["pipes", "unavailable", "shared"]).optional().catch(undefined),
  warning: bounded(200).optional().catch(undefined),
});

const piWorkerFileSchema = z.object({
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
  // Absent from files an older pi-pi wrote, and from a worker that started no
  // process; a shape this version does not know costs the processes, not the
  // worker. Entries are kept as nulls here so the worker's own transform can
  // count what it lost.
  processes: z
    .array(piProcessSchema.nullable().catch(null))
    .optional()
    .catch(undefined),
  processWarning: bounded(200).optional().catch(undefined),
});

// A process nobody is sampling any more still has to be visible: an id this
// version cannot read is a process pi-pi is running that the graph would
// otherwise show as nothing at all.
const ACTIVE_PROCESS: ReadonlySet<z.infer<typeof piProcessStatusSchema>> = new Set([
  "running",
  "unknown",
]);

/**
 * The processes a worker shows: everything still going, then the most recently
 * started of what has finished. The cap is a drawing limit, so it must never
 * be what hides a live process — a worker that keeps its whole history would
 * otherwise bury the one process that is still running.
 */
const piWorkerSchema = piWorkerFileSchema.transform((worker) => {
  const raw = worker.processes;
  if (raw === undefined) return { ...worker, processes: undefined };
  const valid = raw.filter((entry) => entry !== null);
  const finished = valid
    .filter((entry) => !ACTIVE_PROCESS.has(entry.status))
    .sort((a, b) => b.startedAt - a.startedAt);
  const processes = [...valid.filter((entry) => ACTIVE_PROCESS.has(entry.status)), ...finished].slice(
    0,
    MAX_PROCESSES,
  );
  const dropped = raw.length - valid.length;
  // The cap is deliberate and says nothing; an entry this version could not
  // read is a producer/consumer mismatch the user should hear about.
  const processWarning =
    dropped === 0
      ? worker.processWarning
      : `${worker.processWarning ? `${worker.processWarning} ` : ""}${dropped} process ${dropped === 1 ? "entry" : "entries"} could not be read and are not shown.`.slice(
          0,
          200,
        );
  return { ...worker, processes, processWarning };
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
export type PiProcess = z.infer<typeof piProcessSchema>;
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
  // A process node names the worker it belongs to; it did not launch it.
  if (node.meta.piProcessId !== undefined) return null;
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
  const active = (worker.processes ?? []).filter(
    (entry) => entry.status === "running",
  ).length;
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
    ...(active ? { "active processes": String(active) } : {}),
    ...(worker.processWarning
      ? { "process warning": clip(worker.processWarning, LABEL_CAP) }
      : {}),
    ...(stale ? { state: "stale" } : {}),
  };
}

function processStatus(process: PiProcess, stale: boolean): NodeStatus {
  switch (process.status) {
    case "running":
      // Nobody is sampling this process any more, so what it is doing now is
      // not known: calling it running would claim a liveness nothing checked.
      return stale ? "interrupted" : "running";
    case "exited":
      return "done";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

function megabytes(bytes: number): string {
  const mb = bytes / 1_048_576;
  return `${mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10} MB`;
}

/**
 * How a sampled descendant left. pi-pi only learns an exit code for a process
 * it waited on, so a settled one without a code exited in a way nobody saw —
 * which is not the same as exiting 0.
 */
function exitOf(process: PiProcess): string | null {
  if (process.status !== "exited" && process.status !== "failed") return null;
  return process.exitCode === undefined || process.exitCode === null
    ? "unknown"
    : String(process.exitCode);
}

function processMeta(
  worker: PiWorker,
  process: PiProcess,
  stale: boolean,
  offsetMs: number,
): Record<string, string> {
  const exit = exitOf(process);
  return {
    piWorkerId: worker.id,
    piProcessId: process.id,
    kind: "process",
    pid: String(process.pid),
    ...(process.ppid !== undefined ? { ppid: String(process.ppid) } : {}),
    rootId: process.rootId,
    ...(process.toolCallId ? { toolCallId: process.toolCallId } : {}),
    ...(process.toolName ? { tool: process.toolName } : {}),
    ...(process.command ? { command: clip(process.command, LABEL_CAP) } : {}),
    status: process.status,
    ...(exit !== null ? { exit } : {}),
    ...(process.signal ? { signal: process.signal } : {}),
    ...(process.cpuPercent !== undefined
      ? { cpu: `${Math.round(process.cpuPercent * 10) / 10}%` }
      : {}),
    ...(process.rssBytes !== undefined ? { rss: megabytes(process.rssBytes) } : {}),
    ...(process.sampledAt !== undefined
      ? { sampledAt: String(local(process.sampledAt, offsetMs)) }
      : {}),
    ...(process.outputCapture ? { outputCapture: process.outputCapture } : {}),
    ...(process.warning ? { warning: clip(process.warning, LABEL_CAP) } : {}),
    ...(stale ? { state: "stale" } : {}),
  };
}

function processSublabel(process: PiProcess): string {
  const parts = [`PID ${process.pid}`, process.status];
  const exit = exitOf(process);
  if (exit !== null) parts.push(`exit ${exit}`);
  if (process.signal) parts.push(process.signal);
  if (process.cpuPercent !== undefined)
    parts.push(`${Math.round(process.cpuPercent)}% CPU`);
  if (process.rssBytes !== undefined) parts.push(megabytes(process.rssBytes));
  return clip(parts.join(" · "), LABEL_CAP);
}

const CAPTURE_NOTE: Record<NonNullable<PiProcess["outputCapture"]>, string> = {
  pipes: "",
  unavailable: "output was not captured",
  shared: "output went to the agent's own stream",
};

function processOutput(process: PiProcess): string | null {
  const notes: string[] = [];
  const exit = exitOf(process);
  if (exit !== null) notes.push(`exit ${exit}${process.signal ? ` (${process.signal})` : ""}`);
  if (process.logTruncated) notes.push("output truncated");
  const capture = process.outputCapture ? CAPTURE_NOTE[process.outputCapture] : "";
  if (capture) notes.push(capture);
  if (process.warning) notes.push(process.warning);
  const suffix = notes.length > 0 ? `\n${notes.join("; ")}` : "";
  const tail = clip(process.outputTail, TEXT_CAP - suffix.length);
  const text = `${tail}${suffix}`.trim();
  return text.length > 0 ? text : null;
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
  addProcesses(nodes, threadId, snapshot, taken);
  const live = [...statuses.values()];
  // A worker that handed back its result may still own a process that is
  // running: the thread is working either way.
  const working =
    !stale &&
    snapshot.state.workers.some((worker) =>
      (worker.processes ?? []).some((entry) => entry.status === "running"),
    );
  const wake: NodeStatus | null = live.includes("waiting")
    ? "waiting"
    : live.includes("running") || live.includes("queued") || working
      ? "running"
      : null;
  if (wake !== null) wakeAncestors(nodes, threadId, wake);
  return nodes;
}

/**
 * Hangs each worker's processes under it: a root process under the worker's
 * own node, a descendant under the process that started it. A parent this
 * snapshot does not carry, or one that leads back into a cycle, falls back to
 * the worker — the graph is drawn as a tree, so there must be no other shape.
 */
function addProcesses(
  nodes: GraphNode[],
  threadId: string,
  snapshot: PiSnapshot,
  taken: Map<string, GraphNode>,
): void {
  const { stale, clockOffsetMs } = snapshot;
  const present = new Set(nodes.map((node) => node.id));
  for (const worker of snapshot.state.workers) {
    const processes = worker.processes ?? [];
    if (processes.length === 0) continue;
    const ownerId = taken.get(worker.id)?.id ?? `${threadId}:pi:${worker.id}`;
    const nodeIdFor = (processId: string) =>
      `${threadId}:pi:${worker.id}:process:${processId}`;
    const byProcessId = new Map(processes.map((entry) => [entry.id, entry]));
    const parentOf = new Map<string, PiProcess | null>(
      processes.map((entry) => [entry.id, parentProcess(entry, byProcessId)]),
    );
    const depths = new Map<string, number>();
    const depthOf = (entry: PiProcess): number => {
      const known = depths.get(entry.id);
      if (known !== undefined) return known;
      const parent = parentOf.get(entry.id) ?? null;
      // `parentOf` is already cycle-free, so this recursion terminates.
      const depth = parent === null ? 0 : depthOf(parent) + 1;
      depths.set(entry.id, depth);
      return depth;
    };
    const ordered = [...processes].sort((a, b) => depthOf(a) - depthOf(b));
    for (const entry of ordered) {
      const id = nodeIdFor(entry.id);
      if (present.has(id)) continue;
      present.add(id);
      const parent = parentOf.get(entry.id) ?? null;
      nodes.push({
        id,
        parentId: parent === null ? ownerId : nodeIdFor(parent.id),
        kind: "tool",
        label: clip(entry.command || entry.toolName, COMMAND_CAP) || `PID ${entry.pid}`,
        sublabel: processSublabel(entry),
        status: processStatus(entry, stale),
        threadId,
        startedAt: local(entry.startedAt, clockOffsetMs),
        completedAt: local(entry.endedAt, clockOffsetMs),
        input: clip(entry.command, TEXT_CAP) || null,
        output: processOutput(entry),
        meta: processMeta(worker, entry, stale, clockOffsetMs),
      });
    }
  }
}

/** The process that started this one, or null when nothing in the snapshot did. */
function parentProcess(
  process: PiProcess,
  byProcessId: Map<string, PiProcess>,
): PiProcess | null {
  const parent = process.parentId === undefined ? undefined : byProcessId.get(process.parentId);
  if (parent === undefined) return null;
  const seen = new Set([process.id]);
  for (let up: PiProcess | undefined = parent; up !== undefined; ) {
    if (seen.has(up.id)) return null;
    seen.add(up.id);
    up = up.parentId === undefined ? undefined : byProcessId.get(up.parentId);
  }
  return parent;
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
