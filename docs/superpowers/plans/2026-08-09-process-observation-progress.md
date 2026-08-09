# Process Observation Progress Repair

**Goal:** Prevent Morrow from interrupting a healthy task immediately after a supervised process produces new, completion-relevant output, without allowing repeated process polling to evade stagnation.

**Retained failure:** DeepSeek run `8d334d0d-f7fa-44b3-bc71-dac2ec8dd7f1` started supervised process `365efaab-ff5d-482c-b327-d688eb97b752`. Its first successful `read_process_output` returned `Flagship Task Board listening on http://127.0.0.1:50065/`; the same turn was classified as the third non-progress turn and Morrow interrupted before `browser_open` or `stop_process`.

## Acceptance criteria

1. Add a deterministic full-agent regression that reaches the post-delivery stagnation boundary, observes genuinely new process output, and proves the provider receives the next turn.
2. Count a successful process observation only when it reveals a previously unseen process status or new output bytes for that task-owned process and stream.
3. Do not count empty, unchanged, offset-only, failed, or repeated process observations as progress.
4. Preserve the existing observation-epoch and general read-only stagnation behavior.
5. Keep process ownership and tool permission checks unchanged.
6. Pass focused tests, adjacent execution tests, TypeScript, and the complete non-live suite before one serialized live canary.

## Implementation boundary

- Production ownership: `services/orchestrator/src/execution/agent.ts` and, only if a small pure helper materially improves testability, one narrowly named module under `services/orchestrator/src/execution/`.
- Test ownership: `services/orchestrator/test/agent-background-process.test.ts` plus the smallest directly related progress test if needed.
- No changes to evaluator scoring, thresholds, provider routing, permissions, process ownership, or live-run scripts.

## Verification and review

The implementer must show the new regression failing before the production change and passing afterward. Because this touches process/tool execution accounting, an independent Luna Max reviewer must inspect the diff and focused evidence. The main agent owns integration, full deterministic verification, documentation, commit, and the single opt-in canary.

## Rollback and stopping rule

The repair is one focused commit and can be reverted without changing append-only evidence. If the canary fails, stop immediately, preserve the row/workspace, and create another bounded diagnosis package; do not retry automatically.
