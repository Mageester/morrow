# Morrow — Known Issues

Current, evidence-backed product defects only. Historical beta findings move to
`ENGINEERING_LOG.md` when resolved; Git history retains their original reports,
reproductions, hypotheses, and external-source notes.

## Current status

### Shutdown does not drain in-flight agent work (2026-08-29, 0.8.0)

`MorrowRuntimeHost.close()` stops the scheduler, closes the HTTP server, drains
supervised processes, stops the entitlement poller, and closes the database. It
does not wait for a task already executing inside `TaskRunner`, because neither
the runner nor the mission controller runner exposes a drain. A SIGINT during an
agent turn can therefore close the database under that turn, and the in-flight
provider call ends with a "database connection is not open" error rather than a
clean stop.

The practical impact is bounded: both entrypoints call `process.exit(0)`
immediately after `close()`, so the task was ending either way, and durable
state is committed per event rather than at the end of a turn — a restart
reconciles the task as `interrupted` and it resumes correctly. What is missing
is the clean stop, not the durability.

Fixing it properly means giving `TaskRunner` and `MissionControllerRunner` a
bounded drain and adding them to the shutdown list. That is a change to the
execution core and was deliberately not bundled into the runtime-host
refactor, which was already broad.

No P1 or P2 issue from the beta.29 acceptance report remains open as of
2026-08-23. This does not mean Morrow is defect-free; it means each item in that
specific 17-finding report was reconciled against the current implementation and
tests rather than carried forward from stale evidence.

## Beta.29 reconciliation

| # | Prior finding | Status on 2026-08-23 | Current evidence |
|---|---|---|---|
| 1 | Read-only success recorded as interrupted | Resolved | `agent-security.test.ts` and `journey-g-output-report.test.ts` keep denied/non-permitted read-only actions distinct from task completion. |
| 2 | Contradictory Plan and YOLO indicators | Resolved | The terminal permission chip derives one effective mode and `permission-precedence.test.ts` covers the root-command boundary. |
| 3 | `morrow fix` inherited persisted YOLO | Resolved in this audit | Root `ask`/`fix`/`plan`/`yolo` commands now pass complete permission intent; explicit `yolo: false` outranks the saved default. |
| 4 | Generic or duplicate recovery messaging | Resolved | Structured recovery projections and `terminal-output-report.test.ts` show the failure, strategy, outcome, and occurrence count without raw duplicate JSON. |
| 5 | Hard requirements were not enforced | Resolved | `execution/requirements.ts` rejects conflicting actions before dispatch and gates completion; `agent-requirement-conformance.test.ts` covers the registry. |
| 6 | No decision visibility | Resolved in this audit | Non-obvious agent choices can be persisted with `record_decision`; `/decisions` renders the local Cortex ledger. `agent-decision-ledger.test.ts` proves concise, task-attributed, retry-idempotent storage. |
| 7 | Adaptive budget looked like an interruption | Resolved | Ordinary adaptive boundaries roll into a new durable segment automatically; explicit budget exhaustion is represented separately as `budget-reached`. |
| 8 | DeepSeek reasoning state could not resume | Resolved | Provider continuation persists/replays `reasoningContent`; reasoning pipeline and agent-loop tests cover multi-round tool continuation. |
| 9 | Resume warning was conflated and self-referential | Resolved | `terminal-resume.test.ts` asserts separately labelled resume facts and no instruction to rerun `/resume`. |
| 10 | Terminal startup/redraw left shell content and blank space | Resolved in this audit | Ink now enters an alternate screen on launch, restores the invoking screen on exit, and preserves `/clear`; terminal shell tests cover both lifecycles. |
| 11 | `/output full` was corrupt, duplicated, and bloated | Resolved | Canonical turns, replay-safe event folding, bounded artifacts, and the Journey G/output-report suites prevent duplicate finals and unsafe/raw output. |
| 12 | Duplicate create/change activity | Resolved | Durable event projection uses stable event identity and replay-safe aggregation; output-report tests assert occurrence folding. |
| 13 | Plan/report grade and durations were inaccurate | Resolved | Reports derive state from durable task/tool evidence and timestamps; duration rounding and replay stability are covered by `terminal-output-report.test.ts`. |
| 14 | Top-level help hid session commands | Resolved | Help and the interactive palette share the command registry; `terminal-command-registry.test.ts` covers discoverability. |
| 15 | DeepSeek V4 context limit was stale | Resolved | Canonical V4 metadata supplies a 1,000,000-token window before preflight; context-capability/effective-context tests cover aliases and overrides. |
| 16 | Deprecated DeepSeek aliases were exposed without migration semantics | Resolved | Compatibility aliases are explicitly `deprecated`, map to V4 Flash capabilities, preserve reasoner semantics, and are labelled in selectors. They remain intentionally readable for old config. |
| 17 | Selected/canonical/effective model display diverged | Resolved | Routing, budgets, fallback, and capability-source projections keep selected and canonical IDs distinct; model identity and terminal status tests cover the surfaces. |

## Empirical audit notes

- Full Chromium web E2E passed: 81/81 primary tests and 11/11 applicable
  composer tests. Seven composer cases are intentionally partitioned by desktop
  versus mobile Playwright project.
- Conditional browser tests passed after installing the optional local Chromium
  runtime: 3 files, 22 tests. Their former skip was an environment dependency,
  not a hidden product failure.
- Five command-executor tests remain Windows-only by design; POSIX artifact tests
  remain platform/artifact-gated by design.
- The audit found and fixed two additional web defects: settings chapter overflow
  at 390px and serious dark-theme contrast failures. The route sweep and axe
  accessibility suite cover both.
- One production-controller test exceeded Vitest's generic five-second timeout
  only under full-suite CPU contention; the focused run completed in 671ms. Its
  explicit integration-test ceiling is now 15 seconds. Product retry behavior was
  not changed.

When a new reproducible defect is found, add only the current evidence, impact,
severity, and acceptance criteria here. Keep unverified causal theories labelled
as hypotheses.
