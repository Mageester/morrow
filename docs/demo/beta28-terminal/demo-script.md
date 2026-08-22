# Demo Script — What Was Actually Run (Post-Fix Verification Session)

A record of exactly what was asked and why, in order, for the verification
run against the fixed code on 2026-07-10.

## Setup

1. Discovered the previous package's report-integrity audit had failed —
   the real transcript showed the turn-boundary bug (see root cause and fix
   in [PR #36](../../..)).
2. After the fix merged (`450f3f5` on `main`), attempted to re-run this demo.
   The first re-run **still showed the bug** — traced to a stale orchestrator
   background service (started ~36h before the fix existed) still bound to
   port 4317. Stopped it (`Stop-Process`), started a fresh orchestrator
   directly from the fixed repo source (`pnpm start` in
   `services/orchestrator`), and confirmed it was serving from the correct
   file (`grep assistant.turn_started services/orchestrator/src/execution/agent.ts`
   against the running process's source path).
3. Created a clean workspace: `C:\Morrow-Demo\Beta28-Terminal-v3`, `git init`,
   one empty initial commit, registered via `morrow init` against the
   correctly-restarted orchestrator.
4. Enabled `/yolo on`.

## Pass 1 — build the app (sent 2026-07-10T06:06:48Z)

> Build a small polished counter app: `index.html`, `styles.css`, `app.js`,
> plus a `verify.js` that checks the files exist and the buttons are wired
> up. Increment / Decrement / Reset.

Completed cleanly: 6 tool calls, 0 failures, 16/16 verify checks. Real
token metering visible this run (2.8k in / 76 out on the first turn) —
unlike the earlier pre-fix session, where the provider had reported
"unknown (not metered)".

## Pass 2 — one intentional improvement (sent 2026-07-10T06:08:15Z)

> Add a dark/light mode toggle button that persists the user's choice
> across reloads via `localStorage`, and extend `verify.js` to check for it.

This is the same prompt that produced the original bug's evidence. This run:
4 genuine, unstaged `propose_patch` failures (styles.css twice, app.js,
verify.js), each recovered via the real `tool.strategy_switch` escalation to
`create_file`. Task completed: 20/20 verify checks.

## The critical verification

Ran `/export`, then **read the resulting `.md` file directly** (not just a
screenshot of the overlay, which only ever shows a tail-view of the report):

- `## Final Answer` appears exactly once.
- `grep -c "Now I have full context"` → **0** occurrences (was 12 in the
  original pre-fix export).
- A new `## Intermediate Activity` section lists the 7 non-final turns as
  bounded one-line summaries, not raw repeated narration.
- `## Recovery Summary` cleanly lists each failure + strategy-switch pair
  once, not duplicated.

This is the authoritative check — screenshots of the terminal overlay are
included for visual context, but the actual verification was done against
the real persisted file.

## Independent verification

- `node verify.js` run directly via Bash (separate from Morrow's own
  in-session check): exit 0, 20/20 checks passed.
- Generated files confirmed on disk: `index.html` (724 bytes), `styles.css`
  (3492 bytes), `app.js` (1817 bytes), `verify.js` (4306 bytes).

## Browser verification

Served the real generated files over local HTTP
(`python -m http.server` — the browser extension used for the interactive
click-through can't reach `file://` URLs) and opened them in a genuine
Chrome window launched directly. Clicked Increment four times via real
OS-level mouse events (not the extension) — counter went 0 → 4. Verified
the theme toggle persists across reload via `localStorage`, while the
counter value correctly does not (the app only ever writes the theme key).
