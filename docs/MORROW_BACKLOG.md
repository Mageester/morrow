# Morrow Backlog (impact-ranked)

Ordering optimizes for: high user value, architectural cleanliness, full
testability, and unblocking later work. Each item is a coherent, committable
slice. `[x]` = VERIFIED (backend + tests + matrix updated). `[~]` = in progress.

## Beta.30 (proposed — from beta.29 acceptance findings)

Not yet scoped or started (`[ ]` throughout). Sourced from the structured
acceptance-test report in [`docs/KNOWN_ISSUES.md`](KNOWN_ISSUES.md) — see
that document for reproduction steps, evidence, and per-issue acceptance
criteria (including which parts are verified vs. hypothesis). Issue numbers
below refer to that document. Priority reflects the beta.30 roadmap section
of the same document.

### P0/P1

- [ ] **Correct provider capability registry.** Canonical `deepseek-v4-flash`/
      `deepseek-v4-pro` keep verified 1M-context/384K-output metadata; legacy
      aliases (`deepseek-chat`, `deepseek-reasoner`) get resolved metadata
      instead of an unset `contextWindow`. Addresses issues 15, 16.
- [ ] **Canonical model resolution.** `deepseek-chat`/`deepseek-reasoner`
      resolve to `deepseek-v4-flash` (with the correct thinking-mode flag)
      before any capability or context-preflight calculation; UI shows both
      the alias used and the canonical model it resolved to. Addresses
      issues 15, 16, 17.
- [ ] **Provider-specific continuation state.** Persist provider-required
      continuation fields (`content`, `reasoning_content`, `tool_calls`,
      tool-call IDs, tool results, ordering) for stateless providers
      (starting with DeepSeek thinking mode); detect unresumable provider
      state before issuing a doomed request rather than surfacing a raw
      provider error. Addresses issue 8.
- [ ] **Automatic context preflight.** Calculate context before every
      provider call using canonical metadata, a realistic output reserve,
      and provider-specific fields; surface the calculation in diagnostics.
      Addresses issue 15.
- [ ] **Durable mission checkpoints.** Structured checkpoint preserving
      original mission, hard requirements, prohibited actions, decisions/
      trade-offs, completed work, current git state, files changed,
      outstanding work, test results/failures, recovery history, approval
      state, and provider-specific continuation fields. Addresses issues 5,
      7, 8.
- [ ] **Automatic compaction.** Compact old narration and redundant tool
      output without discarding hard requirements or unresolved failures;
      deduplicate repeated activity; retain references to full durable
      records. Addresses issues 11, 15.
- [ ] **Automatic continuation until verified completion.** Morrow owns
      continuity: turn-budget boundaries become internal checkpoints,
      context pressure triggers provider-aware compaction before failure,
      and the mission continues automatically when safe. User interaction is
      required only for explicit approval boundaries, user-set budget/cost
      limits, missing credentials, an unrecoverable external failure, or
      material ambiguity requiring a product decision. Never claim
      completion merely because a checkpoint was created; never recommend
      `/continue` when it will deterministically repeat the same failure.
      Addresses issues 5, 7, 8 (core product promise — "mission ownership").
- [ ] **Mission Guardian / Requirement Compliance Monitor.** Structured
      hard-requirements checklist derived from the mission prompt (e.g. "no
      frontend", "zero unjustified dependencies", "built-in `node:http`"),
      checked before each write/dependency-adding tool call so violations are
      caught during execution, not discovered after the fact. Addresses
      issue 5.
  - [ ] Structured hard-requirement checklist (extraction + storage).
  - [ ] Requirement coverage view (which requirement each major
        implementation satisfies).
  - [ ] Scope-drift detection (flag actions that fall outside the original
        requirement set, e.g. adding a database or frontend that was never
        requested).
- [ ] **Permission-state precedence rules.** Every permission-bearing root
      command (`ask`, `fix`, `plan`, `yolo`) sets a complete, explicit
      permission state instead of only the flags that differ from default;
      mode-derived autonomy display (header/footer) reflects the *effective*
      state for the current mode, not a raw persisted flag. Addresses
      issues 2, 3.
- [ ] **Accurate task grading.** Plan-stage status in task reports derives
      strictly from actual tool-call/response evidence rather than an
      independent assumption; duration derives from persisted timestamps.
      Addresses issue 13.
- [ ] **Deduplicated event persistence.** One record per event, persisted
      once, in `/output full` and the live activity feed; create-then-recover
      cycles on the same file collapse into one user-facing action with
      retries visible only in the deep trace; later provider requests
      reference (not re-concatenate) prior narration. Addresses issues 4, 11,
      12.

### P2

- [ ] **Decision ledger, `/decisions`, `/explain last`, `/requirements`.**
      Structured, auditable decision summaries and requirement traceability
      without exposing raw chain-of-thought. Addresses issues 5, 6.
- [ ] **Detailed recovery explanations.** Recovery lines render structured
      fields (what failed / affected file or tool / strategy used / outcome)
      instead of a bare "Recovered" string. Addresses issue 4.
- [ ] **Better checkpoint UX.** A distinct checkpoint status (separate from
      `interrupted`) for adaptive-budget stops, carrying completed phases,
      remaining work, requirement coverage, budget consumed, and a
      recommended next action. Addresses issue 7.
- [ ] **Context breakdown UI.** Visible context accounting separating user
      instructions, system instructions, tool schemas, tool results,
      assistant content, provider reasoning fields, and output reserve.
      Addresses issue 11.
- [ ] **Stale model display correction.** Selected/canonical/effective-
      runtime model, provider, fallback status, thinking mode, and
      context-capacity source each shown as distinct, consistent fields in
      `/status`/`/model`/`/context`. Addresses issue 17.
- [ ] **Terminal redraw hardening.** Adopt a true alternate-screen-buffer
      switch on interactive session start/exit so redraws are consistent
      regardless of prior terminal content, instead of the current
      viewport-only clear sequences. Addresses issue 10.
- [ ] **Help discoverability.** Generate `morrow help`'s session-command
      list from the same registry the interactive palette uses, so
      `/tasks`/`/stats` (and future commands) are never silently omitted.
      Addresses issue 14.

## Now

- [x] **B1. Session & memory search (FTS).** SQLite FTS5 over conversations,
      messages, and tasks. Contract + repository + `/api/search` route + CLI
      `/search` command + tests. Unblocks §3 and §7 of the matrix.
- [x] **B2. Memory provenance + pin + tiers.** Add `pinned`, richer `source`
      (origin taskId), and `episodic`/`procedural`/`knowledge` scopes; pin
      ordering in retrieval; explain endpoint. Extends `repositories/memory.ts`.
- [x] **B3. Loop detection.** Stable-signature sliding-window detector
      (`loop-detector.ts`) wired into the agent loop; interrupts with reason
      `loop_detected` before false success. 13 tests.

## Next

- [x] **B4. Skill usage tracking + skill→slash commands.** Per-project usage
      counters (table + repo + API + CLI client); verified skills surface as
      `/skill:<id>` commands wired into the session and invoke + record use.
- [x] **B5. Skill Creator (interview → generate → sandbox test → approve →
      install).** `apps/cli/src/skills/creator.ts` (validate/generate/install) +
      `skills create` interview/flag flow; generated bundles pass `verifySkill`.
- [x] **B6. Skill Curator (dedupe, improve, stale/archive, pin, backup,
      rollback).** `apps/cli/src/skills/curator.ts` + `skills` subcommands
      (dedupe/update/backup/backups/rollback/archive/restore/archived/pin/unpin).
- [x] **B7. Cron scheduler + isolated scheduled runs.** Pure UTC cron engine,
      schedules repo, `SchedulerTicker`, API + CLI `schedule`. (Notifications:
      events emitted; external delivery folded into B17 messaging.)
- [x] **B8. Idempotency keys + explicit retry.** DONE: idempotent task creation
      (partial unique index + `Idempotency-Key` replay) AND `POST /tasks/:id/retry`
      (fresh attempt; 409 unless failed/interrupted; never resurrects cancelled).
      REMAINING (minor): extend idempotency to the agent-chat creation path.
- [~] **B9. Execution backend interface + local backend.** DONE: `ExecutionBackend`
      interface + `localBackend` (over command-executor) + honest Docker/SSH
      stubs that refuse until configured. REMAINING: real Docker + SSH impls.
- [~] **B10. Live provider fallback-on-error.** DONE: `openStreamWithFallback`
      retries the next configured candidate on a retryable start error (never on
      fatal request errors, never mid-stream), emits `provider.fallback`, wired
      into the agent. 10 tests. REMAINING: explicit rate-limit guard/backoff.

## Later

- [~] **B11. MCP client.** DONE: JSON-RPC stdio client (`mcp/client.ts`),
      framing, env-filtered spawn transport, tool-filtering allow-list, and
      fingerprint trust store. REMAINING: HTTP transport, registry + routes,
      OAuth/PKCE, sampling limits.
- [~] **B12. Plugin manager.** DONE: local-only `morrow.plugin.json` registry
      with validated manifests, disabled-by-default install, persisted
      enable/disable state, update/remove lifecycle, and a proof that discovery
      never imports plugin code. REMAINING: signed bundles, runtime hook sandbox,
      permission approvals, API/CLI routes, remote marketplace/update sources.
- [~] **B13. Diagnostics + baseline.** DONE: provider-agnostic diagnostics
      (`workspace/diagnostics.ts` tsc/eslint parsers + `compareBaseline`) +
      `GET /diagnostics` route. REMAINING: wire `compareBaseline` into the agent
      write path; real LSP stdio client.
- [~] **B14. Subagent delegation + task graph.** DONE: `parent_task_id` +
      `listChildren`, `POST /tasks/:id/subagents`, `GET /tasks/:id/tree`;
      composes with persistent named agents (`feat(agents)`). REMAINING: git
      worktrees for parallel isolated agent workspaces.
- [~] **B15. Browser control (Playwright/CDP) + prompt-injection guard.** DONE:
      real local Playwright lifecycle + Chromium/Chrome/Edge channel support,
      CDP attach, semantic refs/actions, isolated/persistent sessions, bounded
      screenshots/content/evidence, dialogs, console/page errors, explicit
      upload/download roots, cancellation, pause/resume/panic, SSRF/scheme
      protections, injection containment, and task-scoped append-only audit
      sink. REMAINING: managed/cloud browser backends and a UI surface for live
      browser evidence.
- [ ] **B16. Desktop control layer (UIA / AX / AT-SPI).**
- [~] **B17. Messaging adapters.** DONE: `MessageAdapter` contract + webhook
      (covers Slack/Discord incoming webhooks) + telegram (token-redacted),
      `POST /api/notify`, scheduler notifications. REMAINING: native Slack/Discord
      apps + SMTP email.
- [~] **B18. Doctor + updater.** DONE: `morrow doctor` (testable
      `aggregateDoctor`), `morrow update` (semver check via injectable source).
      REMAINING: apply-update automation, rollback, uninstall.
- [ ] **B19. Windows + Ubuntu one-command installers.**
- [~] **B20. Hermes import.** DONE: `@morrow/hermes-compat` real package —
      config parse + honest mapping (no invented keys, no leaked secrets).
      REMAINING: CLI `morrow import` wiring + session/skill import.
- [~] **B21. TUI polish.** DONE: persisted cross-session command history
      (`terminal/history.ts`, wired via `onHistory`). REMAINING: live task tree,
      Ctrl+K palette completeness, resize-reflow test, reconnect-dedup test.
- [~] **B22b. Tamper-evident audit store.** DONE: hash-chained append-only
      `audit_log` (`audit/log.ts` + `repositories/audit-log.ts`, migration 18);
      `verify()` detects tampering/reorder/drop. REMAINING: emit from more hooks
      + scoped YOLO allow-lists per side-effect.
- [~] **B22. Security hard-blocks.** DONE: workspace-escape/force-push/network-
      exfil guards enforced categorically before approval, with unit +
      end-to-end (YOLO-bypass) tests. REMAINING: append-only tamper-evident
      audit store + scoped YOLO allow-lists per side-effect.

## Cross-cutting acceptance suites to keep green

- `pnpm check`, `pnpm test`, `pnpm build`
- `pnpm run test:e2e`
- orchestrator smoke: `smoke:sqlite`, `smoke:vertical-slice`,
  `smoke:agent-alpha`, `smoke:providers`
