# Fresh Artifact Recovery Plan

**Goal:** Recover once from a provider that invents a missing-task narrative despite receiving a valid artifact request, without replaying that mistaken narrative or spending three larger reasoning-only retries.

**Retained failure:** Run `5cbe11ee-3c4a-438c-a1d6-4d8ed923ece9` durably stored the complete 1,286-character request and sent requests below compaction thresholds. DeepSeek made three successful discovery calls, then produced repeated claims that no task/request existed. Morrow appended its action-only recovery to that poisoned transcript and spent three reasoning-only retries before interrupting after 235 seconds and 30,133 completion tokens.

## Acceptance criteria

1. Add a deterministic full-agent regression in which a provider inspects an empty workspace, falsely claims no request exists through the artifact-delivery boundary, and then acts only when given a fresh trusted context.
2. At the existing one-shot artifact-delivery recovery boundary, rebuild the request from applicable system messages plus one explicit user recovery containing the original request; do not replay prior assistant narration, tool calls/results, or provider reasoning continuation.
3. Preserve the durable database transcript and append-only audit events; only the next provider request projection is reset.
4. Apply this reset only to an artifact-required task with no durable mutation and only once.
5. If the fresh recovery response is reasoning-only/empty, interrupt immediately with a precise reason instead of entering the generic three-retry output escalation.
6. Preserve permission, approval, provider-routing, evaluator, requirement, and completion-contract behavior.
7. Pass focused tests, adjacent execution/projection tests, TypeScript, independent review, and the complete non-live suite before any new provider call.

## Implementation boundary

- Production: `services/orchestrator/src/execution/agent.ts`; one small pure helper is allowed only if it materially clarifies trusted fresh-context construction.
- Tests: the smallest cohesive full-agent file covering artifact delivery and reasoning-only recovery, plus projection tests only if the helper is extracted.
- No changes to provider credentials, model catalog, evaluator scoring, live scripts, evidence history, or retry budgets outside this scoped post-reset path.

## Security and privacy

The reset must retain only already-authorized system instructions and the original user request. It must not copy tool output, page content, provider-private reasoning, memory from another task, or cross-project state. Durable records remain unchanged for auditability.

## Rollback and stopping rule

Land as one focused runtime commit. After deterministic approval, run exactly one DeepSeek web canary. Preserve and commit its row. Any failed or ambiguous row stops live execution and opens another bounded diagnosis package; never auto-retry.
