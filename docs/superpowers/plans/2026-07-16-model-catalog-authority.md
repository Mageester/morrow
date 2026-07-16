# Authoritative Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragmented model metadata with a provider/auth-aware catalog and a truthful compact model picker.

**Architecture:** A contracts-level descriptor is resolved from provider discovery plus layered, validated catalog metadata. The orchestrator owns cached catalog refresh and descriptor resolution; the CLI consumes resolved descriptors only. Unknown operational metadata stays null and prevents unsafe admission until explicitly configured.

**Tech Stack:** TypeScript, Zod, Vitest, Node fetch/filesystem, Ink terminal UI, pnpm workspace.

## Global Constraints

- Do not modify `apps/cli/bin/morrow.mjs` or `apps/cli/bin/morrow`.
- Catalog data is non-executable, schema-validated, atomically cached, and never contains credentials.
- Never infer limits, pricing, capabilities, or reasoning from a model name.
- Discovery is provider- and auth-mode-specific; custom endpoints never inherit official metadata.
- Preserve configured provider behavior and stable persisted provider model IDs.
- Add focused tests before every production behavior change and observe red then green.

---

### Task 1: Establish the shared descriptor and bundled catalog

**Files:**
- Modify: `packages/contracts/src/index.ts`
- Create: `services/orchestrator/src/model-catalog/schema.ts`
- Create: `services/orchestrator/src/model-catalog/bundled-catalog.json`
- Test: `services/orchestrator/test/model-catalog-schema.test.ts`

**Interfaces:**
- Produces `ModelDescriptorSchema`, `ModelCatalogSchema`, and `ModelDescriptor`.
- Catalog entries use `{providerId, authMode, canonicalModelId, providerModelId, aliases, ...}`.

- [ ] Write tests that accept GPT-5.6 Sol/Terra/Luna authoritative records and reject a missing source, bad version, or negative capacity.
- [ ] Run `pnpm --filter @morrow/orchestrator test -- model-catalog-schema` and observe failure.
- [ ] Implement strict Zod schemas, nullable unknown operational fields, and the reviewed bundled catalog snapshot.
- [ ] Run the focused test and observe pass.

### Task 2: Resolve metadata without fabricated fallback values

**Files:**
- Create: `services/orchestrator/src/model-catalog/resolver.ts`
- Modify: `services/orchestrator/src/routing/models.ts`
- Modify: `services/orchestrator/src/routing/model-budget.ts`
- Modify: `services/orchestrator/src/routing/effective-context.ts`
- Test: `services/orchestrator/test/model-catalog-resolver.test.ts`
- Test: `services/orchestrator/test/model-budget.test.ts`

**Interfaces:**
- Consumes discovered records, remote/cache/bundled catalog layers, and explicit custom metadata.
- Produces `resolveModelDescriptor(input): ModelDescriptor` and nullable context resolution.

- [ ] Write failing tests for precedence, GPT-5.6 aliases, auth-mode separation, custom-model isolation, invalid reasoning, and zero-floor context arithmetic.
- [ ] Run focused resolver/budget tests and observe failure.
- [ ] Implement deterministic resolver precedence and change unknown context admission from silent 32K fallback to an actionable unknown-limit failure.
- [ ] Run focused tests and observe pass.

### Task 3: Add safe catalog cache and background refresh

**Files:**
- Create: `services/orchestrator/src/model-catalog/catalog-store.ts`
- Modify: `services/orchestrator/src/database.ts` or existing local-state path helper
- Test: `services/orchestrator/test/model-catalog-store.test.ts`

**Interfaces:**
- Produces `CatalogStore.load()` and `CatalogStore.refresh()` with ETag, timeout, atomic cache replacement, and last-known-good behavior.

- [ ] Write failing tests for offline bundled startup, malformed remote data rejection, failed-refresh preservation, and conditional refresh ETag.
- [ ] Run the focused store test and observe failure.
- [ ] Implement schema validation, short timeout, temporary-file-plus-rename cache writes, and non-blocking refresh scheduling.
- [ ] Run the focused store test and observe pass.

### Task 4: Make discovery auth-aware and integrate Codex OAuth

**Files:**
- Create: `services/orchestrator/src/model-catalog/discovery.ts`
- Modify: `services/orchestrator/src/provider/connectivity.ts`
- Modify: `services/orchestrator/src/provider/registry.ts`
- Modify: `services/orchestrator/src/provider/codex.ts`
- Test: `services/orchestrator/test/model-discovery.test.ts`
- Test: `services/orchestrator/test/providers.test.ts`

**Interfaces:**
- Produces `DiscoveredModel { providerId, authMode, providerModelId, discoveredAt }`.
- Codex request construction receives the exact discovered provider ID; no hardcoded GPT-5.5 fallback replaces an explicit unavailable selection.

- [ ] Write failing tests with distinct API-key/Codex `/models` responses, GPT-5.6 Sol availability, and preserved provider ID.
- [ ] Run focused discovery/provider tests and observe failure.
- [ ] Persist/carry discovery records to status and route resolution; retain the existing provider connectivity paths; reject unavailable Codex models explicitly.
- [ ] Run focused discovery/provider tests and observe pass.

### Task 5: Replace model API, persistence, diagnostics, and picker consumers

**Files:**
- Modify: `services/orchestrator/src/server.ts`
- Modify: `services/orchestrator/src/repositories/conversations.ts`
- Modify: `services/orchestrator/src/repositories/missions.ts`
- Modify: `apps/cli/src/client/api.ts`
- Modify: `apps/cli/src/terminal/model-picker.ts`
- Modify: `apps/cli/src/terminal/session.ts`
- Modify: `apps/cli/src/commands/models.ts`
- Test: `apps/cli/test/terminal-model-picker.test.ts`
- Test: `apps/cli/test/terminal-model-picker-interactive.test.ts`
- Test: `services/orchestrator/test/model-diagnostics.test.ts`
- Test: `services/orchestrator/test/execution-continuity.test.ts`

**Interfaces:**
- API lists resolved `ModelDescriptor` values and selection persists stable IDs plus reasoning/catalog version.
- Picker rows contain one canonical descriptor and only concise trusted information.

- [ ] Write failing tests for picker alias dedupe, narrow rendering, keyboard controls, selected reasoning persistence, unavailable resume handling, and redacted diagnostics.
- [ ] Run focused CLI/orchestrator interaction tests and observe failure.
- [ ] Update consumers to use the resolved descriptor exclusively; expose details/advanced filters and a manual refresh control.
- [ ] Run focused tests and observe pass.

### Task 6: Documentation, regression suite, security and release readiness

**Files:**
- Modify: `docs/providers.md`
- Modify: `docs/context-management.md`
- Modify: `README.md`
- Create: `docs/model-catalog-maintenance.md`

- [ ] Document provenance, offline behavior, manual refresh, custom-limit configuration, and catalog publication procedure.
- [ ] Run `pnpm --filter @morrow/orchestrator test`, `pnpm --filter @morrow/cli test`, `pnpm check`, `pnpm test`, and `pnpm build`.
- [ ] Review `git diff --check` plus all catalog-related diffs for schema validation, token leakage, unsafe remote execution, and cross-provider metadata inheritance.
- [ ] Commit focused changes using Conventional Commit messages and request independent security review before merge/release.
