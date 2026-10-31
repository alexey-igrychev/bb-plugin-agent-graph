import { createHash } from "node:crypto";
import { z } from "zod";

export const liveInputSchema = z.object({
  threadId: z.string().min(1).max(300),
  itemId: z.string().min(1).max(300).nullable(),
  workerId: z.string().min(1).max(300).nullable(),
  cursor: z.string().max(100_000).nullable(),
});
export const liveOutputSchema = z.object({
  text: z.string(),
  cursor: z.string().nullable(),
  reset: z.boolean(),
  hasMore: z.boolean(),
  source: z.enum(["events", "transcript", "preview"]),
  warning: z.string().nullable(),
});
export type LiveInput = z.infer<typeof liveInputSchema>;
export type LivePage = z.infer<typeof liveOutputSchema>;

export interface LiveApi {
  threads: { events: { list(args: { threadId: string; afterSeq?: string; limit: string; order: "asc"; signal?: AbortSignal }): Promise<readonly unknown[]> } };
  files: { read(args: { hostId: string; path: string; signal?: AbortSignal }): Promise<{ content: string; contentEncoding: string; sizeBytes?: number }> };
}
export interface WorkerSource {
  hostId: string;
  state: { workers: Array<{ id: string; transcriptFile?: string; outputTail: string; status?: string }> };
}

const PAGE_SIZE = 200;
const TEXT_LIMIT = 64_000;
const TRANSCRIPT_LIMIT = 21 * 1024 * 1024;
const cursorSchema = z.object({
  target: z.string(),
  source: z.enum(["events", "transcript", "preview"]),
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

function page(cursor: Cursor, text: string, reset: boolean, hasMore: boolean, warning: string | null): LivePage {
  // Only active-item overflow can drop filtering state. The small dedupe LRU
  // is independent, so completed siblings never evict a running descendant.
  if (cursor.children.length > 1000 || cursor.streamed.length > 1000) {
    warning = "Older active-item tracking was trimmed; very old descendants or duplicate snapshots may be omitted or repeated.";
    cursor.children = cursor.children.slice(-1000);
    cursor.streamed = cursor.streamed.slice(-1000);
  }
  const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return { text, cursor: encoded, reset, hasMore, source: cursor.source, warning };
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
    const value = api.files.read({ hostId, path, signal: AbortSignal.timeout(10_000) }).then((file) => {
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
    const target = JSON.stringify([input.threadId, input.itemId, input.workerId]);
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
      if (!worker.transcriptFile) {
        cursor.source = "preview";
        return page(cursor, bounded(worker.outputTail), true, false, "pi-pi has not exposed a transcript for this worker. Showing only the latest output, not full history.");
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
      let outputSize = 0;
      while (outputSize < 200_000) {
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
            outputSize += warning.length;
          }
          if (row.type !== "message") continue;
          const message = record(row.message);
          const body = bounded(contentText(message.content));
          if (body) {
            const text = `\n[${string(message.role)}${message.toolName ? `: ${string(message.toolName)}` : ""}]\n${body}\n`;
            lines.push(text);
            outputSize += text.length;
          }
        } catch { warning = "A malformed transcript entry was skipped."; }
      }
      return page(cursor, lines.join(""), reset, file.content.indexOf("\n", cursor.offset) >= 0, warning);
    }
    cursor.source = "events";
    const events = await api.threads.events.list({ threadId: input.threadId, afterSeq: String(cursor.seq), limit: String(PAGE_SIZE), order: "asc", signal: AbortSignal.timeout(10_000) });
    const children = new Set(cursor.children);
    const streamed = new Set(cursor.streamed);
    const targetId = input.itemId ? fingerprint(input.itemId) : null;
    if (targetId) children.add(targetId);
    const text: string[] = [];
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
    return page(cursor, text.join(""), reset, processed < events.length || events.length >= PAGE_SIZE, warning);
  };
}
