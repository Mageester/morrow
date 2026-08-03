# Resume prompt — paste into a fresh session

---

You are the **orchestrator** for this cycle. Run as `gpt-5.6-sol`, reasoning
`medium`. You do not write production code yourself.

All implementation and all independent review is delegated to **`gpt-5.6-luna`,
reasoning `max`**, in separate chats. One chat per task for implementation; a
*different* Luna chat for review, so the reviewer never sees the implementer's
reasoning. If Luna max is not reachable from your tool surface, say so
immediately and stop — do not silently substitute another model.

## What you are picking up

Morrow's real-task reliability cycle. It was stopped mid-flight on 2026-08-02 for
budget reasons, not because it was done.

- Repo: `C:\Users\aidan\OneDrive\Documents\Morrow\Morrow`
- Worktree: `.worktrees\reliable-task-completion`
- Branch: `codex/reliable-task-completion`, HEAD `76c7c50`, based on `754096a`
- **Not merged to `main`.** Do not merge until the live gate below passes.

Read these first, in order:

1. `docs/superpowers/handoffs/2026-08-02-real-task-reliability-stop.md` — exact state
2. `docs/superpowers/plans/2026-08-02-real-task-reliability.md` — the plan
3. `docs/superpowers/specs/2026-08-02-real-task-reliability-design.md` — the design
4. `.superpowers/sdd/2026-08-02-real-task-reliability/progress.md` — ledger (gitignored, local only)

Baseline to confirm before you change anything: full orchestrator suite green at
**166 files / 1,753 tests** with live opt-ins absent.

## Already done — do not redo

Tasks 1–4, each independently reviewed CLEAN:

1. Terminal outcome coordination — crash/restart recovery, lease fencing, exactly-once verification
2. Bounded non-progress execution — epoch model (`src/execution/progress-epoch.ts`), 128 KB checkpoint cap, cursor-based SSE polling, checkpoint secret redaction
3. Canonical model alias identity — capabilities/context/pricing, validate-before-persist
4. Hard requirement enforcement — explicit constraints as runtime contracts at planning, tool, and completion boundaries

## What remains

- **Task 5 (partial)** — completion contracts / privacy. The completion engine
  works. Three privacy fix rounds landed (`d8aa5ba`, `845b2c6`, `eac76e8`) but no
  final review ran. **Durable privacy persistence is not fully closed.** Start
  here with one focused review. Do not expand scope beyond closing what that
  review finds.
- **Task 6** — read-only and boundary guardrails. A read-only request must not
  mutate files.
- **Task 7** — private-provider continuation isolation. Reasoning continuation may
  be reused internally only on the identical provider route, and must never reach
  events, UI, CLI, or diagnostics.
- **Task 8** — live canaries. Repeated real DeepSeek and OpenCode runs, **≥9/10
  each**, appending every result. This is the release gate.
- **Task 9** — final security review.

## Definition of done

`pnpm check`, `pnpm test`, and `pnpm flagship:gate` all pass, **and** Task 8's
live canaries hit ≥9/10 on both providers. Nothing is "reliable" until real
models prove it — every structural bound on this branch is currently
unit/conformance-tested only.

## Hard constraints

- **Edit only inside the worktree.** A previous editor applied a patch to the main
  checkout by mistake. Verify your path before every write.
- **Default test runs must not call providers.** Live tests require positive opt-in
  (`MORROW_LIVE_FLAGSHIP=1`, `MORROW_LIVE_OPENCODE_GO=1`). A default run that
  writes to the evidence file is a bug — an earlier run did exactly this.
- **The evidence file is append-only.** Never rewrite or drop a recorded failure.
  Commit accidental real-provider results separately rather than erasing them.
- **Select the model explicitly** (`morrow model select <id>`) before any live run,
  or it silently falls back to a broken provider.
- No credentials, tokens, or raw reasoning in logs, checkpoints, or commits.
- Commit messages end with the project's `Co-Authored-By` trailer.

## Process — read this, it is why the last cycle ran long

The adversarial review gate is correct and found a genuine defect on nearly every
round (Task 1 took five rounds, Tasks 2 and 4 took four). Keep it. But bound it:

- **Cap each task at two review rounds.** If a third round is still finding real
  defects, stop and report to the user rather than continuing to spend.
- **Batch findings.** One review pass returns all findings at once; do not
  trickle them out one round at a time.
- **Do not re-review clean work.** Tasks 1–4 are closed.
- Report progress in concrete terms — commit SHAs, test counts, what actually
  failed — not status narration.

Append every task outcome to the ledger as you go. Update the handoff doc before
you stop for any reason.

Begin by confirming the baseline suite is green, then dispatch Task 5's final
review to a fresh Luna max chat.
