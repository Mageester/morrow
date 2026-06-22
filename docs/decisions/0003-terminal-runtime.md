# ADR 0003: Event-Driven Terminal Runtime

- **Status:** Accepted
- **Date:** 2026-06-22

## Context

Morrow's CLI began as a set of command functions that printed lines directly to
`stdout`/`stderr` through the `Output` helper. That is fine for one-shot
commands but it does not scale to the product goal: a coherent, persistent,
terminal-based personal agent. Direct printing means every feature invents its
own formatting, output ordering is implicit, there is no single place that owns
the screen, and nothing is snapshot-testable as a whole.

We need a single pipeline:

```
runtime/agent events
  → normalized terminal event model
  → terminal state reducer (pure)
  → view (pure: state → lines)
  → renderer (owns all visible output)
  → input controller
```

The renderer must own visible output. Commands, tools, approvals, plans,
patches, jobs, and model streaming emit **structured events**, never arbitrary
console writes. A non-interactive line renderer must remain for redirected
output, CI, JSON mode, unsupported terminals, accessibility, and logs.

## Renderer options evaluated

| Option | Windows | Input | Resize | Streaming | Testing | Dep cost | Layout control |
|---|---|---|---|---|---|---|---|
| **Custom internal renderer** (chosen) | Native ANSI works in Win Terminal, PowerShell 5.1/7, conhost | We own the readline/raw-mode boundary | `process.stdout.on("resize")` + pure recompose | Append-only line renderer + bounded-FPS frame renderer | Pure reducer/view are trivially snapshot-testable; `TermIO` is fakeable | Zero new deps | Total |
| Ink (React) | Works but heavy; reconciler quirks under conhost | Good | Good | Re-render churn on fast token streams; flicker risk | Needs `ink-testing-library`; React testing surface | React + reconciler + many transitive deps | Constrained by React model |
| Blessed / Neo-Blessed | Historically flaky on Windows; unmaintained | Custom | Custom | Widget repaint heavy | Hard to unit test | Large, stale dep | Widget-centric |
| Keep ad-hoc `Output` prints | Fine | n/a | None | Corrupts on concurrent activity | Per-line only, not holistic | Zero | None |

## Decision

Build a **small internal renderer** on top of the existing `Output` ANSI layer.
No React/Ink, no Blessed. Rationale, weighted for our constraints:

- **Windows-first reliability.** The acceptance matrix requires PowerShell 5.1,
  PowerShell 7, Windows Terminal, plain conhost, and Linux. Raw ANSI through
  `Output` already works across all of these; Ink/Blessed add a reconciler or a
  widget tree whose Windows behavior we would have to babysit.
- **Streaming performance.** Agent token streams are high-frequency. An
  append-only line renderer (non-interactive) writes deltas directly; the
  interactive renderer coalesces repaints to a bounded frame rate instead of
  re-rendering a component tree per token.
- **Testing.** The reducer and views are pure functions, so the *entire* screen
  is snapshot-testable with a no-color `Output` and no terminal. The interactive
  runtime takes an injectable `TermIO`, so lifecycle (alt-screen, cursor,
  resize, cleanup) is testable against a fake stream with zero real TTY.
- **Dependency cost & control.** Zero new runtime dependencies, and we keep
  total control of layout, glyph degradation (Unicode↔ASCII), and color modes.

We deliberately do **not** mix terminal UI frameworks. One renderer interface,
two implementations.

## Architecture

`apps/cli/src/terminal/`:

- **`events.ts`** — `TerminalEvent`, the normalized discriminated union every
  producer emits (`session.started`, `user.message`, `assistant.delta`,
  `activity`, `tool.start`/`tool.end`, `patch.*`, `approval.auto`, `notice`,
  `task.*`). Producers never format; they describe.
- **`state.ts`** — `TerminalState` + `reduce(state, event, now)`. Pure, bounded
  (history/activity caps), no I/O. The single source of truth for the screen.
- **`view.ts`** — pure `state → string[]` renderers (header, tool cards,
  activity, patch, completion, full interactive frame). Snapshot-testable.
- **`renderer.ts` / `line-renderer.ts`** — the `Renderer` interface and
  `LineRenderer`, the non-interactive, append-only renderer used for redirected
  output, CI, JSON mode, unsupported terminals, and accessibility. It owns the
  stdout answer stream and the stderr activity stream.
- **`runtime.ts`** — `InteractiveRenderer`: a bounded-FPS frame renderer over an
  injectable `TermIO` with alternate-screen entry/exit, cursor ownership,
  resize-driven recompose, and deterministic cleanup on stop / signal / crash.
- **`task-event-adapter.ts`** — maps orchestrator SSE `TaskEvent`s into
  `TerminalEvent`s, so the agent runtime and the terminal stay decoupled.

`capabilities.ts` decides interactive vs. line rendering from TTY, `--json`,
`NO_COLOR`/`MORROW_ASCII`, dumb terminals, and an explicit `MORROW_TUI` opt-in.

## Consequences

- Visible output has exactly one owner per mode; features emit events.
- The screen is testable as a whole (golden/snapshot), not line-by-line.
- Interactive richness (full-screen overlays, command palette, job board) layers
  onto the same state/view without touching producers.
- Migration is incremental: the streaming path adopts the adapter + line
  renderer first; the interactive runtime is opt-in (`MORROW_TUI=1`) until it is
  at parity, so the working REPL is never destabilized.
- We own flicker/resize/cleanup correctness rather than delegating to a
  framework — more code, but no Windows surprises.
