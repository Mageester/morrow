# Morrow Trust and Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development and superpowers:verification-before-completion to implement and verify each slice.

**Goal**

Implement the approved trust, continuity, and product-polish audit pass while
preserving Morrow's local-first architecture and protected UI boundaries.

**Architecture**

Keep policy decisions at the orchestrator dispatch boundary, keep user-facing
state in existing web feature components, and reuse existing task projections,
redaction, capability registries, and navigation primitives. Additive API
contracts should remain backward-compatible with older persisted routing
records.

**Tech Stack**

TypeScript, Zod contracts, Fastify orchestrator routes, React/TanStack Router,
Vitest, Playwright through the in-app Browser, pnpm/Turbo, and the repository's
existing CSS tokens.

## Global constraints

- Work only on `codex/morrow-teammate-orchestration`; do not merge to `main`.
- Do not modify protected prototype surfaces or
  `apps/web/src/features/chat/conversation-page.tsx`.
- Do not redesign Skills. Apply only the smallest confirmed high-risk default
  containment if the regression test demonstrates the issue.
- For every behavior slice: write a focused failing test, run it and confirm
  the expected failure, implement the smallest coherent change, then run the
  focused test again.
- Use `apply_patch` for source edits and keep commits focused with Conventional
  Commit messages.

## Task 1: Project activation and direct project chat

- [ ] Add a failing projects-page test proving the active project's primary
  action points to project-scoped history and that a direct new-chat action
  uses the selected project.
- [ ] Update the project page to use the existing `NewChatButton` and route
  project history with the project id in router search.
- [ ] Add/adjust styles only where the new action needs existing project-page
  layout support.
- [ ] Run the projects feature tests and commit the focused slice.

## Task 2: Privacy enforcement at dispatch

- [ ] Add failing contract/dispatcher tests for local-only remote rejection,
  local acceptance, controlled-cloud acceptance, and request-fingerprint
  stability.
- [ ] Add a backward-compatible privacy mode field to routing/send contracts.
- [ ] Resolve the assistant profile before provider selection, reject disallowed
  remote routes before runner invocation, and persist the effective privacy
  mode in the routing decision.
- [ ] Update the settings copy and tests so the UI describes enforcement rather
  than a non-binding preference.
- [ ] Add the privacy decision to activity projection where the current schema
  already exposes routing details.
- [ ] Run contracts, dispatcher, routing, and settings tests; commit.

## Task 3: Composer visibility and recovery semantics

- [ ] Add a failing mobile composer/e2e assertion that capability status remains
  visible and opens its detail surface at a narrow viewport.
- [ ] Replace the mobile `display:none` rule with a compact, overflow-safe
  capability control and preserve the bottom clearance that avoids clipped
  controls.
- [ ] Add failing API tests for a distinct resume operation and update the
  conversations client/reusable failure copy without touching the protected
  conversation page.
- [ ] Run focused web/orchestrator recovery tests and commit.

## Task 4: Verification evidence and support bundle

- [ ] Add failing tests for baseline comparison wiring at the existing
  diagnostics/execution boundary and for a redacted support bundle.
- [ ] Wire a bounded structured diagnostics comparison into the existing task
  evidence path without changing completion-gate semantics.
- [ ] Add an additive support-bundle contract, server endpoint, client method,
  and activity-panel download action using projected/redacted data only.
- [ ] Run diagnostics, activity, API, and web tests; commit.

## Task 5: Teams, provider readiness, terminal disclosure, and Skills containment

- [ ] Add failing tests for Teams navigation, missing-model provider readiness,
  terminal capability disclosure, and high-risk skill catalog presentation.
- [ ] Add Teams to desktop/mobile navigation, distinguish “Needs a model” from
  healthy configured providers, and expose PTY availability through the
  existing diagnostics surface.
- [ ] If the high-risk catalog test confirms the audit finding, mark or hide
  those bundled entries behind an explicit experimental state; do not alter
  skill contents or permissions.
- [ ] Run focused web/orchestrator/CLI tests and commit.

## Task 6: Documentation and release truth

- [ ] Add a failing repository validation/test assertion for the checked-in
  version and install documentation drift where a suitable existing test
  boundary exists.
- [ ] Update installation, README, parity, and user-facing capability docs to
  reflect 0.6.0, current platform support, project/privacy/recovery semantics,
  and optional PTY behavior.
- [ ] Record the high-risk catalog containment and privacy behavior in the
  relevant privacy/security documentation.
- [ ] Run docs validation and `git diff --check`; commit.

## Task 7: Full verification and handoff

- [ ] Run `pnpm check`, `pnpm test`, and the relevant build/e2e commands from a
  clean working state.
- [ ] Use the existing in-app Browser tab to verify project selection, new chat,
  settings privacy copy, activity/support export, Teams navigation, provider
  readiness, and the mobile composer. Capture final screenshots outside the
  repository.
- [ ] Inspect the final diff for protected-file violations, secrets, stale
  version claims, and unintended Skills changes.
- [ ] Report exact commands, results, screenshots, known limitations, and
  rollback notes.
