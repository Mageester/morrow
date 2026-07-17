# Packaged Acceptance Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a packaged, isolated, resumable, evidence-backed acceptance runner with one deterministic consumer-path smoke scenario.

**Architecture:** A focused CLI acceptance module owns schemas, redaction, containment, atomic state, fixture creation, subprocess execution, classification, and reports. The public command delegates to that module, while the packaged smoke invokes the compiled CLI and real orchestrator with only the provider response mocked.

**Tech Stack:** TypeScript, Node.js filesystem/child-process APIs, Vitest, Git CLI, existing Morrow CLI/orchestrator/package scripts.

## Global Constraints

- Do not modify protected launcher files.
- Do not use shell command strings for fixture or product execution.
- Do not expose inherited provider credentials to the child product.
- Do not perform network, push, deployment, purchase, or credential mutations.
- Reports use exactly PASS, FAIL, BLOCKED, NOT RUN, or INCONCLUSIVE.
- No metered provider call is permitted in this slice.

---

### Task 1: Acceptance primitives and durable ledger

**Files:**
- Create: `apps/cli/src/acceptance/types.ts`
- Create: `apps/cli/src/acceptance/redaction.ts`
- Create: `apps/cli/src/acceptance/storage.ts`
- Test: `apps/cli/test/acceptance-storage.test.ts`

**Interfaces:**
- Produces: `AcceptanceDisposition`, `AcceptanceRunState`, `EvidenceEntry`, `redactAcceptanceValue`, `assertContainedPath`, `AcceptanceStore`.

- [ ] **Step 1: Write failing tests** for all five dispositions, secret/canary/private-key redaction, descendant containment, atomic state round-trip, append-only evidence sequencing, and safe run-id validation.
- [ ] **Step 2: Run** `pnpm --filter @morrow/cli test -- acceptance-storage.test.ts` and confirm failures are caused by missing modules.
- [ ] **Step 3: Implement minimal primitives** with schema version `1`, a strict run-id pattern, recursive string redaction, path-relative containment checks, temp-file-plus-rename state writes, and JSONL evidence append/read.
- [ ] **Step 4: Re-run** the focused test and require all assertions to pass.
- [ ] **Step 5: Commit** with `feat(cli): add durable acceptance run storage`.

### Task 2: Isolated fixture and truthful reports

**Files:**
- Create: `apps/cli/src/acceptance/fixture.ts`
- Create: `apps/cli/src/acceptance/report.ts`
- Test: `apps/cli/test/acceptance-fixture-report.test.ts`

**Interfaces:**
- Consumes: `AcceptanceStore`, `AcceptanceRunState`, `EvidenceEntry`, `redactAcceptanceValue`, `assertContainedPath`.
- Produces: `createFoundationFixture(runRoot)`, `verifyFixtureUnchanged(fixture)`, `classifyFoundationRun(state, evidence)`, `writeAcceptanceReports(store, state, evidence)`.

- [ ] **Step 1: Write failing tests** that create a real temporary Git fixture, assert a clean starting commit, reject escaping paths, classify missing evidence as INCONCLUSIVE and failed checks as FAIL, generate JSON/Markdown reports, and prove seeded secrets/absolute paths are absent.
- [ ] **Step 2: Run** `pnpm --filter @morrow/cli test -- acceptance-fixture-report.test.ts` and observe the expected missing-module failures.
- [ ] **Step 3: Implement fixture creation** using `execFileSync("git", args, { cwd, shell: false })`, fixed Git operations, deterministic files, and no remote.
- [ ] **Step 4: Implement classification/reporting** with an all-required-checks PASS gate, relative evidence references, redacted bounded summaries, and both report formats.
- [ ] **Step 5: Re-run** the focused test and require all assertions to pass.
- [ ] **Step 6: Commit** with `feat(cli): add isolated acceptance fixture and reports`.

### Task 3: Consumer-facing runner, resume, and CLI command

**Files:**
- Create: `apps/cli/src/acceptance/runner.ts`
- Create: `apps/cli/src/commands/acceptance.ts`
- Modify: `apps/cli/src/main.ts`
- Test: `apps/cli/test/acceptance-runner.test.ts`
- Test: `apps/cli/test/main.test.ts`
- Test: `apps/cli/test/entrypoint-parity.test.ts`

**Interfaces:**
- Consumes: fixture/report/storage interfaces from Tasks 1–2.
- Produces: `runAcceptance`, `resumeAcceptance`, `reportAcceptance`, `acceptanceCommand`, and the public `acceptance` root command.

- [ ] **Step 1: Write failing tests** for command routing/help, minimal child environment, fixed executable/argument spawning, state checkpoints before side effects, completed-step skipping on resume, interrupted read-only invocation recovery, and terminal report regeneration without replay.
- [ ] **Step 2: Run** `pnpm --filter @morrow/cli test -- acceptance-runner.test.ts main.test.ts entrypoint-parity.test.ts` and confirm expected failures.
- [ ] **Step 3: Implement the runner** with bounded `spawn`, `shell: false`, isolated `MORROW_HOME`, `MOCK_PROVIDER=true`, no inherited credential variables, captured/redacted artifacts, and consumer JSON inspection of persisted task state/evidence.
- [ ] **Step 4: Implement command routing/help** for `run`, `resume`, and `report` without touching launcher templates.
- [ ] **Step 5: Re-run** the focused tests and require all assertions to pass.
- [ ] **Step 6: Commit** with `feat(cli): add packaged acceptance command`.

### Task 4: Packaged smoke, documentation, and targeted review

**Files:**
- Create: `scripts/acceptance-foundation-smoke.mjs`
- Create: `scripts/acceptance-foundation-smoke.test.mjs`
- Modify: `package.json`
- Modify: `README.md`
- Create: `docs/ACCEPTANCE.md`

**Interfaces:**
- Consumes: built/package CLI and `morrow acceptance run`.
- Produces: `pnpm smoke:acceptance-foundation` and retained report/evidence paths.

- [ ] **Step 1: Write a failing packaged smoke test** that snapshots source commit/status, invokes the compiled/package CLI from a temporary home, parses the JSON report, checks PASS and starting SHA, verifies persisted product/evidence markers, leak-scans artifacts, and confirms source status/commit are unchanged.
- [ ] **Step 2: Run** the smoke test and confirm it fails because the smoke driver/command is absent.
- [ ] **Step 3: Implement the smoke driver and docs** without modifying launcher templates or release/publish behavior.
- [ ] **Step 4: Run focused CLI tests, `pnpm check`, `pnpm build`, the packaged smoke, and `pnpm test`; record exact outputs and any unrelated baseline failures.
- [ ] **Step 5: Perform the narrow security review** by inspecting only changed code for containment, traversal, credential redaction, destructive operations, and report leakage; add regression tests for every issue found.
- [ ] **Step 6: Inspect** `git diff --check`, `git status --short`, and the final diff; confirm protected launcher files are untouched.
- [ ] **Step 7: Commit** with `test(acceptance): prove packaged foundation smoke`.
