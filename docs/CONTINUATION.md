# Continuation

> Always names the **exact** next step so any agent (or a fresh session) can
> resume without re-deriving context. Update this at every interruption.

## Resume command

```bash
cd "C:/Users/aidan/OneDrive/Documents/PlaceHolder"
git checkout feat/morrow-agent-terminal
pnpm install
pnpm check && pnpm test && pnpm build   # expect green
```

## Where we are

- Durable docs maintained (parity matrix, master goal, backlog, status, this).
- **B1 — Full-text search: DONE & VERIFIED.**
- **B2 — Memory provenance + pin + tiers: DONE & VERIFIED.** `pinned`,
  `originTaskId` (FK, migration 11), episodic/procedural/knowledge tiers,
  pin-first ordering, PATCH `{pinned}`, CLI `memory pin/unpin`.
- Baseline: orchestrator 173 tests, CLI 109, contracts 4, web 8 — all green.

## Exact next step — B3: Loop detection in the agent loop

Goal: detect when the agent repeats the same tool call (same tool + same args)
without progress, and stop with a clear reason instead of burning the budget.

1. New pure module `services/orchestrator/src/execution/loop-detector.ts`:
   - `createLoopDetector({ windowSize?: number; repeatThreshold?: number })`.
   - `record(signature: string): { looping: boolean; count: number }` where
     `signature = toolName + ":" + stableStringify(args)`.
   - Looping when the same signature occurs `repeatThreshold` times within the
     last `windowSize` calls (default window 6, threshold 3).
   - Export a `toolCallSignature(toolName, args)` helper using a stable key
     (sorted JSON) so arg order doesn't matter.
2. Wire into `services/orchestrator/src/execution/agent.ts`: where tool calls are
   dispatched (search for the tool-iteration loop / `maxToolIterations`), record
   each signature; on `looping`, emit a `task.recovery_required` (or fail with a
   descriptive state) — mirror how the adaptive budget currently aborts
   (`adaptive-budget.ts`) so the transcript/UX stays consistent.
3. Tests first (red): `services/orchestrator/test/loop-detector.test.ts`
   - "flags repeated identical signatures past the threshold"
   - "treats arg-order-different-but-equal calls as the same signature"
   - "does not flag varied calls within the window"
   - "resets/forgets calls outside the window".
   Then an agent-level test (extend `test/agent-*`) proving a provider that keeps
   requesting the same tool is stopped with the loop reason and does NOT mark a
   false success.
4. `pnpm check && pnpm test && pnpm build`. Update matrix §3 "Loop detection"
   row → VERIFIED with evidence. Commit `feat(agent): loop detection` + push.

## Failing test to write first

`test/loop-detector.test.ts` — "flags three identical tool-call signatures within
a 6-call window as looping".

## Open risks / notes

- Read `execution/agent.ts` around the tool dispatch loop before wiring; match
  the existing abort/event pattern (look at how `adaptive-budget` surfaces
  `budget-reached`). The terminal already renders a `stalled` app-view case
  (`app-view.ts`) — reuse that signal type if it fits so the TUI shows it.
- Keep the detector pure and deterministic (no time-based logic) for testability.
- Do not lower `maxToolIterations`; loop detection is an *earlier*, smarter stop.
