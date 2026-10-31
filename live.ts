import { createHash } from "node:crypto";
import { z } from "zod";
import type { LiveEntry, LiveKind } from "./live-types";

export const liveInputSchema = z.object({
  threadId: z.string().min(1).max(300),
  itemId: z.string().min(1).max(300).nullable(),
  workerId: z.string().min(1).max(300).nullable(),
  processId: z.string().min(1).max(300).nullable().optional(),
  cursor: z.string().max(100_000).nullable(),
});
const liveEntrySchema = z.object({
  id: z.string(),
  at: z.number().nullable(),
  kind: z.enum(["user", "assistant", "thinking", "tool", "command", "stdout", "stderr", "system"]),
  text: z.string(),
  tool: z.string().optional(),
  command: z.string().optional(),
  status: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  append: z.boolean().optional(),
});
export const liveOutputSchema = z.object({
  text: z.string(),
  cursor: z.string().nullable(),
  reset: z.boolean(),
  hasMore: z.boolean(),
  source: z.enum(["events", "transcript", "preview", "process"]),
  warning: z.string().nullable(),
  entries: z.array(liveEntrySchema).optional(),
});
export type LiveInput = z.infer<typeof liveInputSchema>;
export type LivePage = z.infer<typeof liveOutputSchema>;

export interface LiveApi {
  threads: { events: { list(args: { threadId: string; afterSeq?: string; limit: string; order: "asc"; signal?: AbortSignal }): Promise<readonly unknown[]> } };
  files: { read(args: { hostId: string; path: string; signal?: AbortSignal }): Promise<{ content: string; contentEncoding: string; sizeBytes?: number }> };
}
export interface ProcessSource {
  id: string;
  rootId: string;
  parentId?: string;
  toolCallId: string;
  toolName: string;
  command: string;
  pid: number;
  startedAt: number;
  status: string;
  exitCode?: number | null;
  signal?: string | null;
  logFile?: string;
  logTruncated?: boolean;
  outputCapture?: "pipes" | "unavailable" | "shared";
  outputTail?: string;
  warning?: string;
}
export interface WorkerSource {
  hostId: string;
  state: { workers: Array<{ id: string; transcriptFile?: string; outputTail: string; status?: string; processes?: ProcessSource[] }> };
}

// BB's event API rejects larger pages.
const PAGE_SIZE = 100;
const TEXT_LIMIT = 64_000;
const TRANSCRIPT_LIMIT = 21 * 1024 * 1024;
const cursorSchema = z.object({
  target: z.string(),
  source: z.enum(["events", "transcript", "preview", "process"]),
  seq: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  generation: z.string(),
  children: z.array(z.string().length(24)).max(1000),
  streamed: z.array(z.string().length(24)).max(1000),
  printed: z.record(z.string().length(24), z.string().length(24)).default({}),
});
type Cursor = z.infer<typeof cursorSchema>;
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  const item = record(value);
  if (item.type === "image") return "[image]";
  if (item.type === "toolCall") return `[${string(item.name)}] ${JSON.stringify(item.arguments ?? {})}`;
  return string(item.text) || string(item.thinking) || (item.content !== undefined ? contentText(item.content) : "");
}

function timestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function messageEntries(row: Record<string, unknown>, offset: number, bounded: (text: string) => string): LiveEntry[] {
  const message = record(row.message);
  const role = string(message.role);
  const at = timestamp(row.timestamp ?? message.timestamp);
  const id = string(row.id) || `message:${offset}`;
  const parts = Array.isArray(message.content) ? message.content : [message.content];
  const entries: LiveEntry[] = [];
  let remaining = TEXT_LIMIT;
  for (const [index, raw] of parts.entries()) {
    if (remaining <= 0 || index >= 64) {
      entries.push({id:`${id}:trim`,at,kind:"system",text:"Further blocks of this message were not retained in this page.",status:"truncated"});
      break;
    }
    const part = record(raw);
    const call = part.type === "toolCall";
    const args = record(part.arguments);
    const kind: LiveKind = role === "user" ? "user" : role === "toolResult" ? "tool" : part.type === "thinking" ? "thinking" : call ? (args.command ? "command" : "tool") : "assistant";
    const text = bounded(contentText(raw)).slice(0, remaining);
    remaining -= text.length;
    if (!text && !call) continue;
    entries.push({id:`${id}:${index}`,at,kind,text,tool:call ? string(part.name) : string(message.toolName) || undefined,command:call && args.command ? string(args.command).slice(0,4096) : undefined,status:message.isError === true ? "error" : call ? "started" : "done"});
  }
  return entries;
}

function providerEntry(event: Record<string, unknown>, text: string): LiveEntry | null {
  const data = record(event.data);
  const item = record(data.item);
  const type = string(event.type);
  const itemId = string(data.itemId) || string(item.id) || String(event.seq);
  const at = timestamp(event.createdAt);
  const delta = type.endsWith("/delta") || type.endsWith("/outputDelta") || type.endsWith("/textDelta") || type.endsWith("/summaryTextDelta");
  const thinking = type.includes("reasoning") || item.type === "reasoning";
  const command = string(item.command) || string(record(item.arguments).command);
  const kind: LiveKind = item.type === "userMessage" ? "user" : thinking ? "thinking" : type.includes("agentMessage") || item.type === "agentMessage" ? "assistant" : command || item.type === "commandExecution" || type.includes("commandExecution") ? "command" : "tool";
  const completed = type === "item/completed" || type === "item/delegation/completed" || type === "item/backgroundTask/completed";
  if (!text && !completed) return null;
  const body = item.type === "userMessage" ? (text ? contentText(item.content).slice(-TEXT_LIMIT) : "") : type === "item/started" ? (command ? "" : text.trim()) : delta ? (data.reset === true ? `[output reset]\n${string(data.delta)}` : string(data.delta)).slice(-TEXT_LIMIT) : text;
  return {id:`event:${itemId}:${thinking ? "thinking" : "item"}`,at,kind,text:body,tool:string(item.tool) || undefined,command:command.slice(0,4096) || undefined,status:string(item.status) || (completed ? "done" : "running"),exitCode:typeof item.exitCode === "number" ? item.exitCode : undefined,append:(delta && data.reset !== true) || completed || type.endsWith("/progress")};
}

function eventText(event: Record<string, unknown>, streamed: Set<string>, printed: Record<string, string>): string {
  const data = record(event.data);
  const item = record(data.item);
  const id = fingerprint(string(data.itemId) || string(item.id));
  const type = string(event.type);
  const unique = (text: string) => {
    if (!text) return "";
    const digest = fingerprint(text);
    if (printed[id] === digest) return "";
    delete printed[id];
    printed[id] = digest;
    const keys = Object.keys(printed);
    if (keys.length > 64) delete printed[keys[0]!];
    return text;
  };
  if (item.type === "userMessage" && (type === "item/started" || type === "item/completed")) {
    const text = contentText(item.content);
    return unique(text ? `\n[user]\n${text}\n` : "");
  }
  if (type.endsWith("/delta") || type.endsWith("/outputDelta") || type.endsWith("/textDelta") || type.endsWith("/summaryTextDelta")) {
    const delta = string(data.delta);
    if (delta) streamed.add(id);
    return data.reset === true ? `\n[output reset]\n${delta}` : delta;
  }
  if (type === "item/started") {
    const label = string(item.command) || string(item.tool) || string(item.description) || string(item.label);
    if (label) return `\n[${string(item.type) || "item"}] ${label}\n`;
    return item.type === "agentMessage" ? "\n[assistant]\n" : "";
  }
  if (type.endsWith("/progress")) {
    const progress = string(data.message) || string(item.summary);
    return unique(progress ? `\n${progress}\n` : "");
  }
  if (type !== "item/completed" && type !== "item/delegation/completed" && type !== "item/backgroundTask/completed") return "";
  // Providers commonly repeat the entire streamed output in the final item.
  const result = streamed.has(id) ? "" : contentText(item.aggregatedOutput ?? item.result ?? item.text ?? item.output ?? item.summary ?? item.content);
  const error = string(item.error);
  return unique(`${result ? `\n${result}\n` : ""}${error ? `\n[error] ${error}\n` : ""}`);
}

function decodeCursor(raw: string | null, target: string): { cursor: Cursor; reset: boolean } {
  if (raw) {
    try {
      const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
      if (parsed.success && parsed.data.target === target) return { cursor: parsed.data, reset: false };
    } catch { /* An invalid or old cursor starts a new, explicitly reset stream. */ }
  }
  return { cursor: { target, source: "events", seq: 0, offset: 0, generation: "", children: [], streamed: [], printed: {} }, reset: raw !== null };
}

function page(cursor: Cursor, text: string, reset: boolean, hasMore: boolean, warning: string | null, entries: LiveEntry[] = []): LivePage {
  // Only active-item overflow can drop filtering state. The small dedupe LRU
  // is independent, so completed siblings never evict a running descendant.
  if (cursor.children.length > 1000 || cursor.streamed.length > 1000) {
    warning = "Older active-item tracking was trimmed; very old descendants or duplicate snapshots may be omitted or repeated.";
    cursor.children = cursor.children.slice(-1000);
    cursor.streamed = cursor.streamed.slice(-1000);
  }
  const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  // The host RPC boundary rejects present-but-undefined keys, even optional
  // ones. Omit them; explicit null (such as an unknown exit code) survives.
  const jsonEntries = entries.map((entry) => Object.fromEntries(
    Object.entries(entry).filter(([, value]) => value !== undefined),
  ) as unknown as LiveEntry);
  return { text, cursor: encoded, reset, hasMore, source: cursor.source, warning, entries: jsonEntries };
}

export function createLiveReader(api: LiveApi, readPi: (threadId: string) => Promise<WorkerSource | null>) {
  type File = Awaited<ReturnType<LiveApi["files"]["read"]>>;
  const files = new Map<string, { at: number; ttl: number; value: Promise<File> }>();
  const readTranscript = async (hostId: string, path: string, offset: number, active: boolean) => {
    const key = JSON.stringify([hostId, path]);
    const cached = files.get(key);
    if (cached) {
      const file = await cached.value;
      // Drain one immutable read before fetching another: reading the same
      // multi-MB file once for every page multiplies remote I/O by page count.
      if (file.content.indexOf("\n", offset) >= 0 || Date.now() - cached.at < cached.ttl) return file;
    }
    const value = Promise.resolve().then(() => api.files.read({ hostId, path, signal: AbortSignal.timeout(10_000) })).catch(() => {
      throw new Error("Captured log is unavailable on its host; the previous output is retained.");
    }).then((file) => {
      if (file.contentEncoding !== "utf8") throw new Error("Worker transcript is not UTF-8 text");
      if ((file.sizeBytes ?? Buffer.byteLength(file.content)) > TRANSCRIPT_LIMIT) throw new Error("Worker transcript exceeds the supported size limit");
      return file;
    });
    files.delete(key);
    files.set(key, { at: Date.now(), ttl: active ? 1000 : 10_000, value });
    while (files.size > 2) files.delete(files.keys().next().value!);
    try { return await value; }
    catch (error) { files.delete(key); throw error; }
  };
  return async (raw: LiveInput): Promise<LivePage> => {
    const input = liveInputSchema.parse(raw);
    if (input.workerId && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.workerId)) throw new Error("Invalid worker id");
    if (input.processId && (!input.workerId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.processId))) throw new Error("Invalid process target");
    const target = JSON.stringify([input.threadId, input.itemId, input.workerId, input.processId ?? null]);
    const decoded = decodeCursor(input.cursor, target);
    const cursor = decoded.cursor;
    let reset = decoded.reset;
    let warning: string | null = null;
    const bounded = (text: string) => {
      if (text.length <= TEXT_LIMIT) return text;
      warning = "A large log entry was truncated; only its tail is shown.";
      return `[entry truncated]\n${text.slice(-TEXT_LIMIT)}`;
    };
    if (input.workerId) {
      const snapshot = await readPi(input.threadId);
      const worker = snapshot?.state.workers.find((entry) => entry.id === input.workerId);
      if (!snapshot || !worker) throw new Error("Worker state is unavailable; the previous log is retained.");
      if (input.processId) {
        const process = worker.processes?.find((entry) => entry.id === input.processId);
        if (!process) throw new Error("Process is not retained in this worker's state.");
        const root = worker.processes?.find((entry) => entry.id === process.rootId);
        const path = root?.logFile ?? process.logFile;
        cursor.source = "process";
        const shared = process.outputCapture === "shared" || process.rootId !== process.id;
        const notice = (text: string | undefined) => {
          if (text && !warning?.includes(text)) warning = warning ? `${warning} ${text}` : text;
        };
        if (shared) notice("Shared root-command output: separate per-child stdout/stderr is not available.");
        notice(process.warning);
        if (root?.warning !== process.warning) notice(root?.warning);
        if (!path || process.outputCapture === "unavailable") {
          const text = bounded(process.outputTail ?? "");
          return page(cursor, text, true, false, warning ?? "No captured output; streams may be redirected, inherited or unavailable.", [{id:process.id,at:process.startedAt,kind:"command",text,command:process.command,status:process.status,exitCode:process.exitCode}]);
        }
        if (!/^(?:\/|[A-Za-z]:[\\/])/.test(path) || !/[\\/]pi-pi[\\/]processes[\\/][A-Za-z0-9._-]+\.jsonl$/.test(path)) throw new Error("Invalid process log path in pi-pi state");
        const generation = fingerprint(path);
        if (cursor.generation !== generation) { cursor.offset = 0; reset ||= input.cursor !== null; }
        cursor.generation = generation;
        const file = await readTranscript(snapshot.hostId, path, cursor.offset, root?.status === "running" || process.status === "running");
        if ((file.sizeBytes ?? Buffer.byteLength(file.content)) > 2 * 1024 * 1024) throw new Error("Process log exceeds the supported size limit");
        if (cursor.offset > file.content.length) { cursor.offset = 0; reset = true; }
        const lines: string[] = [];
        const entries: LiveEntry[] = [];
        let size = 0;
        while (size < 200_000 && entries.length < 500) {
          const end = file.content.indexOf("\n", cursor.offset);
          if (end < 0) break;
          const rawLine = file.content.slice(cursor.offset, end);
          cursor.offset = end + 1;
          try {
            const row = record(JSON.parse(rawLine));
            if (!["start", "stdout", "stderr", "exit", "system"].includes(string(row.kind))) continue;
            const at = timestamp(row.at);
            const text = bounded(string(row.text));
            const kind: LiveKind = row.kind === "start" || row.kind === "exit" ? "command" : row.kind as LiveKind;
            const id = row.kind === "start" || row.kind === "exit" ? `${process.rootId}:command` : `${process.rootId}:${row.seq ?? cursor.offset}`;
            const exitCode = typeof row.exitCode === "number" || row.exitCode === null ? row.exitCode : undefined;
            const command = root?.command ?? process.command;
            const body = row.kind === "start" && text === command ? "" : text;
            const status = string(row.status) || (row.kind === "start" ? "running" : row.kind === "exit" ? ((typeof exitCode === "number" && exitCode !== 0) || row.signal ? "failed" : "exited") : undefined);
            entries.push({id,at,kind,text:body,tool:process.toolName,command:kind === "command" ? command : undefined,status,exitCode,append:row.kind === "exit"});
            const flat = row.kind === "exit" ? `\n[exit ${exitCode ?? (string(row.signal) || "unknown")}]\n` : row.kind === "start" ? `${text || command}\n` : text;
            lines.push(flat); size += flat.length;
          } catch { notice("A malformed process log entry was skipped."); }
        }
        if (process.logTruncated || root?.logTruncated) notice("Captured process output reached its recording limit; later output was not retained.");
        return page(cursor, lines.join(""), reset, file.content.indexOf("\n", cursor.offset) >= 0, warning, entries);
      }
      if (!worker.transcriptFile) {
        cursor.source = "preview";
        return page(cursor, bounded(worker.outputTail), true, false, "pi-pi has not exposed a transcript for this worker. Showing only the latest output, not full history.", [{id:"preview",at:null,kind:"assistant",text:bounded(worker.outputTail)}]);
      }
      const path = worker.transcriptFile;
      if (!/^(?:\/|[A-Za-z]:[\\/])/.test(path) || !path.endsWith(".jsonl")) throw new Error("Invalid worker transcript path in pi-pi state");
      const generation = createHash("sha256").update(path).digest("hex");
      if (cursor.source !== "transcript" || cursor.generation !== generation) {
        reset ||= input.cursor !== null;
        cursor.offset = 0;
      }
      cursor.source = "transcript";
      cursor.generation = generation;
      // The SDK offers a whole-file read, not range reads. Only the selected
      // worker is read, and pi-pi bounds each transcript on the producer side.
      const file = await readTranscript(snapshot.hostId, path, cursor.offset, worker.status === undefined || worker.status === "running" || worker.status === "queued");
      if (cursor.offset > file.content.length) { cursor.offset = 0; reset = true; }
      const lines: string[] = [];
      const entries: LiveEntry[] = [];
      let outputSize = 0;
      while (outputSize < 200_000 && entries.length < 500) {
        const end = file.content.indexOf("\n", cursor.offset);
        if (end < 0) break;
        const line = file.content.slice(cursor.offset, end);
        cursor.offset = end + 1;
        if (!line.trim()) continue;
        try {
          const row = record(JSON.parse(line));
          if (row.customType === "pi-pi-truncated") {
            warning = "pi-pi stopped recording this transcript at its size limit.";
            lines.push(`\n[${warning}]\n`);
            entries.push({id:`cap:${cursor.offset}`,at:null,kind:"system",text:warning,status:"truncated"});
            outputSize += warning.length;
          }
          if (row.type !== "message") continue;
          const message = record(row.message);
          const body = bounded(contentText(message.content));
          entries.push(...messageEntries(row, cursor.offset, bounded));
          if (body) {
            const text = `\n[${string(message.role)}${message.toolName ? `: ${string(message.toolName)}` : ""}]\n${body}\n`;
            lines.push(text);
            outputSize += text.length;
          }
        } catch { warning = "A malformed transcript entry was skipped."; }
      }
      return page(cursor, lines.join(""), reset, file.content.indexOf("\n", cursor.offset) >= 0, warning, entries);
    }
    cursor.source = "events";
    const events = await api.threads.events.list({ threadId: input.threadId, afterSeq: String(cursor.seq), limit: String(PAGE_SIZE), order: "asc", signal: AbortSignal.timeout(10_000) });
    const children = new Set(cursor.children);
    const streamed = new Set(cursor.streamed);
    const targetId = input.itemId ? fingerprint(input.itemId) : null;
    if (targetId) children.add(targetId);
    const text: string[] = [];
    const entries: LiveEntry[] = [];
    let processed = 0;
    let outputSize = 0;
    for (const rawEvent of events) {
      processed++;
      const event = record(rawEvent);
      if (typeof event.seq !== "number" || event.seq <= cursor.seq) continue;
      cursor.seq = event.seq;
      const data = record(event.data);
      const item = record(data.item);
      const id = fingerprint(string(data.itemId) || string(item.id));
      const parent = string(data.parentToolCallId) || string(item.parentToolCallId) || string(data.parentRef);
      if (parent && children.has(fingerprint(parent))) children.add(id);
      if (input.itemId && !children.has(id)) continue;
      const output = bounded(eventText(event, streamed, cursor.printed));
      text.push(output);
      const entry = providerEntry(event, output);
      if (entry) entries.push(entry);
      outputSize += output.length;
      if (event.type === "item/completed" || event.type === "item/delegation/completed" || event.type === "item/backgroundTask/completed") {
        streamed.delete(id);
        if (item.type !== "delegation" && item.type !== "backgroundTask") {
          delete cursor.printed[id];
          if (id !== targetId) children.delete(id);
        }
      }
      if (outputSize >= 200_000) break;
    }
    cursor.children = [...children];
    cursor.streamed = [...streamed];
    return page(cursor, text.join(""), reset, processed < events.length || events.length >= PAGE_SIZE, warning, entries);
  };
}
