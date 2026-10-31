# Agent Graph: notes for agents

A bb plugin that draws a live node graph of bb agents: project → thread →
turn → tool call / subagent / workflow agent, plus child threads. See
README.md for features and the code map.

## Fork notes

This checkout is `alexey-igrychev/bb-plugin-agent-graph`, an experimental public
fork adding live output and pi-pi worker support. `upstream` is Nathan Colgate's
repository. Preserve its MIT license and copyright. The history below describes
the original project, not this user's local installation. Use the fork owner's
Git identity, not the original author's. No upstream PR or installation is part
of the current testing task. Ask before pushing, as in the release procedure.

## Upstream status (as of 2026-09-23)

- v0.1.0 is released: tag `v0.1.0` on
  https://github.com/nathancolgate/bb-plugin-agent-graph (public, MIT).
- Marketplace listing is live (merged 2026-09-23):
  https://github.com/get-bb/marketplace/pull/342. The listing tracks
  `^0.1.0`, so new `v0.1.x` tags reach users without another marketplace PR.
  A new PR is needed only to change the source, name, icon, description,
  category, screenshots or version range. The listing files live in that
  repo: `entries/agent-graph.json`, `overview/agent-graph.md`,
  `screenshots/agent-graph/`.
- The user's own bb runs this plugin from this folder
  (`bb plugin source agent-graph` shows `path:/home/nathan/rails/bb-plugin-agent-graph`).
- History: the plugin was built in bb thread `thr_wn7da87tmr` (Personal
  project). @-mention it to read the full conversation.

## Develop

```sh
npm install
bb plugin dev        # rebuild and reload on save
npm test             # node --test: tests/layout.test.ts, tests/timeline.test.ts
npm run typecheck
bb plugin build
bb agent-graph --thread <id>   # quick check of the graph data from a shell
```

Visual checks: the page is at `http://127.0.0.1:38886/plugins/agent-graph/graph`.
The `agent-browser` CLI can open and screenshot it. Only one agent should
drive that browser at a time, because it is a shared session.

## Release

1. Bump `version` in package.json (patch for fixes, minor for features;
   a minor bump means updating the marketplace range, e.g. `^0.2.0`).
2. Run the checks above, then commit.
3. Ask the user before pushing. Then:
   `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin main vX.Y.Z`

The upstream checkout uses Nathan Colgate's Git identity. Do not copy that
identity into this fork; verify the fork owner's author before committing.

## Things worth knowing

- **Timelines:** finished turns come as a `turn` row. The user prompt comes
  before it with no turnId, and the reply after it with the turnId. The live
  turn comes as flat rows sharing a turnId. `timeline.ts` normalizes both
  and is unit tested.
- **Cache:** a thread's `updatedAt` does NOT change while a turn streams.
  The timeline cache in `server.ts` is evicted on every structural
  `thread:changed` event, and running threads always refetch.
- **Background subagents:** a background delegation row is "completed" at
  launch. The subagent counts as running until its `SubagentHandback` child
  appears (Claude Code specific). Its real output is the handback's
  `toolArgs.message`.
- **Settings:** bb settings only support string/boolean/select/project, not
  numbers, so the numeric settings are selects parsed in `parseConfig`.
- The frontend must not import runtime values from `server.ts` (that would
  bundle server code). Shared values go in `shared.ts`.

## Open ideas (from the review, not done yet)

- Arrow-key navigation of the tree (roving tabindex, `role="tree"`).
- A simplified card style below ~70% zoom (bigger label, no sublabel).
- Only render on-screen nodes, and memoize cards, for 1000+ node graphs.
  Also move the pulse animation off `box-shadow`.
- Highlight the selected node's path to the root and dim the rest.
- Map `backgroundTask` timeline rows explicitly (they fall back to generic
  tool nodes).
- A color palette checked for color-blind users (shell green vs. done green,
  web blue vs. running blue).
