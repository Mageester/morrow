# Security Review: Morrow

## Scope

Diff scan of Morrow beta.26 consumer-flow hardening changes touching CLI onboarding, project identity, approval rendering, terminal state, shared task-event contracts, and orchestrator tool recovery/progress behavior.

- Scan mode: working_tree
- Target kind: git_diff
- Target ID: target_sha256_d9b94860d07472ccc8afca5e5128306b8ba6affd1fc89ee1073338f9f52c7314
- Revision range: db1071b04271110d066d24539bbc64d743106100...db1071b04271110d066d24539bbc64d743106100
- Snapshot digest: codex-security-snapshot/v1:sha256:5d9205ae5381e43b092af5c42a1fd34eb534aaa1960d60b0de55a8846fbc7bcd
- Inventory strategy: diff
- Included paths: apps/cli/src/cli/gitinfo.ts, apps/cli/src/commands/common.ts, apps/cli/src/commands/onboard.ts, apps/cli/src/commands/stream.ts, apps/cli/src/config/config.ts, apps/cli/src/terminal/session.ts, apps/cli/src/terminal/state.ts, apps/cli/src/terminal/task-event-adapter.ts, packages/contracts/src/index.ts, services/orchestrator/src/execution/adaptive-budget.ts, services/orchestrator/src/execution/agent.ts, apps/cli/src/terminal/approval-view-model.ts
- Excluded paths: none
- Runtime or test status: pnpm check, pnpm test, pnpm build, and git diff --check passed before security scan continuation.
- Artifacts reviewed: artifacts/01_context/threat_model.md, artifacts/02_discovery/deep_review_input.jsonl, artifacts/02_discovery/work_ledger.jsonl, artifacts/02_discovery/finding_discovery_report.md
- Scan context: Preflight status was ready. The scan reviewed 12 runtime/source rows from the working-tree snapshot, including the untracked approval view-model source file added as a supporting diff row.

Limitations and exclusions:
- Test-only files and the planning document were excluded from runtime security discovery but are listed in coverage exclusions.
- Excluded \*\*/test/\*\*: Test changes verify the runtime hardening but are not deployed runtime attack surfaces for this diff scan.
- Excluded docs/superpowers/plans/\*\*: Planning artifact only; no runtime code or execution boundary.

### Scan Summary

| Field | Value |
| --- | --- |
| Reportable findings | 0 |
| Severity mix | none |
| Confidence mix | none |
| Coverage | complete |
| Validation mode | Discovery-only diff scan; validation and attack-path phases were skipped because no plausible candidates survived discovery. |

Canonical artifacts: `scan-manifest.json`, `findings.json`, and `coverage.json`. This report is a deterministic projection of those files.

## Threat Model

Morrow is a local-first personal AI agent whose sensitive boundaries are local project files, provider credentials, memory, approvals, tool execution, model context, schedules, plugins, browser/process control, and release artifacts.

### Assets

- local files and repositories
- provider credentials and secret handles
- conversation and memory records
- approval decisions and command trust patterns
- task evidence and execution audit history
- release artifacts and installer metadata

### Trust Boundaries

- CLI/browser clients to orchestrator API
- untrusted model output to local tool runtime
- registered project roots and worktrees to host filesystem
- local context manager to external model providers
- plugin/skill/MCP capability declarations to execution authority

### Attacker Capabilities

- malicious prompt, repository content, file name, terminal output, browser page, model tool argument, generated patch, imported Hermes data, or local web request
- operator misconfiguration or overbroad trust pattern
- malformed SSE/task-event or approval details

### Security Objectives

- models cannot grant themselves permissions
- filesystem and terminal tools stay inside explicit project/workspace boundaries
- secrets are never exposed in prompts/logs/reports
- external provider disclosure is explicit
- task status and approval UI remain crash-resistant and honest

### Assumptions

- The scan is diff-scoped to the selected working-tree snapshot
- Morrow remains local-first beta software and not a hosted multi-tenant control plane
- No reportable finding is emitted without candidate ledger receipts; no candidates survived discovery in this scan

## Findings

### No findings

No reportable findings survived the canonical discovery, validation, and reportability gates.

## Reviewed Surfaces

| Surface | Risk Area | Outcome | Notes |
| --- | --- | --- | --- |
| apps/cli/src/cli/gitinfo.ts | Git status display scoping | No issue found | Full file reviewed. Change uses no-shell git status with a top-anchored pathspec for child workspaces; display-only dirty count does not alter project authority or command execution. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| apps/cli/src/commands/common.ts | Project resolution and multiline input | No issue found | Full file reviewed. Configured child project is selected only when it is contained by the launch cwd and passes existing safe-project checks; multiline input preserves user text and does not feed shell or path sinks. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| apps/cli/src/commands/onboard.ts | Onboarding default project and YOLO persistence | No issue found | Full file reviewed. YOLO persistence stores an explicit boolean default and initial chat passes the exact registered project id; this narrows workspace selection rather than expanding authority. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| apps/cli/src/commands/stream.ts | Approval rendering and resolution | No issue found | Full file reviewed. Approval details now flow through safe view-model coercion, and trustPattern is omitted unless the trust decision is selected, preserving existing server-side approval validation. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| apps/cli/src/config/config.ts | Configuration parsing | No issue found | Full file reviewed. New defaults.autoApprove key is parsed as a boolean through the same strict config coercion used for other booleans; no secret or external data flow is introduced. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| apps/cli/src/terminal/session.ts | Interactive terminal approval display | No issue found | Full file reviewed. Approval display now uses the same coerced view model as stream mode, preventing crashes on malformed arrays without changing approval authority or auto-approval behavior. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| apps/cli/src/terminal/state.ts | Terminal task outcome state | No issue found | Full file reviewed. Terminal task terminal events are ignored after an already-terminal status, preventing contradictory display state; this is a presentation guard and does not hide persisted orchestrator events. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| apps/cli/src/terminal/task-event-adapter.ts | Task event mapping | No issue found | Full file reviewed. New progress_warning maps to a warning notice only; it does not mutate permissions, approvals, task status, or tool authority. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| packages/contracts/src/index.ts | Shared task-event contract | No issue found | Full file reviewed. The contract only adds task.progress_warning to the typed event enum; payload remains an unknown record and no trust boundary is relaxed. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| services/orchestrator/src/execution/adaptive-budget.ts | Progress accounting | No issue found | Full file reviewed. Result-aware progress hashes bounded observations with SHA-256; it does not expose raw observations beyond existing tool-result context or change permission enforcement. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| services/orchestrator/src/execution/agent.ts | Tool argument context capping and patch recovery | No issue found | Full file reviewed. Raw tool arguments and outputs remain persisted; only model-facing oversized create_file/propose_patch arguments are replaced with compact placeholders after execution. Malformed patch recovery still reads current file content through assertContainedRealPath before feedback. Evidence: artifacts/02_discovery/work_ledger.jsonl |
| apps/cli/src/terminal/approval-view-model.ts | Approval detail coercion | No issue found | Full file reviewed. New view model accepts malformed approval details without throwing, defaults missing risk to medium, and returns display strings only; it does not approve, execute, or broaden trusted command patterns. Evidence: artifacts/02_discovery/work_ledger.jsonl |
