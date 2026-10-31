// Pure view helpers for the live output panel: which retained entries a
// filter and a search show, how one entry reads, and when following the tail
// should let go. No React, so the rules are easy to test.
import type { GraphNode } from "./server";
import type { LiveEntry, LiveKind } from "./live-types.ts";

/** Entry groups the panel can narrow to. */
export type LiveFilter = "all" | "messages" | "tools" | "commands" | "output" | "errors";

export const LIVE_FILTER_LABEL: Record<LiveFilter, string> = {
  all: "All",
  messages: "Messages",
  tools: "Tools",
  commands: "Commands",
  output: "Output",
  errors: "Errors",
};

const FILTER_KINDS: Record<Exclude<LiveFilter, "all" | "errors">, ReadonlySet<LiveKind>> = {
  messages: new Set<LiveKind>(["user", "assistant", "thinking"]),
  tools: new Set<LiveKind>(["tool"]),
  commands: new Set<LiveKind>(["command"]),
  output: new Set<LiveKind>(["stdout", "stderr"]),
};

/** Terminal states that mean the work did not succeed, across providers. */
const FAILED_STATUS = new Set(["error", "failed", "interrupted", "killed", "timeout"]);

/** Anything a reader looking for failures wants: error channels and bad ends. */
function isFailure(entry: LiveEntry): boolean {
  return (
    entry.kind === "stderr" ||
    entry.kind === "system" ||
    FAILED_STATUS.has((entry.status ?? "").toLowerCase()) ||
    (entry.exitCode !== undefined && entry.exitCode !== null && entry.exitCode !== 0)
  );
}

function matches(entry: LiveEntry, needle: string): boolean {
  return (
    entry.text.toLowerCase().includes(needle) ||
    (entry.tool ?? "").toLowerCase().includes(needle) ||
    (entry.command ?? "").toLowerCase().includes(needle)
  );
}

export function filterEntries(
  entries: readonly LiveEntry[],
  filter: LiveFilter,
  query: string,
): LiveEntry[] {
  const needle = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter === "errors" ? !isFailure(entry) : filter !== "all" && !FILTER_KINDS[filter].has(entry.kind))
      return false;
    return needle === "" || matches(entry, needle);
  });
}

/** Short labels shown beside an entry: what it is, and how it ended. */
export function entryBadges(entry: LiveEntry): string[] {
  const badges: string[] = [entry.kind];
  if (entry.tool) badges.push(entry.tool);
  if (entry.status) badges.push(entry.status);
  if (entry.exitCode !== undefined && entry.exitCode !== null) {
    badges.push(`exit ${entry.exitCode}`);
  }
  return badges;
}

/**
 * The entry's body. A command's own output streams into the same entry as the
 * command line, so both are shown; dropping either loses the reader's point.
 */
export function entryBody(entry: LiveEntry): string {
  const command = entry.kind === "command" ? (entry.command ?? "") : "";
  if (command === "") return entry.text;
  return entry.text === "" ? command : `${command}\n${entry.text}`;
}

export function formatEntryTime(at: number | null): string {
  if (at === null) return "--:--:--";
  const time = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(time.getHours())}:${pad(time.getMinutes())}:${pad(time.getSeconds())}`;
}

/** Exactly what the panel shows, as plain text for the clipboard. */
export function copyTextFor(entries: readonly LiveEntry[]): string {
  return entries
    .map(
      (entry) =>
        `${formatEntryTime(entry.at)} [${entryBadges(entry).join(" ")}] ${entryBody(entry)}`,
    )
    .join("\n");
}

/**
 * What the reader must still see once the log has scrolled away: which node
 * this output belongs to, and the one detail that tells two of them apart.
 */
export function liveCaptionFor(node: GraphNode): string {
  const pid = node.meta.pid ?? "";
  const detail = pid !== "" ? `pid ${pid}` : (node.sublabel ?? "");
  return [node.label, detail].filter((part) => part !== "").join(" · ");
}

/** Slack for "at the bottom", so a rounded scroll position still counts. */
const BOTTOM_SLACK_PX = 24;

export function isAtBottom(metrics: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return (
    metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= BOTTOM_SLACK_PX
  );
}
