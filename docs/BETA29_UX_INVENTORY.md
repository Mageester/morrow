# Beta.29 CLI UX Inventory — information ownership matrix

> Phase 1 of the beta.29 CLI UX simplification. Captured 2026-07-10 from the
> real rendering pipeline (`apps/cli/src/terminal/*`). Every fact the terminal
> can display is mapped to exactly one canonical owner. "Current locations"
> cites real code paths; duplicates are the problem this release removes.

## Renderer surfaces (before)

| Surface | Code | When |
|---|---|---|
| Header (3 lines + rule) | `view.ts headerLines` via `app-view.ts buildTopChrome` | Always (interactive) |
| Welcome panel | `app-view.ts welcomeLines` | First run / empty session |
| Stage banner | `view.ts stageBanner` | While a stage is set |
| Plan block | `app-view.ts buildMiddle` | When a plan exists |
| Conversation | `app-view.ts buildMiddle` | All turns, incl. intermediate narration |
| Tool cards / patches | `view.ts toolCardLines/patchLines` | Per tool/patch |
| Grouped activity | `view.ts activityGroupLine` | Live region |
| Completion summary | `view.ts completionLines` | On terminal status |
| Recovery hints | `app-view.ts buildMiddle` | On non-success status |
| Notices | `app-view.ts recentNotices` | Last 3 |
| Status bar (footer) | `view.ts statusBar` | Always |
| Hint line | `app-view.ts footerLine` | Always (permanent) |
| One-shot stream | `line-renderer.ts` | Non-TTY / `--message` |
| Task report | `output-report.ts buildTaskReport` | `/output*`, `/export` |

## Ownership matrix

| Information | Current locations (duplicates in bold) | New canonical location | Default / expanded |
|---|---|---|---|
| Morrow identity (brand + avatar) | **Header L1** ("MORROW" + avatar), **footer** ("Morrow" + avatar) | Header line 1; footer uses the compact `◇ Morrow` prefix only | Default |
| Project name | **Header L1**, **welcome panel** | Header line 2 | Default (survives narrow) |
| Workspace path | Header L1 | `/status` | Expanded |
| Git branch + dirty/clean | **Header L1/L2** (`gitLabel`), **footer**, **welcome** | Header line 2 (`project · branch · clean`) | Default |
| Git ahead/behind | **Header L2**, **footer** | `/branch`, `/status` | Expanded |
| Provider id | **Header L2** (`provider/model`), **welcome** | `/stats`, `/status` | Expanded |
| Model | **Header L2**, **footer**, **welcome** | Header line 3 (`model · mode`) | Default |
| Mode + autonomy (YOLO) | **Header L2** (long label), **footer**, **welcome** | Header line 3 (mode word + `YOLO` chip when on) | Default (survives narrow) |
| Memory on/off | Header L2 | `/stats` | Expanded |
| Task state (running/ready/failed) | **Header L2** ("Task running"), **footer** state word, **avatar glyph** | Footer status word (avatar mirrors it — same fact, one line) | Default (survives narrow) |
| Current task action | Stage banner + grouped activity | Structured activity line + footer (`◇ Morrow · editing verify.js`) | Default |
| Tokens in/out/cached | **Header L3**, **footer** (`N tok`) | `/stats` | Expanded |
| Context used/limit/% | **Header L3**, **footer** | `/stats`; footer shows `ctx N%` only at ≥70% (warning) | Expanded |
| Cost (incl. "unknown") | Header L3 | `/stats`, `/cost` | Expanded |
| Tool totals | **Header L3**, **footer** | Completion card + reports | On completion |
| Elapsed time | **Header L3**, **footer** | Completion card (`9 tools · 18s`) | On completion |
| Failures / recoveries | Red tool cards + warn notices (recovery events unmapped) | Recovery lines in live region (`!` / `↳` / `✓`), `Recovered` section in completion card | Default (compact) |
| Agents / processes | **Header L2/L3**, **footer** | `/stats`, `/agents`, `/ps` | Expanded |
| Command hints | Permanent footer hint line | Contextual: first session, `?`, `/` typed, palette open, inactivity | Contextual only |
| Completion result | `completionLines` + full streamed answer + recovery-hints block | Compact completion card (`Details: /output`) | Default |
| Final answer | Streamed text (all turns concatenated in transcript) | Final turn only in transcript; canonical selection unchanged (`selectCanonicalFinalAnswer`) | Default |
| Raw narration (intermediate turns) | Conversation region streams every turn | Hidden by default (structured activity represents the work); available in `/output full` | Expanded |
| Task identity/timestamp in reports | Full id + status (no timestamp) | Report header: short id, status, timestamp, task-scoped totals | `/output*` |

## Defects found during inventory (fixed by this release)

1. `tool.strategy_switch` / `patch.recovery_feedback` SSE events are **not
   mapped** in `task-event-adapter.ts` — the live session shows the failure but
   never the recovery, so a recovered failure reads as a product failure.
2. Interactive `/tasks` dispatches to `showTaskTree` (same as `/tree`),
   contradicting its registered description "list running and recent tasks".
3. `/output` cannot address a task by id anywhere (session or REPL).
4. The narrow header (<56 cols) drops the project name and task state — the
   two facts the redesign requires narrow layouts to preserve.
5. Non-TTY stdout receives every intermediate turn's narration, so a piped
   one-shot output is not "the answer" (the beta.28 canonical-answer fix
   covered the JSON `content` field, not the raw stream).
6. Task-state is triple-displayed (header text, footer word, avatar glyph);
   mode/model/branch/context/tools/time/tokens are each double-displayed.

## Visual levels (target)

- **Level 1 (default)**: identity, project, model, mode, branch/dirty,
  current action, compact completion card.
- **Level 2 (`/output`)**: task identity (short id, status, timestamp),
  files changed, verification, concise recovery summary, tool totals,
  timing, final answer.
- **Level 3 (`/output full`)**: full chronology, raw tool names/args,
  detailed errors, intermediate activity, token/context metadata,
  diagnostics. Hidden reasoning is never exposed at any level.
