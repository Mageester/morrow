# Next-session handoff — prove it, then simplify it

Paste the block below into a fresh Claude Code session at the repo root.

---

You are picking up Morrow (`/home/dread/Code/morrow`), a self-hosted local-first
AI agent. Branch `perf/hot-path-pass` sits 3 commits ahead of `main` with a
completed performance pass; read `docs/performance-hot-paths.md` first — it
records the method and the measured baseline. Test suite is 2,258 tests in ~44s
via `npx vitest run --maxWorkers=4` in `services/orchestrator`. Keep it green.

The goal of this session: Morrow has serious infrastructure and no evidence that
the infrastructure earns its cost. Fix that, in this order. Each step gates the
next — do not skip ahead, and do not start step 3 before step 2 produces numbers.

## Ground rules

- Measure before you change anything, and re-measure after. This repo already
  burned itself on a stale number: `docs/harness-efficiency-report-2026-08-11.md`
  claims tool schemas are 12,297 of 12,945 input tokens. That is no longer true —
  it is ~3,242 tokens on a coding task today, because `ToolProfileSelector`
  (`agent.ts:1751`) now filters per task and `conservativeSchemaTokens` was
  recalibrated. Verify every claim you inherit, including the ones below.
- Existing harnesses to use, not rebuild: `services/orchestrator/benchmark/hot-paths.ts`,
  `benchmark/explain-hot-queries.ts`, `benchmarks/harness-economics/` (economics
  + SVG reports), `benchmarks/morrow-evals/` (3 scenarios, mission-honesty focus).
- Reference harness for design comparison: `github.com/badlogic/pi-mono`. Its
  entire agent loop is 796 lines. Clone it and read `packages/agent/src/agent-loop.ts`
  before step 3. Do not copy its parallel tool execution — Morrow's read tools are
  synchronous local `fs` calls, so overlapping them buys nothing, and the slow
  tools mutate state.
- Blocked: Playwright browsers are version-mismatched (cache has chromium-1234,
  pinned `playwright@1.61.0` wants 1228). Any browser work needs
  `cd services/orchestrator && npx playwright install chromium` first — ask before
  downloading.

## Step 1 — Build the comparative eval (this is the whole point)

`benchmarks/morrow-evals/` measures mission honesty on 3 scenarios. That is not
a comparative benchmark and nobody outside this repo can read it.

Build one that answers: **on the same task set and the same model, how does
Morrow compare to a baseline harness on success rate, cost, wall time, and
turns?** Minimum 20 tasks, drawn from real defect-fixing and small-build work,
each with a hidden ground-truth check the agent never sees. Reuse the fixture and
ground-truth pattern already in `benchmarks/morrow-evals/scenarios.ts`.

Baseline to compare against: pi (`pi-mono`), and Claude Code if you can drive it
headlessly. If a baseline cannot be driven fairly, say so explicitly in the
output rather than inventing a comparison — a one-harness result honestly
labelled is worth more than a rigged two-harness one.

Output a single committed report: the table, the method, the fixture list, and
every caveat. This is the artifact the project is missing.

## Step 2 — Read the eval and cut what does not earn its place

Morrow carries a lot of apparatus: missions, guardians, requirements, completion
contracts, checkpoint snapshots, evidence ledgers, cortex, tool-argument repair,
command dialect normalization, XML tool-call recovery. Some of it is the moat.
Some of it is cost with no measured benefit. Right now nobody knows which.

Use the step-1 harness to ablate. For each major subsystem, run the task set with
it disabled and report the delta in success rate, cost, and turns. Then bring me
a ranked list: what earns its cost, what does not, and what you propose to
delete. **Do not delete anything in this session** — bring the evidence and the
recommendation.

Pay particular attention to whether the compatibility machinery (argument repair,
dialect normalization, truncated-JSON handling) is carrying weak models that
nobody should be running anyway. That machinery is a large share of the harness's
complexity and it may be subsidising a model choice rather than a capability.

## Step 3 — Make the loop maintainable

`services/orchestrator/src/execution/agent.ts` is 6,699 lines. `executeAgentChatTask`
starts at line 807 and runs to the end of the file. The tool-execution loop at
line 5254 has a ~1,200-line body. Every provider quirk in this file was patched
inline, and the comments narrate individual model failures rather than describing
a model.

Extract, behaviour-preserving, one seam at a time, running the full suite between
each: the streaming/turn loop, tool dispatch, the recovery and rollover paths, and
context projection. Target modules under 800 lines. No behaviour change in this
step — if you find a bug while extracting, note it and leave it.

This is deliberately last: steps 1 and 2 tell you which code is worth keeping, and
refactoring before you know that just polishes what you are about to delete.

## Out of scope this session

Do not touch: licensing, macOS support, the landing site, or the web UI. They are
real gaps (see `docs/tasks/landing-redesign-prompt.md` for the site) and they are
not this session's work.

## Delivering

Work on a branch off `perf/hot-path-pass`. Commit in logical units with real
messages. Do not push. Report the eval numbers first and plainly — if Morrow
loses to the baseline, lead with that. A harness that measures itself honestly
and loses is fixable; one that flatters itself is not.
