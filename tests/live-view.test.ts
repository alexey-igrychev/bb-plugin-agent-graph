import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveEntry } from "../live-types.ts";
import type { GraphNode } from "../server.ts";
import {
  copyTextFor,
  entryBadges,
  entryBody,
  filterEntries,
  formatEntryTime,
  isAtBottom,
  LIVE_FILTER_LABEL,
  liveCaptionFor,
  type LiveFilter,
} from "../live-view.ts";

const entry = (overrides: Partial<LiveEntry> = {}): LiveEntry => ({
  id: "e1",
  at: Date.UTC(2026, 0, 2, 3, 4, 5),
  kind: "stdout",
  text: "hello",
  ...overrides,
});

const ids = (entries: readonly LiveEntry[]) => entries.map((item) => item.id);

const sample: LiveEntry[] = [
  entry({ id: "u", kind: "user", text: "run the build" }),
  entry({ id: "a", kind: "assistant", text: "running npm build" }),
  entry({ id: "t", kind: "thinking", text: "deciding" }),
  entry({ id: "tool", kind: "tool", text: "{}", tool: "Bash", status: "done" }),
  entry({ id: "cmd", kind: "command", text: "", command: "npm run build" }),
  entry({ id: "out", kind: "stdout", text: "built ok" }),
  entry({ id: "err", kind: "stderr", text: "warning: slow" }),
  entry({ id: "sys", kind: "system", text: "process exited", exitCode: 2 }),
];

test("every filter has a label", () => {
  const filters: LiveFilter[] = ["all", "messages", "tools", "commands", "output", "errors"];
  for (const filter of filters) assert.equal(typeof LIVE_FILTER_LABEL[filter], "string");
});

test("filters entries by kind group", () => {
  assert.deepEqual(ids(filterEntries(sample, "all", "")), ids(sample));
  assert.deepEqual(ids(filterEntries(sample, "messages", "")), ["u", "a", "t"]);
  assert.deepEqual(ids(filterEntries(sample, "tools", "")), ["tool"]);
  assert.deepEqual(ids(filterEntries(sample, "commands", "")), ["cmd"]);
  assert.deepEqual(ids(filterEntries(sample, "output", "")), ["out", "err"]);
});

test("the error filter keeps stderr and failed entries", () => {
  const failed = entry({ id: "bad", kind: "tool", tool: "Bash", status: "error" });
  const exited = entry({ id: "exit", kind: "command", command: "false", exitCode: 1 });
  const ok = entry({ id: "ok", kind: "command", command: "true", exitCode: 0 });
  // Providers and processes report terminal failure with their own words.
  const provider = entry({ id: "prov", kind: "tool", tool: "Bash", status: "failed" });
  const stopped = entry({ id: "stop", kind: "command", command: "sleep 9", status: "interrupted" });
  const killed = entry({ id: "kill", kind: "command", command: "sleep 9", status: "killed" });
  const running = entry({ id: "run", kind: "tool", tool: "Bash", status: "running" });
  assert.deepEqual(
    ids(filterEntries([...sample, failed, exited, ok, provider, stopped, killed, running], "errors", "")),
    ["err", "sys", "bad", "exit", "prov", "stop", "kill"],
  );
});

test("a command entry reads as the command and everything it printed", () => {
  assert.equal(
    entryBody(entry({ kind: "command", command: "npm test", text: "58 passing" })),
    "npm test\n58 passing",
  );
  assert.equal(entryBody(entry({ kind: "command", command: "npm test", text: "" })), "npm test");
  assert.equal(entryBody(entry({ kind: "command", text: "orphan output" })), "orphan output");
  assert.equal(entryBody(entry({ kind: "stdout", text: "plain" })), "plain");
});

test("search matches text, tool and command, case-insensitively", () => {
  assert.deepEqual(ids(filterEntries(sample, "all", "BUILD")), ["u", "a", "cmd"]);
  assert.deepEqual(ids(filterEntries(sample, "all", "bash")), ["tool"]);
  assert.deepEqual(ids(filterEntries(sample, "output", "built")), ["out"]);
  assert.deepEqual(ids(filterEntries(sample, "all", "   ")), ids(sample));
  assert.deepEqual(ids(filterEntries(sample, "all", "nothing here")), []);
});

test("badges name the entry's role, tool, status and exit code", () => {
  assert.deepEqual(entryBadges(entry({ kind: "stderr" })), ["stderr"]);
  assert.deepEqual(
    entryBadges(entry({ kind: "tool", tool: "Bash", status: "running" })),
    ["tool", "Bash", "running"],
  );
  assert.deepEqual(
    entryBadges(entry({ kind: "command", command: "npm test", exitCode: 1 })),
    ["command", "exit 1"],
  );
  assert.deepEqual(entryBadges(entry({ kind: "command", exitCode: 0 })), ["command", "exit 0"]);
});

test("timestamps fall back to a placeholder when unknown", () => {
  assert.equal(formatEntryTime(null), "--:--:--");
  assert.match(formatEntryTime(entry().at), /\d{2}:\d{2}:\d{2}/);
});

test("copied text carries what is on screen, with time, role and outcome", () => {
  const copied = copyTextFor([
    entry({
      id: "cmd",
      kind: "command",
      text: "58 passing",
      command: "npm run build",
      status: "failed",
      exitCode: 1,
    }),
    entry({ id: "out", kind: "stdout", text: "built ok" }),
    entry({ id: "none", kind: "system", at: null, text: "gone" }),
  ]);
  const lines = copied.split("\n");
  assert.equal(lines.length, 4, "the command's output keeps its own line");
  assert.match(lines[0]!, /^\d{2}:\d{2}:\d{2} \[command failed exit 1] npm run build$/);
  assert.equal(lines[1], "58 passing");
  assert.match(lines[2]!, /^\d{2}:\d{2}:\d{2} \[stdout] built ok$/);
  assert.equal(lines[3], "--:--:-- [system] gone");
  assert.equal(copyTextFor([]), "");
});

test("following stays engaged only while the view is at the bottom", () => {
  assert.equal(isAtBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(isAtBottom({ scrollTop: 880, scrollHeight: 1000, clientHeight: 100 }), true);
  assert.equal(isAtBottom({ scrollTop: 400, scrollHeight: 1000, clientHeight: 100 }), false);
  // A view shorter than its box is always at the bottom.
  assert.equal(isAtBottom({ scrollTop: 0, scrollHeight: 80, clientHeight: 100 }), true);
});

test("the caption keeps the node's identity beside the output", () => {
  const node = (overrides: Partial<GraphNode> = {}): GraphNode => ({
    id: "n1",
    parentId: null,
    kind: "tool",
    label: "npm test",
    sublabel: null,
    status: "running",
    threadId: "thr_1",
    startedAt: null,
    completedAt: null,
    input: null,
    output: null,
    meta: {},
    ...overrides,
  });
  assert.equal(
    liveCaptionFor(node({ sublabel: "process", meta: { kind: "process", pid: "48213" } })),
    "npm test · pid 48213",
  );
  assert.equal(
    liveCaptionFor(node({ label: "Bash", sublabel: "npm run build" })),
    "Bash · npm run build",
  );
  assert.equal(liveCaptionFor(node({ label: "worker-2" })), "worker-2");
  assert.equal(liveCaptionFor(node({ sublabel: "process", meta: { pid: "" } })), "npm test · process");
});
