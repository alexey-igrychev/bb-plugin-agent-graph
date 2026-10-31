// The live output panel: read-only text streamed from the selected node's
// thread, worker or tool call, polled while it is visible and not paused.
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
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

const SOURCE_LABEL: Record<LiveSource, string> = {
  events: "Events",
  transcript: "Transcript",
  preview: "Preview",
};

export function LivePanel({
  threadId,
  itemId,
  workerId,
  active,
}: {
  threadId: string;
  /** Tool call or native subagent to follow; null follows the whole thread. */
  itemId: string | null;
  /** pi-pi worker to follow, when the node is one. */
  workerId: string | null;
  /** The node is still working; finished work is read on the slow cadence. */
  active: boolean;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<LiveState>(emptyLiveState);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const cursorRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLPreElement>(null);

  // A new target starts from scratch. Declared before the poll effect so the
  // cursor is cleared before the next read uses it.
  useEffect(() => {
    cursorRef.current = null;
    setState(emptyLiveState);
  }, [threadId, itemId, workerId]);

  useEffect(() => {
    if (paused) return;
    // The controller owns this target's reads; stopping it drops the ones in
    // flight, so a target change cannot deliver a stale page. A cadence change
    // rebuilds it without touching the cursor, so reading continues where it
    // left off.
    const controller = createLiveController({
      pollMs: active ? LIVE_POLL_MS : LIVE_SLOW_POLL_MS,
      read: () =>
        rpc.call("live", { threadId, itemId, workerId, cursor: cursorRef.current }),
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
  }, [rpc, threadId, itemId, workerId, paused, active]);

  useEffect(() => {
    if (!follow) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [follow, state.text]);

  return (
    <section className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <h3 className="flex-1 truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Live output
          {state.source ? (
            <span className="ml-1.5 normal-case tracking-normal">
              · {SOURCE_LABEL[state.source]}
            </span>
          ) : null}
        </h3>
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
      </div>
      <pre
        ref={bodyRef}
        aria-live="off"
        className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-4"
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
      {state.truncated ? (
        <p className="text-[11px] text-muted-foreground">
          Older output was trimmed; only the most recent part is shown.
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
    </section>
  );
}
