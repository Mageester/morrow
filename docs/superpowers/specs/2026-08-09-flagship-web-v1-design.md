# Flagship Web v1 Design

## Goal

Add `flagship-web-v1` as a second real-provider scenario in the existing flagship harness. It must build a small multi-file frontend, execute a hidden harness-owned test, start the generated development server through the real mission-verification service boundary, and render the served page through the real Playwright boundary. `flagship-build-v1` remains intact.

## Gate design

`evaluateFlagshipGate` will score exactly one supported scenario per call. Add a scenario identifier to its options, defaulting to `flagship-build-v1` for source compatibility. Runs for other scenario IDs remain counted under `excluded.otherScenarios`.

The gate CLI will iterate the supported scenario registry and print an independent result for every scenario. In reporting mode, an unproven scenario is visible but does not change the command's zero exit status. With `--require`, every supported scenario must pass. This avoids combining unlike workloads into one streak and prevents a new scenario from silently landing in `excluded.otherScenarios`.

The live runner will accept one explicit scenario selection and run only that scenario in a process. Its default remains `flagship-build-v1`. This supports the next session's requirement to run provider streaks one at a time.

## Scenario design

The new prompt asks for a dependency-light multi-file frontend with a package start command and a small interactive behavior. It states the public behavioral contract but never discloses checker source, selectors, expected implementation, or verification commands.

After `executeAgentChatTask` returns, the harness—not the model—creates any checker assets under the run's private verification directory. The model workspace cannot write or inspect that directory through its scoped tools.

The verifier performs these independent checks:

1. Confirm required project artifacts exist and compute a stable artifact digest from their contents.
2. Execute a harness-owned test file through `runVerification` with a `test` strategy and the real default command executor. The generated project’s own tests are not acceptance authority.
3. Execute `runVerification` with a `browser` strategy, the generated start command, an explicit loopback URL, and a real `playwrightController`. This uses the real default service launcher, readiness probe, desktop/mobile rendering, console-error capture, and cleanup.
4. If a Git/diff verification strategy is included, initialize and baseline the isolated generated workspace inside the harness before the agent runs so the real default changed-file boundary has meaningful input. Do not add a decorative diff check that cannot fail on an implementation defect.

Any failed or inconclusive required check produces a model-scored contract failure unless the existing zero-output/provider-environment rule classifies the run as `harness_error`. A correct artifact with a non-completed task remains `task_not_completed`.

## Code boundaries

- `flagship-gate.ts` owns supported-scenario filtering and per-scenario scoring.
- `flagship-build.ts` retains the existing scenario and exposes only the minimal shared run lifecycle needed by the web scenario.
- `flagship-web.ts` owns the web prompt, hidden checker creation, web verification, and the `runFlagshipWeb` wrapper.
- `evidence-runner.ts`, `command-executor.ts`, and browser/process implementations are consumed as production boundaries. Do not duplicate their process or shell logic in acceptance code.
- `test/live/flagship-build.test.ts` remains explicitly opt-in and selects one scenario per invocation.

## Testing

Implementation follows red-green-refactor:

- First add a gate test proving `flagship-web-v1` runs qualify only its own gate and are no longer silently excluded. Observe it fail against the hardcoded filter.
- Add web-verifier tests using a scripted provider that writes a known-good multi-file fixture. Observe failures before the new scenario exists.
- Add negative tests for a missing artifact, an agreeable model-written test paired with incorrect behavior, and a page that serves but renders blank or emits a browser error.
- Run focused tests, the complete orchestrator suite, orchestrator typecheck/build, repository checks where applicable, and `git diff --check`.

No test may call a real provider. Do not increase timeouts, add sleeps, weaken assertions, or skip failures.

## Security and privacy

The generated service is loopback-only. The browser boundary permits only `localhost` and `127.0.0.1`. No credential inspection, provider invocation, telemetry, or network dependency is added. Verification output remains bounded and contains no workspace content beyond existing evidence policy.

## Rollback

Remove the web scenario registry entry, `flagship-web.ts`, its deterministic tests, and the live-runner selector. The default `flagship-build-v1` gate API and scenario remain usable throughout, so rollback does not require evidence-log edits.

