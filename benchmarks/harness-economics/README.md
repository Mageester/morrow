# Harness economics benchmark

This is a standalone, personal-testing artifact. It is intentionally not part
of Morrow's runtime or product UI. Feed it one record per completed benchmark
task and it produces a dark three-panel SVG in the style of the supplied
reference image:

- pass rate
- median cost per task
- median time per task

The renderer never invents missing costs. It uses provider-metered
`measuredCostUsd` when present, otherwise estimates from the token counts and
the explicit `pricing` object on that record. Missing usage or pricing is shown
as `n/a` and reported as `unavailable` in the JSON summary.

## Input

Create a JSON file with either a records array or an object containing
`records`. The optional `title` becomes the chart title.

```json
{
  "title": "DeepSeek V4 Flash · harness comparison",
  "records": [
    {
      "harness": "Morrow",
      "model": "deepseek-v4-flash",
      "taskId": "task-001",
      "passed": true,
      "durationMs": 132000,
      "inputTokens": 42000,
      "cachedInputTokens": 18000,
      "outputTokens": 3200,
      "pricing": {
        "inputUsdPerMillion": 0.14,
        "cachedInputUsdPerMillion": 0.0028,
        "outputUsdPerMillion": 0.28
      }
    },
    {
      "harness": "Another harness",
      "passed": false,
      "durationMs": 187000,
      "measuredCostUsd": 0.018
    }
  ]
}
```

`cachedInputTokens` must be a subset of `inputTokens`. If a provider reports a
metered task cost, use `measuredCostUsd` and leave the token estimate optional.
Keep all rows from the same task set and record the same pass/fail definition
for every harness; otherwise the comparison is not meaningful.

## Run

```bash
pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-economics/run.ts records.json --out report.svg
pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-economics/run.ts records.json --json
```

The DeepSeek price constants exported from `metrics.ts` are convenience values
for tests and local scripts. Re-check the provider price sheet before a new
comparison: [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/).
