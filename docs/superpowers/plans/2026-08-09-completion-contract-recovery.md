# Completion Contract Recovery Repair Plan

**Goal:** Prevent a repairable final-answer blocker from turning an otherwise successful task into an immediate terminal failure.

**Live evidence:** DeepSeek run `764be20f-a22d-4d83-9be8-6e96f4d481fd` built and verified the flagship web artifact, but started two task-owned servers. It stopped and rechecked one process while the earlier process remained running. Morrow correctly detected `background_process_running`, then immediately interrupted instead of allowing cleanup.

**Invariant:** Keep the completion contract strict. Never mark a task complete while required cleanup is unresolved, never stop a foreign process, and never grant unbounded recovery turns.

## Task 1: One bounded recovery turn

Files:
- `services/orchestrator/src/execution/agent.ts`
- `services/orchestrator/test/agent-fastpath-navigation-completion.test.ts`

Acceptance criteria:
- A text-only final answer blocked by a repairable completion-contract condition receives exactly one continuation turn.
- The continuation names the blocker and the task-owned running process identifiers so the model can call `stop_process` without rediscovery.
- A successful cleanup followed by a valid final answer completes normally.
- A second blocked final answer preserves the existing truthful `completion_contract_blocked` interruption.
- No automatic process termination, permission bypass, provider call, or foreign-project access is introduced.

Verification:
- Focused completion/navigation and background-process tests.
- Adjacent agent completion-contract suite.
- Orchestrator TypeScript check.
- Full non-live test suite.
- Independent code and security review because process control is security-sensitive.

## Task 2: One post-fix canary

Only after Task 1 is committed and independently approved, run exactly one serialized `deepseek-v4-flash` `flagship-web-v1` canary. Preserve the append-only row. A failure stops live execution and becomes a new repair input; a pass permits planning the reliability streak.
