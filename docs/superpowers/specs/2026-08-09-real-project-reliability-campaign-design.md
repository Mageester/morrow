# Real-Project Reliability Campaign Design

## Purpose

Make Morrow complete ordinary agent tasks reliably across qualified providers instead of repeatedly losing context, rereading work, exhausting recovery counters, or interrupting with unusable partial results. Reliability is proved through versioned deterministic regressions and serialized live runs on disposable project copies.

This campaign extends the existing `flagship-build-v1` and `flagship-web-v1` work. It does not replace or weaken either scenario.

## Success gate

The campaign is complete only when all of the following are true:

- DeepSeek `deepseek-v4-flash` achieves at least 90% verified completion across the versioned ten-task real-project corpus.
- At least two qualified OpenCode Zen free models each achieve at least 70% verified completion across the same corpus.
- Both existing flagship scenarios record ten consecutive qualifying passes under the existing scenario-aware gate.
- There are zero false completions, unsafe workspace escapes, duplicated mutations, unexplained interruptions, and harness/model misclassifications in the qualifying window.
- A run that cannot finish preserves usable partial work and records a precise actionable continuation instead of corrupting the project or reporting ambiguous success.

The gate measures Morrow and model capability separately. A weak model does not excuse a Morrow invariant violation, and an honestly demonstrated model limitation is not mislabeled as a runtime defect.

## Operating model

The campaign follows one serialized loop:

1. Select one versioned scenario, disposable fixture, provider, and model.
2. Run one live attempt.
3. Classify the outcome from durable evidence.
4. Stop at the first unexplained or product-owned failure.
5. Reproduce a Morrow or evaluator defect deterministically.
6. Implement one bounded repair using red-green testing.
7. Independently verify the repair.
8. Run one live canary.
9. Advance only after the canary is correctly classified and evidenced.

Live attempts never run concurrently. The existing flagship runner shares process, port, SQLite, browser, and temporary-workspace boundaries that make parallel live execution unsafe and diagnostically noisy.

## Failure taxonomy

Each unsuccessful run receives exactly one primary classification:

- `morrow_defect`: context, tools, recovery, persistence, progress, or completion violated a product invariant.
- `evaluator_defect`: the harness executed or judged the run incorrectly.
- `model_limitation`: the model received correct state and tools but could not satisfy the task.
- `provider_failure`: the upstream service, transport, quota, or response contract failed independently of Morrow's execution logic.
- `environment_failure`: a disposable fixture, filesystem, process, port, browser, or local runtime boundary failed.
- `task_failure`: Morrow completed the execution honestly, but verifier-owned acceptance checks rejected the artifacts.
- `honest_partial`: Morrow stopped without claiming completion, retained usable work, and emitted a precise continuation.

Classification rules are versioned, deterministic where possible, and covered by synthetic fixtures. Harness and environment defects must be repaired before their affected runs are used to judge Morrow or a model.

## Evidence record

Every live run appends a redacted evidence record. Existing evidence is never rewritten to improve a streak. The record contains:

- scenario and corpus version;
- provider, model, and routing decision;
- disposable workspace identity and clean starting hash;
- context measurements, compactions, segments, and checkpoints;
- tool calls, mutations, progress epochs, and recovery decisions;
- verifier outcomes, artifact hashes, final Git diff, and supervised-process cleanup;
- terminal task and mission dispositions;
- primary classification and stable failure fingerprint;
- whether partial work is resumable and the recorded next action;
- duration, token usage, and cost when the provider exposes them.

Raw credentials, provider secrets, private user content, and unbounded workspace output are prohibited from evidence. Existing redaction and append-only boundaries remain load-bearing.

## Runtime boundaries

Repairs should steadily separate five responsibilities currently coordinated in the execution loop. Extraction occurs only when a demonstrated defect needs the boundary; this campaign is not a speculative rewrite.

### Context projection

Build the provider request from durable turns, route limits, tool schemas, and a bounded checkpoint. A completed compaction must leave useful headroom and must not cause immediate repeated compaction. Removed observations remain available through explicit narrow retrieval rather than implicit full rereads.

### Semantic checkpoint

Persist actionable mission state: completed deliverables, pending requirements, decisions, relevant files and hashes, verification results, unresolved failures, recovery attempts, and the exact next action. Hash-only call summaries are supporting audit data, not sufficient working memory.

### Progress accounting

Distinguish cached observations, real observations, mutations, verification, and narration. Context rollover must not erase durable progress or turn cached reads into repeated real executions. Terminal commands that duplicate dedicated observations cannot manufacture progress or bypass observation limits.

### Recovery policy

Choose one recovery directive from current durable state. Recovery level is monotonic within a failure episode and survives context rollover. Competing prompt injections, reset counters, or alternate-tool bypasses must not prolong a stalled task indefinitely.

### Completion verification

Only evidence admitted by the completion contract can finalize a task or mission. Failed verification, missing browser evidence, active supervised processes, and unmet explicit requirements block completion. When completion cannot be established, the system preserves partial artifacts and reports the precise blocker and continuation.

Changes to context, memory, terminal policy, provider requests, or completion require explicit independent security review before integration.

## Real-project corpus

The initial versioned corpus contains ten disposable tasks:

1. Repair an existing failing test.
2. Build a responsive multi-file website.
3. Add a bounded feature to an existing application.
4. Diagnose and fix a runtime defect.
5. Perform a behavior-preserving refactor.
6. Resume a deliberately half-finished task.
7. Complete a task that requires context compaction.
8. Recover from a failed command and malformed tool call.
9. Run and validate browser interactions.
10. Survive an orchestrator restart without duplicating work.

Each corpus entry defines its source fixture hash, prompt, permitted mutations, hidden verifier, expected evidence classes, timeout policy, and cleanup procedure. Fixtures contain no credentials, user data, deployment authority, or writable remotes. Browser and generated-server access remain loopback-only.

## Provider qualification

DeepSeek `deepseek-v4-flash` is the primary certification route. OpenCode Zen models first run bounded qualification probes for tool-call structure, multi-turn continuation, file mutation, command execution, and final-answer compliance. At least two models that pass the probes enter the full corpus.

Provider qualification affects routing and capability disclosure; it does not weaken corpus acceptance criteria. Unsupported or consistently incapable models are reported honestly rather than presented as reliable choices for autonomous builds.

## Verification strategy

- Every product or evaluator repair begins with a deterministic failing regression.
- The implementing Luna Max task runs the smallest covering test.
- A separate Luna Max task reviews the diff and runs the focused gate after implementation.
- The full orchestrator suite and TypeScript check run after coherent runtime increments, not after every line-level repair.
- One serialized live canary follows a verified repair.
- Full flagship streaks and corpus campaigns run only after the preceding canary passes.
- Live-provider failures never cause deterministic tests to call providers.
- Assertions, timeouts, evidence requirements, and safety boundaries are not weakened to improve pass rates.

## Agent ownership

The primary orchestrator owns architecture, work-package scope, failure classification, integration review, and permission to advance live gates. One Luna Max implementation task owns one bounded production surface. A separate Luna Max tester/reviewer task owns independent verification after the implementation handoff. No two implementation tasks edit the same execution subsystem concurrently.

The session-long Luna Max explorer remains read-only and supplies bounded supplementary findings. It does not implement or approve changes.

## Initial package

The first package is deliberately narrow:

1. Preserve and independently inspect the four existing uncommitted reliability files in `flagship-web-v1`.
2. Verify the cached-observation and provider-projection regressions red-green.
3. Run the focused context, checkpoint, segmented-execution, and live-loop tests.
4. Run the orchestrator TypeScript check and full deterministic suite.
5. Audit the current flagship evaluator against the latest append-only failure row and correct only proven evaluator defects.
6. Run exactly one serialized DeepSeek `flagship-web-v1` canary.
7. Classify and preserve its evidence before selecting the next package.

The first package does not begin a streak until a single passing canary proves that the current runtime and evaluator agree.

## Rollback and stopping rules

Every repair remains a focused commit that can be reverted without deleting evidence. If a fix cannot produce a deterministic reproduction, it is not merged as a reliability repair. If five bounded repair iterations leave a load-bearing defect unresolved, the campaign stops for an architecture decision rather than accumulating further recovery exceptions.

A live campaign stops immediately on a Morrow defect, evaluator defect, unsafe side effect, evidence corruption, or unexplained classification. Provider and environment retries remain bounded and retain the original failed evidence.
