# Agent Graph for bb

See what every [bb](https://getbb.app) agent is doing, as a live map.

## Experimental fork: live output and pi-pi

This public fork of [Nathan Colgate's Agent Graph](https://github.com/nathancolgate/bb-plugin-agent-graph)
adds read-only live output and pi-pi worker activity. It requires **bb 0.47.1 or newer**.
The upstream plugin and marketplace listing below are unchanged; this fork is
not installed automatically, and no upstream PR has been opened.

Select a thread, tool call, subagent or process to open **Live output** in its
details. Entries distinguish messages, reasoning, commands, tools, stdout and
stderr, with recorded timestamps and status/exit badges where available.
Expand the panel for longer logs; search retained entries, filter by type,
toggle wrapping or copy the filtered output. **Follow** stops when you scroll
up and can be resumed explicitly. Pause/resume reading independently. The panel
reads BB's normalized events incrementally; it shows command output, messages
and tool results as the provider supplies them. Some providers only send a
result when a tool finishes: this is not an interactive terminal or a promise
of character-by-character stdout. Nodes without a tool/worker target show the
whole thread's event stream.

Only the selected log is followed. Active targets poll every second; finished
targets refresh every ten seconds after catch-up. Polling stops while paused,
hidden or unmounted. Failed reads retain the last visible text. The panel keeps the
latest 200,000 characters and at most 1,000 entries, with an explicit notice
when older output was dropped; unusually large entries are also labelled as
truncated. The header distinguishes catching up, following, paused and failed
reads, and shows the time of the last successful read. Provider-side
retention limits still apply.

### pi-pi workers

Both the overview and focused graph read `pi-pi/state.json` through BB's
host-aware SDK. Worker status, current step, model, tool count and result enrich
the launch node instead of adding a duplicate. Worker activity keeps the
thread and its ancestors active while the main agent waits. A stopped heartbeat
marks unfinished workers interrupted instead of pretending they completed.

Existing pi-pi versions support this graph activity and an explicitly labelled
latest-output preview. **Full worker transcripts require the accompanying pi-pi
change** that exports optional `workers[].transcriptFile` in that state file.
The graph reads that server-selected path on the same host; clients send only
thread and worker IDs. It never guesses a transcript directory. A resumed run
with a different file resets the panel to that run; previous runs are not joined
automatically. Transcripts contain recorded messages and tool results, not
necessarily token-level streaming output.

The current SDK reads whole files, so only the selected worker's transcript is
read, with a 21 MiB input limit (pi-pi itself caps recordings at 20 MiB).
Backlog pages share one immutable file snapshot instead of re-reading the
whole file per page; the server caches at most two snapshots. Three or more
concurrent worker panes can evict each other's snapshots and require extra
whole-file reads. At EOF the
snapshot refreshes at most once a second for active workers or ten seconds for
finished workers. Capped recordings remain readable and show a truncation
warning. Native delegations with their own BB thread follow that child thread.
Provider buffer resets are labelled in the log. Deduplication keeps only the
latest 64 snapshots, independently of active descendants. More than 1,000
simultaneously tracked items can drop old descendant tracking, with an explicit
warning.

### Processes launched by pi-pi workers

With the accompanying pi-pi patch, a worker's process nodes appear beneath it:
root command → sampled child → sampled grandchild. Details include PID, state,
start/end time, observed exit code/signal, sampled CPU percentage and resident
memory. A worker can finish while its background process keeps its thread
active; the worker itself remains completed. Missing sampled exit codes are
shown as unknown, never as success. The producer retains up to 64 processes per
worker and 256 per runtime, preferring active work over finished history; the
consumer accepts at most 128 per worker and likewise keeps active entries
first. Older finished nodes can disappear at these limits. Unreadable process
records leave a visible worker warning instead of silently hiding everything.

The producer observes Node's asynchronous child-process notifications inside
that worker's tool execution context. It does not replace the shell runner or
change quoting, cwd, environment, permissions, timeouts or cancellation. A
bounded POSIX `ps` sampler reads metadata without command arguments or process
environments, then retains only ownership-filtered rows. PID/start-time checks
and a short process-group grace reduce accidental reassociation. This is
best-effort observation: synchronous/native or remote spawns, very short-lived
descendants, and daemons that escape before discovery can be absent. Windows
can report directly observed roots, without POSIX resource/tree sampling.
CPU readings are the operating system's estimates, not a profiling trace.

Selecting a process follows its private, bounded JSONL log through the same
host-aware API. Known shell pipes are observed only when the SDK already reads
them; arbitrary tools' streams are not put into flowing mode. Stdout/stderr are
separate where actually captured. Descendants share the root command's streams
and are explicitly labelled as shared, not as private per-PID output. Ignored
or redirected output is reported unavailable; the plugin never guesses and
tails arbitrary files. Process capture stops retaining output at 1 MiB per root
and 16 MiB per producer runtime, with a visible cap marker; metadata continues.
That runtime budget is cumulative, not reset when process history is pruned.
Files remain in the thread's storage across producer restarts; this feature
does not automatically delete recordings from previous runs.
Only the selected process log is read, with a 2 MiB consumer input limit.

No new process-control commands, attachment, terminal input or automatic
installation are included. Process trees and metrics follow the same visible,
selected-target polling policy as the rest of the graph.

### Test this checkout

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
npm run build
```

To install for manual testing **when ready**, run `bb plugin install` with the
local checkout path or a published ref of this fork. Installing replaces the
existing Agent Graph plugin; it is deliberately a separate action. The stock
pi-pi installation remains unchanged until its transcript-metadata change is
installed separately.

Agent Graph draws your projects, threads, turns, tool calls, subagents and
workflow agents as a graph that updates while agents work. Instead of scrolling
through logs to find out what a subagent is up to, you glance at the map. Click
any node to see what it did.

![Agent Graph beside a thread, showing three subagents and their tool calls](docs/subagents.png)

Inspired by the Agent Graph in GitKraken's
[Kepler](https://gitkraken.com/kepler).

## Install

In bb, open **Extensions**, search for **Agent Graph** and click Install.

Or from a terminal:

```sh
bb plugin install agent-graph
```

Requires bb 0.41 or newer.

## How it works

The graph reads left to right:

```
Agents → Project → Thread → Turn → Tool call
                                 → Subagent → its tool calls
                                 → Workflow → workflow agents
                          → Child thread → …
```

- **Turns** are labeled with the prompt that started them. A turn with no
  prompt, where the agent was woken by a background task, is labeled
  "Automatic turn".
- **Subagents** show their own tool calls nested inside. Their details show the
  report they handed back to the parent agent.
- **Child threads**, such as threads spawned by another thread, sit under their
  parent.

### Colors

By default, nodes are colored **by type**:

| Type | Color | | Tool call | Color |
| --- | --- | --- | --- | --- |
| Project | indigo | | Shell | lime |
| Thread | sky blue | | File edit | amber |
| Turn | purple | | Read / search | cyan |
| Subagent | pink | | Web | blue |
| Workflow | teal | | Other tool | slate |

Each tool type also has its own icon, and a dot in the corner of every card
shows its status.

Switch to **Color: Status** in the toolbar to color by status instead: running
(blue), needs input (amber), queued (violet), done (green), error (red),
interrupted (orange) or idle (grey).

In both modes, running work pulses and has animated edges leading into it.
Errors get a solid red border, and nodes waiting for your input get a dashed
amber one.

## Where it shows up

### The Agent Graph page

**Agent Graph** in the sidebar shows every thread active in the last 12 hours,
plus anything running, grouped by project.

To talk to an agent while you watch, select its node and choose **Chat beside
graph**, or double-click it. That thread's chat, reply box included, opens in
the page's right panel. Before you pick one, that panel lists your recent
threads.

### Beside any thread

Click the graph icon in a thread's header to open the graph in the right
panel. Switch between **This thread** and **All threads** at the top. The
graph remembers your choice.

### From the command line

```sh
bb agent-graph                  # every recently active thread
bb agent-graph --thread <id>    # one thread, its turns, subagents and child threads
bb agent-graph --json           # machine-readable output
```

This prints the same graph as a text tree, so agents can check what their
sibling agents are doing.

## Controls

| Action | How |
| --- | --- |
| See a node's details | Click it |
| Open a thread's chat | Double-click any of its nodes |
| Collapse or expand | The chevron on a card, or **Expand** / **Collapse** in the toolbar |
| Show hidden tool calls | Click "+N earlier steps" |
| Pan | Drag, or scroll |
| Zoom | ⌘/ctrl + scroll, pinch, or `+` / `-` |
| Fit to view | `0`, or **Fit** |
| Jump to running work | `J`, or the **Running** button (click again to cycle) |
| Hide finished work | **Active only** |
| Close details | `Esc` |

Finished turns and subagents start collapsed so the graph opens on what's
happening now. Long runs of tool calls fold into "+N earlier steps".

## Settings

Open **Settings → Agent Graph**, or use `bb plugin config agent-graph`:

| Setting | Default | What it controls |
| --- | --- | --- |
| Overview window (hours) | 12 | How far back the overview looks for active threads |
| Max threads in overview | 20 | The most threads the overview shows |
| Turns per thread in overview | 1 | How many recent turns each thread shows in the overview |
| Turns in single-thread view | 8 | How many recent turns the thread view shows |

Changes apply right away.

## Privacy and permissions

- Agent Graph reads your threads, projects and timelines through the bb plugin
  SDK. It never sends them anywhere else and makes no outside network requests.
- It has no secrets or API keys.
- It stores only a few view preferences (color mode, graph scope, the thread
  you last chatted with) in your browser's local storage.
- Chatting beside the graph uses bb's own chat component, with the thread's
  normal permission settings.

## Troubleshooting

- **A thread is missing from the overview.** It may be older than the overview
  window, or past the thread limit. Raise either in Settings, or open the
  thread and use its graph button.
- **The graph looks stale.** It refreshes on every change and every 15 seconds
  while visible. If a refresh fails, a message with a **Retry** button appears.
- **Everything is collapsed.** Click **Expand** in the toolbar, or press `J` to
  jump to running work.

## Develop

```sh
git clone https://github.com/nathancolgate/bb-plugin-agent-graph.git
cd bb-plugin-agent-graph
npm install
bb plugin install .   # install from this folder
bb plugin dev         # rebuild and reload on every save
```

Checks:

```sh
npm test              # unit tests for the layout and timeline grouping
npm run typecheck
npm run build
```

Code map:

| File | What it does |
| --- | --- |
| `server.ts` | Builds the graph from bb thread timelines, pushes live updates, and adds the `bb agent-graph` command |
| `timeline.ts` | Groups timeline rows into turns |
| `layout.ts` | Lays out the tree and folds long runs of tool calls |
| `graph.tsx` | The graph view: cards, edges, pan and zoom, details panel |
| `app.tsx` | Registers the sidebar page, side panels and header button |
| `shared.ts` | Constants and helpers used by both the backend and the frontend |

Issues and pull requests are welcome.

## License

[MIT](LICENSE) © Nathan Colgate
