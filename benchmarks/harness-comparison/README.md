# Harness comparison

A comparative benchmark: **on the same task set and the same model, how does
Morrow compare to a baseline agent harness on success rate, cost, wall time,
and turns?**

This is deliberately not the same thing as `benchmarks/morrow-evals/`. That
suite is deterministic — a scripted implementer, no model in the loop — and it
measures whether Morrow's missions tell the truth about work that already
happened. It is a good honesty check and it says nothing about whether Morrow
is a good agent. This suite puts a real model in the loop and compares Morrow
against another harness driving the identical model.

## What is held constant

| Held constant | How |
| --- | --- |
| Model | `deepseek-v4-flash`, same provider account, both harnesses. |
| Task set | The same 20 tasks (`tasks.ts`), same order. |
| Prompt | Byte-identical, passed verbatim to both harnesses. |
| Fixture | A fresh copy per harness per task, written from the same source. |
| Wall-clock ceiling | The same per-task timeout for both (default 8 minutes). |
| Grading | The same hidden check, run the same way, after the agent stops. |
| Repo-level coaching | Neither side gets `AGENTS.md`/`CLAUDE.md` (`-nc` for pi; Morrow is pointed at a bare fixture with none). |
| Cost accounting | One price sheet applied to both harnesses' own token counts. |

## What cannot be held constant

Stated here rather than buried, because these are the reasons to read the
result as a comparison of *harnesses as they ship* rather than a controlled
experiment isolating one variable:

- **System prompts and tool sets differ.** That is the thing being compared.
  Morrow ships missions, requirements, completion contracts and a larger tool
  surface; pi ships seven tools and a short prompt. Equalizing them would
  measure neither product.
- **Turn accounting is each harness's own.** Morrow counts one turn per
  provider stream attempt; pi counts one per assistant message. They agree on
  clean runs and can differ by a retry.
- **One sample per task per harness** at the default settings. A single
  stochastic run per cell is enough for an aggregate over 20 tasks and is not
  enough to rank two harnesses on any individual task. Use `--repeats` for
  per-task claims.

## The tasks

20 tasks: 12 defect fixes and 8 small builds, all dependency-free Node ESM.
Each has a fixture, one prompt, and a hidden ground-truth check.

Two properties make the grading meaningful:

- **The check is never in the workspace.** After the agent stops, the workspace
  is copied elsewhere and the check is written into the copy. No agent can
  read, edit, satisfy by name, or delete the thing that grades it.
- **The visible symptom is narrower than the check.** Defect fixtures state
  their full intended behaviour in a `SPEC.md` and show one wrong case.
  Special-casing that one case does not pass; implementing the spec does.

`validate.ts` enforces that the set stays honest: every check must **fail** on
the untouched fixture (or the task is free) and **pass** on a committed
reference solution (or the task is impossible and the check is measuring
itself). Run it before trusting any result:

```bash
pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-comparison/validate.ts
```

## Running

```bash
# credentials: DEEPSEEK_API_KEY, and PI_BINARY pointing at the pi executable
pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-comparison/run.ts \
  --harnesses morrow,pi

pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-comparison/report.ts \
  --input benchmarks/harness-comparison/results
```

Flags: `--tasks a,b` to select, `--repeats n` for repeated sampling,
`--timeout ms` for the shared ceiling, `--model`, `--out`.

Runs stream to JSONL as they land, so a run that dies halfway still leaves
usable evidence.

## Baselines

**pi** (`@earendil-works/pi-coding-agent`) is driven as a black box, one
non-interactive `pi -p --mode json` invocation per task, exactly as a user
would. It reports per-message token usage, which is what the comparison needs.

**Claude Code is not included, and the reason is not that it was hard to
drive.** The comparison's central control is that both harnesses run the same
model. Claude Code does not run `deepseek-v4-flash`. Driving it on a Claude
model would confound "which harness" with "which model" — and since the model
is the larger effect by far, the resulting table would be a model benchmark
wearing a harness benchmark's label. A second baseline is worth adding when it
can be pointed at the same model; a rigged two-harness result is worth less
than an honest one-baseline result.

## Cost

Both harnesses compute dollar costs from a bundled price catalogue rather than
from a provider-metered invoice. The report therefore recomputes cost for both
from one sheet (`DEEPSEEK_V4_FLASH_PRICING` in `../harness-economics/metrics.ts`)
applied to each harness's own token counts, and prints each harness's
self-reported total alongside as a cross-check. A few percent of disagreement
between two price tables must not be able to read as a harness difference.
