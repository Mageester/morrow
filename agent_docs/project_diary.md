# Project Diary

## Durable decisions

### 2026-08-09 - Real-provider acceptance must exercise production boundaries

The flagship harness calls `executeAgentChatTask` directly so provider-agent behavior is shared with live Build/Build Auto execution. Scenarios may omit only the `TaskRunner` wrapper; they must not substitute fake command, process, browser, or mission-verification boundaries when those are the subject of the acceptance claim.

### 2026-08-09 - Flagship scoring is scenario-aware

Each supported flagship scenario is scored independently under the same policy. Unknown scenario IDs remain excluded and must never silently influence a supported scenario's streak. This prevents a newly added scenario from running successfully while remaining invisible to the gate.

### 2026-08-09 - Verification belongs to the harness

Acceptance checkers are trusted harness code outside the model-visible workspace and prompt. The model may create application tests, but those tests cannot be the authority that decides whether the flagship scenario passed.

### 2026-08-09 - Real flagship runs remain explicit and serialized

Default tests are deterministic and non-live. Real-provider streaks are deferred to a dedicated Medium-route session and run one at a time because flagship executions share ports, SQLite state, and temporary workspaces.

### 2026-08-09 - Explicit process cleanup is part of task completion

When a user explicitly requires a task-owned background process to be stopped before completion, the completion contract must treat any still-running process as a blocker. The fast path must not request a tool-free final summary while that blocker exists, because doing so forbids the required `stop_process` action. The rule is scoped to task-owned processes and explicit cleanup language so requests that intentionally leave a service running remain valid.

### 2026-08-09 - Lifecycle fixtures must specify event ordering

Mentioning stdin is not enough to exercise the supervisor's closed-stdin behavior. The flagship web contract must state and behaviorally verify the ordering: no listen URL before EOF, a listen URL after EOF, and continued service until explicit termination. Treating EOF as shutdown is a different valid design, but it does not test the boundary this scenario owns.

### 2026-08-09 - Compacted writes are history, not executable calls

Completed `create_file` and `propose_patch` arguments may be compacted after their effects are durable, but the compacted `_morrowAppliedWrite` representation must never remain in an assistant tool-call slot. `buildProviderProjection`, the shared reconstruction boundary used by agent execution and the server endpoint, converts those markers and their observations into a non-executable historical record. Failed writes retain their original arguments so the provider can repair them.

## Reliability lessons

- A passing deterministic suite does not prove a boundary has survived a real provider and real process lifecycle.
- Fix an entire defect class at its owning boundary, then enumerate every implementation before making a completion claim.
- Avoid duplicated status facts when an append-only or changelog record already exists; link to the durable source.
- Do not gain green tests by relaxing assertions, extending sleeps, raising timeouts, or skipping coverage.
- A completion directive that says no more tools are needed is itself a boundary decision; it must account for unresolved resource-lifecycle obligations, not only artifact and verification evidence.
- Context compaction must preserve the distinction between historical effects and executable model output; a schema-shaped placeholder in a tool-call position is still an instruction by example.
