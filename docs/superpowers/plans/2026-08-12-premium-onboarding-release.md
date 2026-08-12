# Premium Onboarding Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a durable, cinematic five-scene first-run experience and publish it as Morrow beta.42.

**Architecture:** A focused React feature mounts at the app-shell boundary and composes existing onboarding, assistant-profile, provider, and project APIs. The UI is a full-viewport overlay on Home only, with server-persisted progress, an image-generated sculpture asset, CSS motion, and a reduced-motion equivalent.

**Tech Stack:** React 19, TanStack Query/Router, Zod, Vitest/Testing Library, CSS, Vite, Fastify onboarding endpoints already present.

## Global Constraints

- Preserve all pre-existing dirty and untracked files.
- No new framework or runtime dependency.
- No provider credential may enter onboarding state or React Query mutation storage.
- All readiness claims come from existing provider and project APIs.
- Motion must honor `prefers-reduced-motion` and mobile safe areas.
- Release source version is exactly `0.1.0-beta.42` across all validated mirrors.

---

### Task 1: Durable onboarding client and scene behavior

**Files:**
- Create: `apps/web/src/api/onboarding.ts`
- Create: `apps/web/src/features/onboarding/onboarding-experience.tsx`
- Create: `apps/web/src/features/onboarding/onboarding-experience.test.tsx`
- Modify: `apps/web/src/app/app-shell.tsx`

**Interfaces:**
- Consumes: `assistantProfileApi.update`, `providerQueries.list`, `projectQueries.list`, and existing `/api/onboarding` routes.
- Produces: `onboardingQueries.state()`, `onboardingApi.update(input)`, and `<OnboardingExperience pathname />`.

- [ ] Write tests proving fresh Welcome rendering, skip persistence, scene resume, profile persistence, truthful readiness, final completion, and onboarded bypass.
- [ ] Run `pnpm --dir apps/web exec vitest run src/features/onboarding/onboarding-experience.test.tsx --maxWorkers=4` and confirm failures are caused by the missing feature.
- [ ] Implement strict schemas, scene projection, durable mutations, focus containment, Home-only display, and app-shell mounting.
- [ ] Re-run the focused suite until green, then run existing app-shell and getting-started suites.

### Task 2: Production visual system and generated asset

**Files:**
- Create: `apps/web/public/assets/onboarding/morrow-continuity.webp`
- Modify: `apps/web/src/styles/app.css`

**Interfaces:**
- Consumes: stable `morrow-onboarding*` class names from Task 1.
- Produces: desktop/mobile layouts, scene transition states, focus states, and reduced-motion behavior.

- [ ] Convert the accepted generated sculpture to an optimized WebP and place it under the web public assets directory.
- [ ] Implement exact graphite/cobalt tokens, open stage layout, editorial type scale, progress hairlines, controls, responsive reordering, safe areas, and motion.
- [ ] Run web check/build and confirm the asset is emitted in the production bundle.

### Task 3: Browser fidelity and interaction QA

**Files:**
- Modify only files from Tasks 1-2 when a reproduced mismatch requires repair.

**Interfaces:**
- Consumes: isolated local Morrow runtime and generated concepts.
- Produces: desktop and 390x844 implementation screenshots plus a five-point fidelity ledger.

- [ ] Start the orchestrator and Vite with a dedicated `MORROW_HOME`; verify process identity, ports, service root, branch, and served entry.
- [ ] Exercise Begin, privacy, personalization, setup links, refresh/resume, completion, and Explore first.
- [ ] Capture desktop at 1440x960 and mobile at 390x844; inspect both screenshots and the generated concepts with `view_image`.
- [ ] Repair every actionable mismatch, verify zero browser console errors, and remove temporary QA artifacts.

### Task 4: Beta.42 release

**Files:**
- Modify: `package.json`
- Modify: `apps/cli/src/service/update.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: repository version-consistency validator and release workflow.
- Produces: beta.42 release commit, pushed branch/PR, and explicitly dispatched release workflow after merge approval gates are satisfied.

- [ ] Add the beta.42 changelog section and synchronize all validated version mirrors.
- [ ] Run focused tests, full `pnpm test`, `pnpm check`, `pnpm build`, `git diff --check`, and `pnpm branches:freshness`.
- [ ] Commit only onboarding/release files with Conventional Commit messages.
- [ ] Push the branch and create a pull request to `main`; do not merge directly to `main`.
- [ ] Publish only after required review and the release workflow's package/install validation succeed. If review prevents publication in this session, leave a complete release candidate and report the exact remaining gate.

