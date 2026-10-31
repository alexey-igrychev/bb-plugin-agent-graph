// The live output panel: read-only output streamed from the selected node's
// thread, worker, process or tool call, polled while it is visible and not
// paused. Entries are rendered as text only — never as markup.
import { useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import {
  applyLiveError,
  applyLivePage,
  createLiveController,
  emptyLiveState,
  LIVE_POLL_MS,
  LIVE_SLOW_POLL_MS,
  type LiveSource,
  type LiveState,
} from "./live-stream";
import {
  copyTextFor,
  entryBadges,
  entryBody,
  filterEntries,
  formatEntryTime,
  isAtBottom,
  LIVE_FILTER_LABEL,
  type LiveFilter,
} from "./live-view";
import type { LiveEntry } from "./live-types";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

const SOURCE_LABEL: Record<LiveSource, string> = {
  process: "Process",
  events: "Events",
  transcript: "Transcript",
  preview: "Preview",
};

const FILTERS: LiveFilter[] = ["all", "messages", "tools", "commands", "output", "errors"];

/** Entries whose channel the reader should be able to tell apart at a glance. */
const BADGE_TONE: Partial<Record<LiveEntry["kind"], string>> = {
  stderr: "text-destructive border-destructive/40",
  command: "text-[var(--ag-t-shell)] border-[var(--ag-t-shell)]/40",
  system: "text-muted-foreground",
};

function EntryRow({ entry, wrap }: { entry: LiveEntry; wrap: boolean }) {
  const body = entryBody(entry);
  return (
    <li className="border-b border-border/50 px-2 py-1 last:border-b-0">
      <div className="flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
        <time className="font-mono tabular-nums">{formatEntryTime(entry.at)}</time>
        {entryBadges(entry).map((badge, index) => (
          <span
            key={`${badge}-${index}`}
            className={cn(
              "rounded border border-border px-1 leading-4",
              index === 0 ? BADGE_TONE[entry.kind] : null,
            )}
          >
            {badge}
          </span>
        ))}
      </div>
      {body ? (
        <pre
          className={cn(
            "mt-0.5 overflow-x-auto font-mono text-[11px] leading-4",
            wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
            entry.kind === "stderr" && "text-destructive",
            entry.kind === "thinking" && "text-muted-foreground italic",
          )}
        >
          {body}
        </pre>
      ) : null}
    </li>
  );
}

export function LivePanel({
  threadId,
  itemId,
  workerId,
  processId,
  caption,
  active,
}: {
  threadId: string;
  /** Tool call or native subagent to follow; null follows the whole thread. */
  itemId: string | null;
  /** pi-pi worker to follow, when the node is one. */
  workerId: string | null;
  /** pi-pi process to follow; the backend prefers it over the worker's log. */
  processId: string | null;
  /** Which node this output belongs to, kept beside it while it scrolls. */
  caption: string;
  /** The node is still working; finished work is read on the slow cadence. */
  active: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<LiveState>(emptyLiveState);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(true);
  const [filter, setFilter] = useState<LiveFilter>("all");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const cursorRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  // Following scrolls the body itself; that scroll must not look manual.
  const autoScrollRef = useRef(false);

  // A new target starts from scratch. Declared before the poll effect so the
  // cursor is cleared before the next read uses it.
  useEffect(() => {
    cursorRef.current = null;
    setState(emptyLiveState);
  }, [threadId, itemId, workerId, processId]);

  useEffect(() => {
    if (paused) return;
    // The controller owns this target's reads; stopping it drops the ones in
    // flight, so a target change cannot deliver a stale page. A cadence change
    // rebuilds it without touching the cursor, so reading continues where it
    // left off.
    const controller = createLiveController({
      pollMs: active ? LIVE_POLL_MS : LIVE_SLOW_POLL_MS,
      read: () =>
        rpc.call("live", {
          threadId,
          itemId,
          workerId,
          processId,
          cursor: cursorRef.current,
        }),
      onPage: (page) => {
        cursorRef.current = page.cursor;
        setState((current) => applyLivePage(current, page));
      },
      onError: (cause) => setState((current) => applyLiveError(current, cause)),
      isHidden: () => document.hidden,
      schedule: (run, delay) => setTimeout(run, delay),
      cancel: (timer) => clearTimeout(timer),
    });
    const onVisible = () => {
      if (!document.hidden) controller.wake();
    };

    controller.start();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      controller.stop();
    };
  }, [rpc, threadId, itemId, workerId, processId, paused, active]);

  useEffect(() => {
    if (!follow) return;
    const el = bodyRef.current;
    if (!el) return;
    autoScrollRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [follow, state.text, state.entries, expanded]);

  useEffect(() => {
    if (copyNote === null) return;
    const timer = setTimeout(() => setCopyNote(null), 3000);
    return () => clearTimeout(timer);
  }, [copyNote]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !expanded) return;
    dialog.showModal();
    return () => dialog.close();
  }, [expanded]);

  const structured = state.entries.length > 0;
  const visible = structured ? filterEntries(state.entries, filter, query) : [];
  const status = paused
    ? "Paused"
    : state.hasMore
      ? "Catching up"
      : active
        ? "Live"
        : "Idle";

  const copy = () => {
    const text = structured ? copyTextFor(visible) : state.text;
    navigator.clipboard?.writeText(text).then(
      () => setCopyNote("Copied."),
      (cause: unknown) =>
        setCopyNote(
          `Couldn’t copy: ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    ) ?? setCopyNote("Couldn’t copy: the clipboard is not available here.");
  };

  const content = (
    <>
      <div className="flex items-center gap-1.5">
        <h3 className="min-w-0 flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Live output
        </h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-pressed={wrap}
          aria-label={wrap ? "Stop wrapping long lines" : "Wrap long lines"}
          onClick={() => setWrap((value) => !value)}
        >
          <Icon name="TextWrap" className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label={structured ? "Copy the output shown" : "Copy the output"}
          onClick={copy}
        >
          <Icon name="Copy" className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-pressed={follow}
          aria-label={follow ? "Stop following new output" : "Follow new output"}
          onClick={() => setFollow((value) => !value)}
        >
          <Icon name="ArrowDown" className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-pressed={paused}
          aria-label={paused ? "Resume live output" : "Pause live output"}
          onClick={() => setPaused((value) => !value)}
        >
          <Icon name={paused ? "Play" : "Pause"} className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-pressed={expanded}
          aria-label={expanded ? "Close the larger view" : "Open a larger view"}
          onClick={() => setExpanded((value) => !value)}
        >
          <Icon name={expanded ? "Minimize2" : "Maximize2"} className="size-3.5" />
        </Button>
      </div>
      <p className="truncate text-[11px] font-medium text-foreground" title={caption}>
        {caption}
      </p>
      {structured ? (
        <div className="flex items-center gap-1.5">
          <label className="relative flex min-w-0 flex-1 items-center">
            <Icon
              name="Search"
              className="pointer-events-none absolute left-1.5 size-3 text-muted-foreground"
            />
            <span className="sr-only">Search the output shown</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              data-testid="live-search"
              className="h-6 w-full rounded-md border border-border bg-background pl-6 pr-1.5 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>
          <label className="shrink-0">
            <span className="sr-only">Filter the output shown</span>
            <select
              value={filter}
              onChange={(event) => setFilter(event.target.value as LiveFilter)}
              data-testid="live-filter"
              className="h-6 rounded-md border border-border bg-background px-1 text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {FILTERS.map((value) => (
                <option key={value} value={value}>
                  {LIVE_FILTER_LABEL[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <div
        ref={bodyRef}
        aria-live="off"
        data-testid="live-body"
        onScroll={(event) => {
          if (autoScrollRef.current) {
            autoScrollRef.current = false;
            return;
          }
          if (follow && !isAtBottom(event.currentTarget)) setFollow(false);
        }}
        className={cn(
          "overflow-auto rounded-md border border-border bg-muted/40",
          expanded ? "min-h-0 flex-1" : "max-h-[min(28rem,45vh)]",
        )}
      >
        {structured ? (
          visible.length > 0 ? (
            <ul className="list-none divide-border">
              {visible.map((entry) => (
                <EntryRow key={entry.id} entry={entry} wrap={wrap} />
              ))}
            </ul>
          ) : (
            <p className="p-2 text-[11px] text-muted-foreground">
              Nothing matches this filter.
            </p>
          )
        ) : (
          <pre
            className={cn(
              "p-2 font-mono text-[11px] leading-4",
              wrap ? "whitespace-pre-wrap break-words" : "whitespace-pre",
            )}
          >
            {state.text ||
              (state.error
                ? ""
                : paused
                  ? "Paused."
                  : state.loaded
                    ? "No output yet."
                    : "Reading…")}
          </pre>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground" data-testid="live-status">
        {state.source ? `${SOURCE_LABEL[state.source]} · ` : null}
        {status}
        {" · "}
        {state.updatedAt === null
          ? "not read yet"
          : `updated ${formatEntryTime(state.updatedAt)}`}
        {structured
          ? ` · ${visible.length} of ${state.entries.length} ${state.entries.length === 1 ? "entry" : "entries"}`
          : null}
        {state.truncated ? " · older output was trimmed" : null}
      </p>
      {copyNote ? (
        <p role="status" className="text-[11px] text-muted-foreground">
          {copyNote}
        </p>
      ) : null}
      {state.warning ? (
        <p className="flex items-start gap-1 text-[11px] text-muted-foreground">
          <Icon name="AlertTriangle" className="mt-px size-3.5 shrink-0" />
          {state.warning}
        </p>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-[11px] text-destructive">
          Couldn’t read live output: {state.error}
        </p>
      ) : null}
    </>
  );

  return (
    <section className="space-y-1.5">
      {expanded ? (
        <>
          <p className="text-[11px] text-muted-foreground">
            Live output is open in the larger view.
          </p>
          <dialog
            ref={dialogRef}
            aria-label="Live output"
            onClose={() => setExpanded(false)}
            className="h-[85vh] w-[min(72rem,92vw)] max-w-none rounded-lg border border-border bg-background p-0 text-foreground backdrop:bg-black/50"
          >
            <div className="flex h-full min-h-0 flex-col gap-1.5 p-3">{content}</div>
          </dialog>
        </>
      ) : (
        content
      )}
    </section>
  );
}
