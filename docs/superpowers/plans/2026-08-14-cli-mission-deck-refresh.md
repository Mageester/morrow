# Mission Deck CLI Refresh Implementation Plan

> Status: implemented and verified on 2026-08-14. The checkbox steps below
> remain as the original execution outline; the verified evidence is recorded
> at the end of this document.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Morrow's interactive CLI presentation around the approved Mission Deck reference while preserving the existing event reducer, provider/runtime boundaries, approvals, recovery, scrollback, and machine-readable modes.

**Architecture:** Keep `TerminalState` and `TerminalEvent` authoritative. Add a pure live-work view model for the right rail, replace the multi-line header with a width-aware one-line chrome strip, and compose the main transcript plus rail through `composeApp`. Keep the composer, overlays, cursor math, and output reports as the existing interaction surfaces; only their presentation is restyled and re-composed.

**Tech Stack:** TypeScript, Vitest, ANSI output helpers, existing `apps/cli/src/terminal` pure views, Unicode/ASCII terminal fallbacks.

## Global Constraints

- Preserve the existing `TerminalState` reducer and SSE/event contracts; no backend or provider behavior changes.
- Preserve local-first privacy, provider choice, effective permission state, honest cost/verification semantics, and secret redaction.
- The default view stays quiet: no raw tool names, arguments, hidden reasoning, permanent shortcut wall, or fabricated artifact/verification data.
- The one obvious input remains fixed at the bottom and keeps existing history, paste, slash completion, palette, approval, cancel, resize, and scroll behavior.
- The live-work rail is progressive disclosure: shown only when the terminal is wide enough; below the threshold, project and task state survive before secondary details.
- Every visual line must remain within the terminal width after ANSI stripping; `--no-color` and ASCII mode must remain readable.
- Existing uncommitted changes outside `apps/cli` belong to the user and must not be staged, reset, or reformatted.

---

### Task 1: Lock the approved visual contract with RED tests

**Files:**
- Create: `apps/cli/test/terminal-mission-deck.test.ts`
- Modify: `apps/cli/test/terminal-view.test.ts`
- Modify: `apps/cli/test/terminal-startup-view.test.ts` only where assertions describe the old multi-line chrome.

**Interfaces:**
- Consumes: `composeApp`, `headerLines`, `completionCard`, `buildLiveWorkLines`, `initialState`, `reduce`, `Output`.
- Produces: executable expectations for the new one-line chrome, live-work rail, mission title, verification surface, and narrow fallback.

- [ ] **Step 1: Write the failing visual contract tests.**

  Add tests for these concrete behaviors:

  ```ts
  it("renders the approved one-line chrome with identity, repository, route, privacy, and permission", () => {
    const state = build([
      { type: "session.started", meta: baseMeta },
      { type: "git.state", git: { branch: "main", dirty: false, ahead: 0, behind: 0 } },
    ]);
    const lines = headerLines(state, plain, { unicode: true, columns: 160 });
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toContain("MORROW");
    expect(stripAnsi(lines[0]!)).toContain("PlaceHolder");
    expect(stripAnsi(lines[0]!)).toContain("main");
    expect(stripAnsi(lines[0]!)).toContain("deepseek-chat");
    expect(stripAnsi(lines[0]!)).toContain("Private");
    expect(stripAnsi(lines[0]!)).toContain("Build");
  });

  it("shows the live-work rail only when the terminal can support the reference hierarchy", () => {
    const state = build([
      { type: "session.started", meta: baseMeta },
      { type: "user.message", text: "Turn this repository into a shippable CLI refresh plan." },
      { type: "plan.snapshot", steps: [
        { id: "inspect", title: "Inspect repository", status: "completed" },
        { id: "verify", title: "Verify plan quality", status: "running" },
      ] },
      { type: "tool.start", id: "t1", name: "read_file", purpose: "README.md" },
      { type: "patch.proposed", files: ["docs/cli-refresh.md"], additions: 12, deletions: 0 },
    ]);
    const wide = composeApp(state, initialInputState(), plain, true, frameContext(), frameOptions(160));
    const narrow = composeApp(state, initialInputState(), plain, true, frameContext(), frameOptions(80));
    expect(wide.lines.join("\n")).toContain("LIVE WORK");
    expect(wide.lines.join("\n")).toContain("Permissions");
    expect(wide.lines.join("\n")).toContain("Verify plan quality");
    expect(narrow.lines.join("\n")).not.toContain("LIVE WORK");
    expect(narrow.lines.join("\n")).toContain("PlaceHolder");
    expect(narrow.lines.join("\n")).toContain("Build");
  });

  it("derives a human mission heading from the user's request without inventing evidence", () => {
    expect(missionTitle("Turn this repository into a shippable CLI refresh plan.")).toBe("Repository → Shippable CLI Refresh Plan");
    expect(missionTitle("check the provider registry")).toBe("Check the provider registry");
  });

  it("renders verification as an evidence-backed result surface", () => {
    const state = build([
      { type: "session.started", meta: baseMeta },
      { type: "user.message", text: "run the checks" },
      { type: "tool.start", id: "t1", name: "run_command", purpose: "pnpm test", verification: true },
      { type: "tool.end", id: "t1", status: "completed", summary: "exit 0" },
      { type: "task.completed" },
    ]);
    const text = completionCard(state, plain, { unicode: true, columns: 120 }).join("\n");
    expect(text).toContain("VERIFICATION RESULT");
    expect(text).toContain("1 check passed");
    expect(text).toContain("VERIFIED");
  });
  ```

  The test fixture must use actual `TerminalEvent` values and the existing no-color `Output`; do not mock the renderer or assert only on internal helper calls.

- [ ] **Step 2: Run the new focused test to prove RED.**

  Run:

  ```powershell
  pnpm --filter @morrow/cli test -- terminal-mission-deck.test.ts
  ```

  Expected: FAIL because `buildLiveWorkLines`/`missionTitle` do not exist and the current header/completion shapes do not satisfy the selected reference.

### Task 2: Add the terminal visual primitives and one-line chrome

**Files:**
- Modify: `apps/cli/src/cli/output.ts`
- Modify: `apps/cli/src/terminal/view.ts`
- Modify: `apps/cli/src/terminal/identity.ts`
- Modify: `apps/cli/src/terminal/mascot.ts` only if the compact identity mark needs an ASCII-safe ring form.
- Test: `apps/cli/test/terminal-mission-deck.test.ts`, `apps/cli/test/terminal-view.test.ts`, `apps/cli/test/identity.test.ts`.

**Interfaces:**
- Consumes: current `Output` color gating, `SessionMeta`, `GitStateInfo`, `permissionChip`, `plainMode`, and `clipToWidth`.
- Produces: stable `Output.copper()`/`Output.sage()` styles, a one-line `headerLines()` result, an ASCII-safe ring identity, and width-aware segment removal.

- [ ] **Step 1: Add RED assertions for ANSI-safe copper/sage styles and ASCII fallback.**
- [ ] **Step 2: Run only those assertions and confirm they fail.**
- [ ] **Step 3: Implement named color helpers using the existing color gate.** Use 256-color ANSI only when color is enabled; return the original string when `--no-color`, `NO_COLOR`, JSON, or a non-TTY path disables styling. Use a warm copper code for active identity/current work and a sage code for verified success; never use the styling helpers to encode a security decision without the textual label.
- [ ] **Step 4: Replace the three-line header with a single width-aware chrome row.** Compose, in order, the copper ring + `MORROW`, project name, Git branch/clean state, model, privacy label, and effective permission label with quiet separators. At 160 columns, keep all segments. At 80 columns, omit only secondary provider/reasoning detail; at narrow widths, preserve project, task mode, and status in the compact form. Keep `/stats` as the owner of detailed tokens/context/cost.
- [ ] **Step 5: Implement the smallest ring identity that matches the reference without introducing a new incompatible glyph vocabulary.** Use `○`/`o` (or the existing compact mark if terminal probing shows the ring is unreliable) and keep the current ASCII fallback.
- [ ] **Step 6: Run the focused view and identity tests and refactor only after GREEN.**

### Task 3: Build the pure live-work rail and mission transcript hierarchy

**Files:**
- Create: `apps/cli/src/terminal/live-work.ts`
- Modify: `apps/cli/src/terminal/app-view.ts`
- Modify: `apps/cli/src/terminal/view.ts`
- Test: `apps/cli/test/terminal-mission-deck.test.ts`

**Interfaces:**
- Consumes: `TerminalState`, `Output`, `unicode`, `columns`, `workspace`, `relativePath`, `permissionChip`, `completionCard`, and existing plan/tool/patch/recovery state.
- Produces: `missionTitle(text: string): string`, `buildLiveWorkLines(state, out, unicode, columns, workspace): string[]`, and a two-column body compositor used only by `composeApp`.

- [ ] **Step 1: Add RED tests for mission title normalization, plan statuses, observed artifacts/references, permissions, and width-safe rail lines.** The rail may show only files observed in patches/tools/conversation; it must never invent file size, timestamps, or verification counts.
- [ ] **Step 2: Run the focused test and confirm the new module is missing.**
- [ ] **Step 3: Implement `missionTitle`.** Normalize a user request into title case, remove leading instruction verbs such as `turn this repository into`, convert `a shippable CLI refresh plan` into `Repository → Shippable CLI Refresh Plan`, and fall back to a clipped sentence when no safe normalization applies. This is a display title only; the original user request remains visible in the transcript.
- [ ] **Step 4: Implement the rail sections.** Render `LIVE WORK`, `Focus`, observed plan/objective status, `Artifacts`, `References`, and `Permissions`. Use the existing effective permission calculation. Show `unknown`/`not recorded` when state does not contain a fact; do not infer success from a running tool or a proposed patch.
- [ ] **Step 5: Recompose `composeApp` into a wide two-column body.** Keep the header, composer, cursor, overlays, and status footer fixed. Give the main transcript the scroll budget and keep the right rail fixed. Use a minimum main width of 68 columns and show the rail only when the full frame is at least 112 columns; otherwise render the main column at full width.
- [ ] **Step 6: Add the reference hierarchy to the main body.** Begin an active task with `MISSION`, the derived title, and the original request; render Morrow's current objective; render the existing closed activity grammar as a vertical timeline; render the assistant's canonical result after activity; keep intermediate narration suppressed as today.
- [ ] **Step 7: Run focused tests and inspect every line with `stripAnsi()` for width safety.**

### Task 4: Restyle completion, composer, and live-state behavior without weakening interactions

**Files:**
- Modify: `apps/cli/src/terminal/view.ts`
- Modify: `apps/cli/src/terminal/app-view.ts`
- Modify: `apps/cli/src/terminal/completion.ts` only if the slash menu needs the approved copper selection treatment.
- Modify: `apps/cli/src/terminal/palette.ts` only if the command palette needs the same selection treatment.
- Test: `apps/cli/test/terminal-presentation.test.ts`
- Test: `apps/cli/test/terminal-completion.test.ts`
- Test: `apps/cli/test/terminal-palette.test.ts`
- Test: `apps/cli/test/terminal-approvals.test.ts`
- Test: `apps/cli/test/terminal-input-reliability.test.ts`

**Interfaces:**
- Consumes: existing `InputState`, overlay contracts, `completionActive`, approval view model, and `statusBar`.
- Produces: the reference composer treatment, contextual hint row, stable status footer, copper current-state markers, sage verified markers, and unchanged keyboard semantics.

- [ ] **Step 1: Add RED assertions for the full-width composer, contextual hints, slash completion above the composer, approval prompt, and cursor placement.** Assert behavior and visible order, not ANSI escape sequences.
- [ ] **Step 2: Run the focused interaction tests and confirm RED.**
- [ ] **Step 3: Restyle the composer.** Keep the existing bordered input and wrapping/caret math, but use a thin copper focus border, copper prompt marker, muted placeholder, and the reference hint row. Hints must remain contextual: show command/compose/help on first session, completion controls while `/` is active, overlay controls when an overlay is open, and only the status line otherwise.
- [ ] **Step 4: Restyle completion and palette selection.** The selected row gets a single copper indicator and readable text; unselected rows stay muted. Keep Tab, arrows, Enter, Escape, Ctrl+K, and query filtering unchanged.
- [ ] **Step 5: Restyle approvals and recovery.** Use explicit text plus copper/amber/sage markers, keep the actual approval prompt in the frame, and ensure recovery still states failure, strategy, and outcome. Do not change permission behavior.
- [ ] **Step 6: Re-run all focused interaction tests and refactor only with green tests.**

### Task 5: Update existing renderer expectations and verify the integrated CLI slice

**Files:**
- Modify: `apps/cli/test/terminal-view.test.ts`
- Modify: `apps/cli/test/terminal-startup-view.test.ts`
- Modify: `apps/cli/test/terminal-beta29-rendering.test.ts` only where it asserts superseded chrome.
- Modify: `apps/cli/test/terminal-status-usage.test.ts` only where the status ownership moved visually.
- Modify: `docs/BETA30_CLI_ACCEPTANCE.md` with the approved Mission Deck states and any changed width threshold.
- Modify: `apps/cli/README.md` only if the interactive first-run guidance changes.

**Interfaces:**
- Consumes: the implemented renderer and all existing CLI interaction tests.
- Produces: a coherent acceptance record and reproducible verification commands.

- [ ] **Step 1: Update only assertions that describe the superseded visual structure.** Keep all assertions for privacy, permission correctness, redaction, state transitions, recovery semantics, machine mode, and overlay behavior.
- [ ] **Step 2: Add a deterministic 160-column representative frame fixture.** It must include a task request, plan snapshot, one completed inspection, one running verification, one observed file, and one approval boundary so the output can be compared to the selected reference without a provider or network.
- [ ] **Step 3: Run the CLI focused suite.**

  ```powershell
  pnpm --filter @morrow/cli test -- terminal-mission-deck.test.ts terminal-view.test.ts terminal-presentation.test.ts terminal-completion.test.ts terminal-palette.test.ts terminal-approvals.test.ts terminal-input-reliability.test.ts
  ```

- [ ] **Step 4: Run CLI type-check and formatting checks.**

  ```powershell
  pnpm --filter @morrow/cli check
  git diff --check
  ```

- [ ] **Step 5: Run the full CLI test suite.**

  ```powershell
  pnpm --filter @morrow/cli test
  ```

- [ ] **Step 6: Run the repository checks required for release confidence only after the CLI slice is green.**

  ```powershell
  pnpm check
  pnpm build
  ```

- [ ] **Step 7: Review the final diff and status.** Confirm only the CLI refresh files, tests, plan, and acceptance documentation are in the intended slice; leave unrelated existing modifications untouched and report any baseline failures separately.

## Verification Checklist

- [ ] RED tests failed for the missing visual contract before production changes.
- [ ] Focused CLI tests pass after each renderer slice.
- [ ] CLI type-check passes.
- [ ] Full CLI suite passes or every pre-existing/unrelated failure is identified with exact evidence.
- [ ] Every composed line remains within its width in Unicode and ASCII mode.
- [ ] Approval, recovery, provider/privacy, cost unknown, and machine-mode behavior are unchanged and covered.
- [ ] The wide frame visibly follows the selected reference: one-line chrome, mission transcript, vertical activity, live-work rail, evidence result, full-width copper composer, contextual hints.
- [ ] No user-owned unrelated work is staged or altered.

## Verified execution record

- [x] Initial Mission Deck contract run was RED before renderer changes.
- [x] Focused renderer, interaction, width, approval, overlay, and scroll tests pass.
- [x] `pnpm --filter @morrow/cli test` — 89 files, 803 tests passed.
- [x] `pnpm check` — all 10 workspace checks and repository validation passed.
- [x] `pnpm build` — all 9 build targets passed.
- [x] `git diff --check` passed.
- [x] Existing unrelated dirty files were preserved; nothing was staged or committed.
