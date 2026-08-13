# Premium UI Reference Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the approved Morrow premium redesign as inspectable HTML/CSS, fixed-viewport screenshots, and a strict Claude implementation prompt.

**Architecture:** Keep the reference isolated under `docs/redesign/premium-reference/`. A static query-driven prototype renders each approved surface from shared tokens and components; a Playwright capture script creates deterministic screenshots and a manifest. Supporting documents define motion, responsive behavior, acceptance, and route mapping without changing production code.

**Tech Stack:** Static HTML, CSS, browser JavaScript, Playwright, Markdown.

---

### Task 1: Durable visual source

**Files:**
- Create: `docs/redesign/premium-reference/index.html`
- Create: `docs/redesign/premium-reference/reference.css`
- Create: `docs/redesign/premium-reference/reference.js`

- [ ] **Step 1:** Define the approved charcoal, warm-white, copper, green, typography, spacing, radius, border, and shadow tokens in `reference.css`.
- [ ] **Step 2:** Build the shared framed shell, sidebar, top bar, decision-free content layout, responsive sidebar, and reduced-motion rules.
- [ ] **Step 3:** Render Home, Chat, Projects, Memory, Skills, History, Connections, and Settings from `?screen=<name>` without production APIs or mutable data.
- [ ] **Step 4:** Open every query state and confirm it renders without console or page errors.

### Task 2: Deterministic visual evidence

**Files:**
- Create: `docs/redesign/premium-reference/capture.mjs`
- Create: `docs/redesign/premium-reference/shots/*.png`
- Create: `docs/redesign/premium-reference/shots/manifest.json`

- [ ] **Step 1:** Add a Playwright capture matrix for every desktop surface plus Home and Chat mobile references.
- [ ] **Step 2:** Capture at `1600x1000` desktop and `390x844` mobile with reduced motion enabled.
- [ ] **Step 3:** Record console errors, page errors, horizontal overflow, viewport, source URL, and screenshot path in `manifest.json`.
- [ ] **Step 4:** Fail capture when a reference has runtime errors or horizontal overflow.

### Task 3: Claude handoff contract

**Files:**
- Create: `docs/redesign/premium-reference/README.md`
- Create: `docs/redesign/premium-reference/MOTION_AND_RESPONSIVE.md`
- Create: `docs/redesign/premium-reference/ACCEPTANCE.md`
- Create: `docs/prompts/CLAUDE_PREMIUM_UI_IMPLEMENTATION.md`

- [ ] **Step 1:** Document screen-to-route mappings, source-of-truth order, and prototype limitations.
- [ ] **Step 2:** Specify timings, easing, hover/focus/pressed states, reduced motion, and responsive transformations.
- [ ] **Step 3:** Define functional preservation, accessibility, responsive, screenshot-comparison, test, and rollback gates.
- [ ] **Step 4:** Write the final Claude prompt requiring inspection of source and screenshots before production edits and forbidding generic reinterpretation.

### Task 4: Verification and commit

**Files:**
- Verify: `docs/redesign/premium-reference/**`
- Verify: `docs/prompts/CLAUDE_PREMIUM_UI_IMPLEMENTATION.md`

- [ ] **Step 1:** Run `node docs/redesign/premium-reference/capture.mjs`; expect all references captured with zero runtime errors or horizontal overflow.
- [ ] **Step 2:** Validate every Markdown link target and every screenshot listed in the manifest.
- [ ] **Step 3:** Run `git diff --check -- docs/redesign/premium-reference docs/prompts/CLAUDE_PREMIUM_UI_IMPLEMENTATION.md docs/superpowers/plans/2026-08-13-premium-ui-reference-pack.md`; expect no output.
- [ ] **Step 4:** Stage only the reference pack, prompt, and this plan, then commit with `docs(ui): add premium reference pack`.
