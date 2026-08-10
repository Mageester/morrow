# Trusted Workspace Agent Freedom Implementation Plan

> Execute directly on `codex/agent-freedom-release` with strict red-green-refactor. Do not merge to `main`; publish a prerelease from the reviewed feature commit.

**Goal:** Deliver a freer, model-owned Morrow harness with trusted workspace execution, reliable large-file tools, visible provider reasoning, and an installable Windows prerelease.

**Architecture:** Preserve the current agent loop, containment, redaction, change sets, and durable continuations. Replace command allowlisting with a small hard-boundary classifier, make approval behavior honor that classifier, add offset-fenced append and ranged reads, and expose only redacted provider-supplied reasoning through an owned API and opt-in UI projection.

---

## Task 1: Reconcile the model-owned completion contract

**Files:**
- Modify: `services/orchestrator/test/live-loop-performance-conformance.test.ts`

1. Update the six legacy cases that expect controller-injected artifact recovery or interruption.
2. Assert that tool-free model finals complete the task, no synthetic recovery event is emitted, and completion evidence honestly reports unverified artifact requirements.
3. Run the focused file, then the complete orchestrator suite.
4. Commit: `test(orchestrator): align conformance with model-owned completion`

## Task 2: Implement the trusted-workspace command boundary

**Files:**
- Modify: `services/orchestrator/test/command-policy.test.ts`
- Modify: `services/orchestrator/test/agent-tools.test.ts` and focused approval tests
- Modify: `services/orchestrator/src/tools/command-policy.ts`
- Modify: `services/orchestrator/src/execution/agent.ts`

1. Add failing tests proving ordinary executables, package installs, builds, Git commits, and non-force pushes are auto-approvable.
2. Add failing tests proving host destruction, privilege escalation, secret extraction, broad deletion, force push, release/deploy/publish, and external material effects cannot auto-resolve.
3. Replace the broad allowlist with explicit hard-boundary patterns and safe structured-command defaults.
4. Execute auto-approvable commands immediately in trusted mode; always retain human approval for `approval_required`.
5. Run focused tests and commit: `feat(orchestrator): trust ordinary workspace commands`

## Task 3: Make trusted Build the simple default

**Files:**
- Modify: `apps/web/src/features/chat/chat-composer.test.tsx`
- Modify: `apps/web/src/features/chat/chat-composer.tsx`
- Modify: `apps/web/src/styles/app.css`

1. Add failing tests for new-install defaults: Build mode and Trusted workspace enabled.
2. Preserve an existing explicit preference, including Chat and supervised Build.
3. Rename the switch and copy so its boundary is clear.
4. Keep the existing wire field for compatibility while enforcing hard boundaries server-side.
5. Run web focused tests and commit: `feat(web): default builds to trusted workspace`

## Task 4: Add reliable large-file tools

**Files:**
- Add: `services/orchestrator/src/tools/atomic-file-writer.ts`
- Add: `services/orchestrator/test/atomic-file-writer.test.ts`
- Modify: `services/orchestrator/src/workspace/safe-reader.ts`
- Modify: `services/orchestrator/test/safe-reader.test.ts`
- Modify: `services/orchestrator/src/execution/agent.ts`
- Modify: `services/orchestrator/src/tools/catalog.ts`
- Modify focused tool tests

1. Add failing unit tests for workspace containment, parent creation, backup, multi-megabyte append, expected-offset fencing, retry idempotence, digest reporting, and secret-like target denial.
2. Implement an atomic append writer using a same-directory temporary file and rename.
3. Add ranged `read_file` arguments with explicit offset/next-offset/truncation results.
4. Register and dispatch `append_file`; include it in tool profiles, continuity, event projection, and argument repair.
5. Remove arbitrary repeated full-file rewrite and empty-overwrite refusals while keeping omission-marker protection.
6. Correct model instructions so every recommended tool exists.
7. Run focused and orchestrator suites; commit: `feat(orchestrator): support reliable large file delivery`

## Task 5: Expose provider-supplied reasoning

**Files:**
- Modify: `packages/contracts/src/index.ts` and contract tests
- Modify: `services/orchestrator/src/repositories/execution-continuity.ts` and tests
- Modify: `services/orchestrator/src/server.ts` and server tests
- Modify: `apps/web/src/api/conversations.ts` and tests
- Add: `apps/web/src/features/chat/reasoning-disclosure.tsx`
- Add: `apps/web/src/features/chat/reasoning-disclosure.test.tsx`
- Modify: `apps/web/src/features/chat/conversation-page.tsx` and tests
- Modify: `apps/web/src/features/chat/chat-composer.tsx` and tests
- Modify: `apps/web/src/styles/app.css`

1. Add failing strict-contract and repository projection tests.
2. Return only redacted provider ID, turn key, content, and timestamp from an ownership-checked endpoint.
3. Add a persisted Reasoning toggle to the chat toolbar, off by default.
4. Fetch/poll only while visible; render each task's turn reasoning and an honest provider-unavailable empty state.
5. Run focused packages, server, and browser-component tests; commit: `feat(chat): make provider reasoning inspectable`

## Task 6: Documentation and compatibility

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Add: `docs/decisions/0011-trusted-workspace-autonomy.md`
- Modify: `docs/USER_JOURNEYS.md`

1. Remove stale claims that write/terminal tools are disabled.
2. Document trusted workspace defaults, hard boundaries, large-file strategy, reasoning visibility, and rollback.
3. Run documentation/link checks included by `pnpm check`.
4. Commit: `docs: establish trusted workspace autonomy`

## Task 7: Full and live verification

1. Run `pnpm check`, `pnpm test`, and `pnpm build` from the isolated worktree.
2. Start orchestrator/web on isolated ports and run browser tests for composer defaults, reasoning visibility, approvals, and a large-file task.
3. Run serialized live-provider canaries in disposable workspace copies with the user's configured routes. Record exact provider/model, task, result, duration, and limitations; never treat deterministic tests as live evidence.
4. Fix failures through red-green loops and rerun the smallest relevant gate before the full gate.

## Task 8: Package and publish the prerelease

**Files:**
- Modify all version-consistency files using repository release tooling
- Modify: `CHANGELOG.md`

1. Inspect current GitHub releases/tags and choose the next unused prerelease version.
2. Update version and changelog; run version consistency and release-note tests.
3. Build the Windows portable archive and installer; run package contract and clean-install integration in a disposable location.
4. Commit: `chore(release): prepare <version>`
5. Push `codex/agent-freedom-release` without merging.
6. Dispatch the release workflow on this branch or create a prerelease from the verified commit and assets.
7. Wait for GitHub checks, verify checksums/assets/release target, and report the install link, source commit, evidence, known limits, and rollback path.

