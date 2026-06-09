# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An always-on-top Electron desktop widget that reads Claude Code's **local** `~/.claude`
data to show live session activity, real Anthropic usage limits, and an estimated
token burn rate. There is no backend of its own — every data source is a file on
disk or the one undocumented usage endpoint.

## Commands

```bash
npm run dev        # electron-vite dev with live reload
npm run build      # production build into out/
npm start          # preview the production build (electron-vite preview)
npm run typecheck  # tsc --noEmit over both tsconfig projects (node + web)
npm run package    # build + electron-builder → Windows NSIS installer in dist/
```

There is no test runner and no linter configured. `npm run typecheck` is the only
static check; run it after changes to main/preload/shared or renderer code.

## Architecture

Standard three-tier electron-vite layout. The build splits along these boundaries,
and `externalizeDepsPlugin` keeps node deps external in main/preload only.

- `src/main/` — Node/Electron main process. Owns all data acquisition and the window/tray.
  - `index.ts` (lifecycle/window/tray/IPC), `claudeHome.ts` (path helpers), `sessionMonitor.ts`,
    `transcriptReader.ts`, `stateDeriver.ts`, `usageProvider.ts`, `burnRate.ts`, `pricing.ts`.
- `src/preload/` — context-bridge shim exposing a typed `window.widget` API.
- `src/renderer/` — React 19 UI (no router, no state library). `App.tsx` plus
  `components/` — `UsageBars.tsx`, `SessionList.tsx`, `BurnRate.tsx`, `Sparkle.tsx`.
- `src/shared/types.ts` — the contract between processes. **Edit this first** when
  changing any data shape; main, preload, and renderer all import from it.

### Data flow (one direction: main → renderer)

Three independent providers in `src/main/` each run on their own timer, hold a
listener set, and push snapshots to the renderer over named IPC channels. The
renderer never requests data and never writes — it only subscribes.

1. **`SessionMonitor`** (`sessionMonitor.ts`) — watches `~/.claude/sessions/` with
   chokidar **plus** a 2s poll fallback (file mtime doesn't always change on
   busy→idle). For each live `{pid}.json` whose process `isAlive`, it finds the
   transcript and derives state.
2. **`UsageProvider`** (`usageProvider.ts`) — polls the OAuth usage endpoint every
   180s. See "Usage endpoint" below.
3. **`BurnRateTracker`** (`burnRate.ts`) — every 5s, re-scans transcript tails of
   the *current* sessions (fed in via `setSessions`) and sums token usage over a
   rolling 5-minute window into a per-model cost estimate.

`index.ts` wires the three providers' `onUpdate` callbacks to `send()` over the
channels in `Channels` (`shared/types.ts`), caches the last snapshot of each in
`lastSessions`/`lastUsage`/`lastBurn`, and **replays** them via `replaySnapshots()` on
every renderer load (`did-finish-load`) and on the renderer's explicit `renderer:ready`
ping — so a reload (dev Ctrl+R) or a missed push still re-hydrates. When adding a new
data stream, follow this same shape: a channel in `Channels`, a cached `last*` in
`index.ts`, a `replaySnapshots` line, a preload `subscribe`, and a field in `WidgetApi`.

**Two renderer→main channels exist** (the only direction the renderer talks back):
- `renderer:ready` — sent from `App.tsx`'s effect via `window.widget.ready()` **after**
  it subscribes. Critical ordering: the ping must come from React, not preload top-level,
  or the first snapshot races the subscription and is lost (the bars stayed empty until
  the next 180s poll — this was a real bug).
- `widget:resize` — sent via `window.widget.resize(height)`; main clamps to
  `[MIN_H, MAX_H]` and `setContentSize`s the window. See "Window & UI" below.

### Reading Claude Code's local data

All paths come from `claudeHome.ts`, which honors `CLAUDE_CONFIG_DIR` (default
`~/.claude`). Use these helpers — never hardcode the path.

- `sessions/{pid}.json` → the live session registry (`pid`, `sessionId`, `cwd`,
  `status: 'busy'|...`). Source of truth for which sessions exist and busy/idle.
- `projects/**/<sessionId>.jsonl` → per-session transcript. Located by matching
  the `<sessionId>.jsonl` filename **anywhere** under `projects/` (the directory
  is a cwd-path encoding we deliberately don't try to reconstruct);
  `findTranscript` caches the resolved path per sessionId.
- `.credentials.json` (`claudeAiOauth`) → OAuth tokens for the usage API.

Transcripts are JSONL and can be large. Both readers **tail bytes, not whole
files** (`transcriptReader.ts` reads the last 128 KB for state; `burnRate.ts`
scans 512 KB for token sums) and drop a partial first line after slicing.

### State derivation

`stateDeriver.ts` turns a transcript tail + the registry `busy` flag into a
`SessionState` (full union in `shared/types.ts`): `planning`, `thinking`, `editing`,
`reading`, `searching`, `running`, `browsing`, `spawning`, `working`, `responding`,
`asking`, `awaiting`, `idle`, `unknown`.

Rules, in priority order:
- **Trust `status === 'busy'`.** A busy session is *never* forced idle by a stale
  `updatedAt` — Claude Code does **not** bump `updatedAt` during a long single turn, so a
  staleness override here wrongly showed "Idle" mid-work (a real bug we fixed). Note
  `updatedAt` in the registry is **stale/lagging** in general (it can trail the latest
  transcript event by minutes), so `lastActivity` is driven by transcript timestamps, not
  it. Liveness is handled upstream by `isAlive(pid)` in `sessionMonitor.ts`, which drops
  dead PIDs before derivation runs. The only `updatedAt`/`lastActivity` recency check left
  lives **inside the non-busy branch**, to tell `awaiting` (turn just ended) from `idle`
  (ended a while ago).
- `AskUserQuestion`/`ExitPlanMode` as the last tool → `asking` (highest priority; holds in
  both branches). This is a *blocking* prompt — Claude can't continue until the user acts —
  so it has **no recency cutoff**: a question that sits on screen for minutes must not decay
  to `idle` (a real bug — the old single `awaiting` state used the 60s fuse and flipped a
  pending question to "Idle"). `asking` (active, "Needs you") is distinct from `awaiting`
  (passive — Claude's turn just *ended* with plain text, "your input"), which keeps the
  recency check.
- **`tool_result` is recorded as a `user` event.** So right after any tool returns (busy,
  mid-turn) the last meaningful event is a `user` `tool_result`, not an assistant block.
  Don't read that as `thinking`: scan back for the originating assistant `tool_use` and
  **reuse its state** (`lastAssistantTool` → `toolState`), falling back to `working`. This
  keeps the badge on the in-flight activity (`running`/`editing`/…) between tool calls
  instead of flickering to "Thinking" (a real bug we fixed).
- `permissionMode === 'plan'` (latest `permission-mode` event in the tail) → `planning`.
- Otherwise the last assistant `tool_use` name maps through `TOOL_STATES`:
  Edit/Write/MultiEdit/NotebookEdit→`editing`, Read/NotebookRead→`reading`,
  Grep/Glob/ToolSearch→`searching`, Bash/PowerShell→`running`, WebSearch/WebFetch→`browsing`,
  Agent/Task/Workflow→`spawning` (sub-agents counted via `isSidechain`); anything else→`working`.
- Assistant text with no tool while busy → `responding`; a genuine fresh `user` turn (a
  `user` event with **no** `tool_result` block) or a `thinking` block → `thinking`.

Adding a tool means adding it to a `TOOL_STATES` set; a new state means a new entry in the
`SessionState` union **and** in `STATE_META` (`renderer/components/SessionList.tsx`, which
maps each state to a label/icon/`.st-*` color class) **and** a `.st-*` rule in `styles.css`.

### Usage endpoint (undocumented)

`GET https://api.anthropic.com/api/oauth/usage`, isolated in `usageProvider.ts` so
it can be swapped if it changes. Notes that matter:

- Requires `anthropic-beta: oauth-2025-04-20` and a `User-Agent: claude-code/<version>`.
- **Do not poll faster than 180s.**
- On 401 it refreshes the OAuth token (`platform.claude.com/v1/oauth/token` with
  the public Claude Code `CLIENT_ID`) and retries once. Refreshed tokens are
  written back to `.credentials.json` **atomically** (temp file + rename, mode
  `0600`) preserving other fields — keep this behavior; the user's real CLI
  depends on that file.
- `bootstrap()` retries early failures (5s, 20s) so the bars aren't empty for a
  full interval at launch.

### Cost estimates

`pricing.ts` holds a per-million-token rate table keyed by model family
(opus/sonnet/haiku, substring match, sonnet fallback). These are **estimates only**
— subscription usage isn't billed per token — and the table must be updated by
hand as prices change. `burnRate.ts` emits `tokensPerMin`, a rolling-window cost, and a
per-model breakdown; `BurnRate.tsx` renders the three figures.

### Window, UI & interaction

- **Content-driven sizing.** The window has no fixed height. `App.tsx` puts a
  `ResizeObserver` on `.widget` and (throttled to one rAF) calls `window.widget.resize()`
  with the measured height; `index.ts` `setContentSize`s the window to it (clamped
  `MIN_H`/`MAX_H`, top-left anchored). So the widget always hugs its content — no wasted
  space.
- **Collapse.** The `▴/▾` button toggles a `collapsed` class on `.widget`. The session list
  + burn strip live in a `.collapsible` wrapper animated with the CSS grid
  `grid-template-rows: 1fr → 0fr` trick; the content stays mounted (so it animates) and the
  window follows the shrinking height frame-by-frame via the ResizeObserver. Collapsed =
  titlebar + usage bars only. Honors `prefers-reduced-motion`.
- **Usage bars.** `UsageBars.tsx` shows **5-hour** and **Weekly** only (monthly was removed;
  the `monthly` field still exists in `UsageSnapshot` if it's ever re-added). Each maps a
  `UsageWindow` (utilization % + `resetsAt`) to a bar with an inline reset countdown; ≥90%
  turns the fill red.
- **Theme.** Anthropic light-ivory palette, all via CSS variables in `styles.css`
  (`--bg` ivory, `--fg` slate, `--accent` terracotta `#DA7756`, `--accent-ink` Crail
  `#C15F3C` for text on ivory, `--accent2` kraft, `--accent3` sage, `--danger`). Recolor by
  editing the variables, not call sites.
- **State badge chips.** Each `SessionState` has its **own pastel chip** — a soft light
  same-hue background + a deeper same-hue text — in its `.st-*` rule (`styles.css`):
  planning peach, thinking lavender, editing butter, reading sky, searching periwinkle,
  running mint, browsing aqua, spawning sage, responding rose, working warm-neutral,
  awaiting amber, idle gray. **`asking` is the one deliberate exception**: a *solid*
  terracotta (`--accent`) chip — the single bold call-to-action so "Needs you" pops among
  the pastels. The "indeterminate/attention" states (`st-plan`, `st-think`, `st-spawn`,
  `st-ask`, `st-await`) pulse their icon via the `pulse` keyframe; active tool-work states
  don't. These hexes are inlined per `.st-*` rule (not theme variables), so retint there.
- **Sparkle logo.** `Sparkle.tsx` is an original SVG recreation of Claude's starburst (12
  generated rays, `fill="currentColor"`), not the trademarked asset. It's **activity-driven**
  via an `active` prop (`active > 0` sessions): fast spin + shimmer when busy, slow breathe
  when idle; `.sparkle` styles in `styles.css`.
- **Tray + global hotkey.** A `Tray` icon (terracotta square drawn in-code, no asset file)
  with a show/hide + quit menu and a live stats tooltip. **Alt+Shift+A** is registered via
  `globalShortcut` to toggle visibility, released in `before-quit`. Window position persists
  to `window-state.json` in `userData`.

## Conventions

- Strict TypeScript, ES2022, ESM, 2-space indent, no semicolons (match existing files).
- Providers all share the same shape: `onUpdate(cb)` returning an unsubscribe,
  a `start()`/`stop()`, an internal timer, and an `emit()` over a listener set.
- File access is best-effort: readers swallow errors and return empty/null rather
  than throwing, so one bad file never takes down the widget.
