# Flagship Web v1 Design

## Goal

Add `flagship-web-v1` as a second real-provider scenario in the existing flagship harness. It must build a small multi-file frontend, execute a hidden harness-owned test, start the generated development server through the real mission-verification service boundary, and render the served page through the real Playwright boundary. `flagship-build-v1` remains intact.

## Gate design

`evaluateFlagshipGate` will score exactly one supported scenario per call. Its scenario identifier is required and must be registered; there is no compatibility default. Every call site must name the scenario it intends to score. Runs for other registered scenario IDs remain counted under `excluded.otherScenarios` for transparent accounting, but an unsupported requested ID throws.

The deterministic suite reads distinct `scenarioId` values from `docs/evidence/flagship-runs.jsonl` and asserts every one appears in the supported-scenario registry. This mirrors live provider eligibility: scenarios are declared, not implied. The gate CLI iterates the registry and prints an independent result for every scenario. In reporting mode, an unproven scenario is visible but does not change the command's zero exit status. With `--require`, every supported scenario must pass. This avoids combining unlike workloads and makes an unregistered evidence record fail loudly instead of disappearing into `excluded.otherScenarios`.

The live runner requires one explicit registered scenario selection and runs only that scenario in a process. It has no scenario default. This supports the next session's requirement to run provider streaks one at a time without silently selecting the older workload.

## Scenario design

The new prompt asks for a dependency-light multi-file frontend with a package start command and a small interactive behavior. Its required test script uses a watch-capable runner and contains a quoted path argument with a space. After implementation, the agent must start the development server through `run_command` with `background:true`, inspect it, and stop it. This reaches `ProcessSupervisor`; starting a child directly from acceptance code would not. The prompt states the public behavioral contract but never discloses checker source, selectors, expected implementation, or hidden assertions.

After `executeAgentChatTask` returns, the harness—not the model—creates any checker assets under the run's private verification directory. The model workspace cannot write or inspect that directory through its scoped tools.

The verifier performs these independent checks:

1. Confirm required project artifacts exist and compute a stable artifact digest from their contents.
2. Execute the generated watch-capable test script through `runVerification` with a `test` strategy. The command contains the required quoted argument. The harness leaves `exec` unset so `defaultExec -> runShellCommandSafe` supplies `CI=true`, closed stdin, Windows verbatim shell handling, timeout, and process-tree cleanup. Generated tests exercise the executor but are not acceptance authority.
3. Execute a harness-owned hidden assertion file through a second `test` strategy. The checker lives in `<root>/verify`, outside the model-visible workspace, and independently rejects incorrect behavior even if the generated tests report success. `exec` remains unset.
4. Execute `runVerification` with a `browser` strategy, the generated start command, an explicit loopback URL, and a real `playwrightController`. `startService` remains unset, so evidence-runner's production default owns readiness, stdin, Windows quoting, and cleanup. The only injected `RunOptions` field besides `workspacePath` is `browser`, exactly matching `mission/controller-runner.ts`.
5. Initialize an empty Git repository in the isolated workspace before the agent runs. Execute a `diff` strategy after the build with `gitChangedFiles` unset, require a non-empty changed-file result, and verify the observed paths are consistent with the scenario contract. This reaches the bounded real `spawnSync` implementation instead of an injected lister.

## Fixed-path coverage

| Fixed path | Scenario step that exercises it |
| --- | --- |
| Verification command could hang in watch mode | The generated test script uses a watch-capable runner without a forced run flag; `runVerification(test)` leaves `exec` unset, so `CI=true` and closed stdin must make it terminate. |
| Development server could stall on open stdin | During the agent task, `run_command background:true` starts the server through `ProcessSupervisor.start`; the harness asserts that tool path occurred. Hidden browser verification separately leaves `startService` unset and exercises evidence-runner's default service launcher. |
| Unbounded synchronous Git status could block the event loop | The hidden `diff` strategy runs in a harness-initialized Git workspace with `gitChangedFiles` unset and requires observable changed files. |
| Windows backslash-quote escaping could be mangled by `cmd.exe` | The required test command contains a quoted file argument with a space and runs through evidence-runner's unset `exec` default. The hidden checker command also uses quoted absolute paths. |

No coverage is claimed for an implementation unless the final boundary enumeration proves the scenario reaches it.

Any failed required check produces a model-scored contract failure unless it identifies a harness/environment fault. An `inconclusive` browser outcome, including unavailable Playwright, is `harness_error` and excluded from scoring; it is never blamed on the model. This decision has a deterministic test. A correct artifact with a non-completed task remains `task_not_completed`.

The shared execution layer preserves the existing load-bearing provider-failure classification verbatim and before artifact verification: only `task.status === "failed" && toolCalls === 0 && completionTokens === 0` becomes `harness_error`. A single output token or tool call means the run is judged on its output.

## Code boundaries

- `flagship-gate.ts` owns supported-scenario filtering and per-scenario scoring.
- `flagship-build.ts` retains the existing scenario. The minimal shared run lifecycle owns setup, execution, measurement, and the verbatim zero-output `harness_error` rule used by both scenarios.
- `flagship-web.ts` owns the web prompt, hidden checker creation, web verification, and the `runFlagshipWeb` wrapper.
- `evidence-runner.ts`, `command-executor.ts`, and browser/process implementations are consumed as production boundaries. Do not duplicate their process or shell logic in acceptance code.
- `test/live/flagship-build.test.ts` remains explicitly opt-in and selects one scenario per invocation.

## Testing

Implementation follows red-green-refactor:

- First add a gate test proving `flagship-web-v1` runs qualify only its own gate and are no longer silently excluded. Observe it fail against the hardcoded filter.
- Add web-verifier tests using a scripted provider that writes a known-good multi-file fixture and uses `run_command background:true`. Observe failures before the new scenario exists.
- Add negative tests for a missing artifact, an agreeable model-written test paired with incorrect behavior, a missing supervised-server tool path, and a page that serves but renders blank or emits a browser error.
- Add a browser-unavailable test proving an inconclusive browser outcome becomes `harness_error`.
- Preserve the zero-output classification with tests for zero output versus a single token or tool call.
- Run focused tests, the complete orchestrator suite, orchestrator typecheck/build, repository checks where applicable, and `git diff --check`.

No test may call a real provider. Do not increase timeouts, add sleeps, weaken assertions, or skip failures.

## Security and privacy

The generated service is loopback-only. The browser boundary permits only `localhost` and `127.0.0.1`. No credential inspection, provider invocation, telemetry, or network dependency is added. Verification output remains bounded and contains no workspace content beyond existing evidence policy.

## Rollback

Remove the web scenario registry entry, `flagship-web.ts`, its deterministic tests, and the live-runner selector. The default `flagship-build-v1` gate API and scenario remain usable throughout, so rollback does not require evidence-log edits.
