# Evidence

Committed, append-only records of what Morrow actually did — not what its test
suite says it should do.

## `flagship-runs.jsonl`

One JSON object per run of the flagship workflow (`build a small working app
from a prompt`) against a real provider. Produced by
`services/orchestrator/test/live/flagship-build.test.ts`, scored by
`src/acceptance/flagship-gate.ts`.

Append only. Never edit or remove a line: a failure that can be deleted is not
evidence. A regression is recorded by adding runs, not by rewriting old ones.

Every run carries `passed` and, on a failure, a classified `failureReason` —
`artifact_missing`, `artifact_does_not_run`, `contract_violated`,
`task_not_completed`, or `harness_error`. `task_not_completed` is the
interesting one: it means the app was verified working but the task did not
close, which is a finish-criteria problem rather than a build failure.

Runs with `"mode": "mock"` are harness self-checks and are excluded from the
gate by construction.

### The gate

The flagship workflow is proven when **two different real providers each pass
at least 9 of their most recent 10 runs**. Until then the correct statement is
that it is unproven, and the gate says so.

To add runs:

```
MORROW_LIVE_FLAGSHIP=1 pnpm flagship:canary
```

That resolves each configured provider's model — its configured default, or
live discovery for gateway routes whose available ids vary by account — runs
the canaries, appends every outcome here before asserting anything, and prints
where the gate stands. On a failure it also prints the classification, task
status, tool-call count, tokens, and wall clock, which are the inputs a
root-cause diagnosis needs.

```
MORROW_FLAGSHIP_RUNS=10 MORROW_FLAGSHIP_PROVIDERS=deepseek,opencode-zen \
  MORROW_LIVE_FLAGSHIP=1 pnpm flagship:canary
```

`MORROW_LIVE_FLAGSHIP=1` is required every time: having credentials configured
is not consent to spend them. The equivalent vitest invocation still works:

```
MORROW_LIVE_FLAGSHIP=1 MORROW_FLAGSHIP_RUNS=10 pnpm --filter @morrow/orchestrator exec vitest run test/live/flagship-build.test.ts
```

Credentials are read from the ambient environment through the ordinary provider
registry. No key is ever read from, or written to, this directory.
