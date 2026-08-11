# Premium Harness Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Morrow's existing conversation surface feel premium and tactile through restrained motion, then produce evidence about model-facing efficiency without fabricating a Hermes comparison.

**Architecture:** Keep the current React/Vite web architecture, provider-neutral contracts, and server-owned task state. Add a small shared motion vocabulary in the existing CSS token layer, expose real component state through accessible/data attributes, and extend the existing flagship usage projection and standalone harness-economics records with efficiency counters. No browser-only task state, telemetry, new dependency, or protected prototype rewrite.

**Tech Stack:** React 19, TypeScript, Vite, CSS custom properties, lucide-react, Vitest, Testing Library, Fastify/orchestrator, existing DeepSeek provider route, Browser/IAB QA.

## Global Constraints

- Preserve all existing uncommitted work; do not reset, clean, discard, or stage unrelated files.
- Do not modify `apps/web/src/features/_prototype-ui-overhaul/`, `apps/web/src/features/chat/_prototype/`, `apps/web/src/features/home/_prototype/`, `apps/web/src/features/home/home-page.tsx`, or rebuild `conversation-page.tsx`.
- Do not add a motion or telemetry dependency.
- Animate only opacity, color, border, box-shadow, and transform; do not animate layout-sized properties for routine feedback.
- Respect `prefers-reduced-motion` and retain the same accessible information and keyboard behavior.
- Run deterministic tests before any live provider request.
- Live provider work is serialized, capped by the user's remaining API budget, and must not inspect or expose credentials.
- Do not edit `docs/evidence/flagship-runs.jsonl` except through the existing append-only live-run path.
- Do not claim Morrow is more efficient than Hermes/Pi unless the same task set and pass definition produce comparable records.

---

### Task 1: Establish the shared premium motion vocabulary

**Files:**
- Modify: `packages/ui/src/styles/tokens.css`
- Modify: `packages/ui/src/styles/global.css`
- Modify: `apps/web/src/styles/app.css`
- Test/verify: Browser screenshot and reduced-motion rendered check; existing web style/build checks

**Interfaces:**
- Produces CSS custom properties usable by web and shared UI components: `--morrow-motion-fast`, `--morrow-motion-control`, `--morrow-motion-state`, `--morrow-ease-out`, and `--morrow-ease-spring`.
- Preserves existing `prefers-reduced-motion` behavior and adds no JavaScript animation loop.

- [ ] **Step 1: Record the current visual baseline**

  Open the current local conversation route in Browser/IAB at the source-dev URL, capture the desktop viewport, and note the exact visible control states for the composer, model picker, reasoning slider, nav, and activity button. Do not edit source before this baseline exists.

- [ ] **Step 2: Add the failing rendered-state assertions used by later component tasks**

  In the existing component tests, assert the state/data attributes introduced by Tasks 2–4 before adding their implementation. Keep CSS-only visual assertions in Browser QA rather than brittle computed-style tests.

- [ ] **Step 3: Add the motion tokens and base button states**

  Add the following token shape to `packages/ui/src/styles/tokens.css` in `:root` and retain the same values under dark mode through inheritance:

  ```css
  --morrow-motion-fast: 140ms;
  --morrow-motion-control: 180ms;
  --morrow-motion-state: 320ms;
  --morrow-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --morrow-ease-spring: cubic-bezier(0.16, 1, 0.3, 1);
  ```

  Update `.morrow-button` and the existing chat action selectors to use the tokens. Add a one-pixel/one-degree tactile response only on hover/active states and keep disabled controls visually static.

- [ ] **Step 4: Make reduced motion explicit**

  Extend the existing reduced-motion rules so transforms, keyframes, and smooth scroll become effectively instantaneous while border/color/contrast still communicate state. Do not remove focus outlines.

- [ ] **Step 5: Run the web style/build gate**

  Run `pnpm --filter @morrow/web check` and `pnpm --filter @morrow/web build`.

  Expected: both pass with no new CSS parsing or TypeScript errors.

---

### Task 2: Give the reasoning slider a tactile, capability-aware interaction

**Files:**
- Modify: `apps/web/src/features/chat/chat-composer.tsx`
- Test: `apps/web/src/features/chat/chat-composer.test.tsx`
- Modify: `apps/web/src/styles/app.css`

**Interfaces:**
- `ReasoningSlider` continues to accept `RouteReasoningCapability`, `ReasoningConfiguration`, `disabled`, and `onChange`.
- The native range input remains the only keyboard/pointer input. It continues to call `onChange` with normalized `ReasoningConfiguration` values.
- Adds `data-value`, `data-adjustable`, and an `aria-live="polite"` output for the current displayed option; no provider payload shape changes.

- [ ] **Step 1: Write the failing test for visible selected-state semantics**

  Extend the existing DeepSeek slider test with:

  ```tsx
  expect(slider).toHaveAttribute("data-value", "auto");
  expect(slider).toHaveAttribute("data-adjustable", "true");
  fireEvent.change(slider, { target: { value: "3" } });
  expect(slider).toHaveAttribute("data-value", "high");
  expect(screen.getByRole("status", { name: "Reasoning selection" })).toHaveTextContent("High");
  ```

  Also render a route with `control: "fixed"` and assert `data-adjustable="false"`, the native slider is disabled, and the truthful title remains present.

- [ ] **Step 2: Run the focused test to verify RED**

  Run `pnpm --filter @morrow/web test -- src/features/chat/chat-composer.test.tsx`.

  Expected: the new assertions fail because the data attributes and live output do not exist yet.

- [ ] **Step 3: Implement the selected-state seam**

  In `ReasoningSlider`, derive the existing normalized option label once, render the root attributes, and add:

  ```tsx
  <output aria-live="polite" className="morrow-reasoning-slider__value" aria-label="Reasoning selection">
    {options[selectedIndex]?.label ?? "Auto"}
  </output>
  ```

  Keep `aria-valuetext` on the input and keep the input's `disabled`, `min`, `max`, and `value` semantics unchanged.

- [ ] **Step 4: Add the premium visual treatment**

  In `app.css`, animate the fill width and the selected output with the shared motion tokens. Add a restrained focus halo around the thumb and a selected track highlight. Keep static routes readable by dimming only the track interaction affordance, not the option label.

- [ ] **Step 5: Run the focused test to verify GREEN**

  Run the same Vitest command. Expected: all composer tests pass, including normalized DeepSeek submission and existing draft/submit behavior.

---

### Task 3: Make model selection and action controls feel deliberate

**Files:**
- Modify: `apps/web/src/features/chat/model-picker.tsx`
- Test: `apps/web/src/features/chat/model-picker.test.tsx`
- Modify: `apps/web/src/app/app-shell.tsx` only if a data attribute is needed for an existing state
- Modify: `apps/web/src/styles/app.css`

**Interfaces:**
- `ModelPicker` keeps its current `value`, `onChange`, `models`, `presets`, and availability behavior.
- The panel remains keyboard reachable and does not change URL, provider routing, or model availability semantics.

- [ ] **Step 1: Write the failing model picker state test**

  Add a test that opens the picker, asserts `data-open="true"` on the trigger/panel, selects a connected model, and asserts the trigger exposes the selected route marker while the panel closes. Keep the existing test that unavailable models remain disabled.

- [ ] **Step 2: Run the focused test to verify RED**

  Run `pnpm --filter @morrow/web test -- src/features/chat/model-picker.test.tsx`.

  Expected: the new state-attribute assertions fail.

- [ ] **Step 3: Implement state attributes without changing the picker state machine**

  Add `data-open={open ? "true" : "false"}` to the trigger, `data-selected={selected ? "true" : "false"}` to `ModelPickerOption`, and `data-open="true"` to the mounted panel. Preserve `aria-expanded`, `aria-pressed`, disabled routes, focus search, and Escape handling.

- [ ] **Step 4: Add control transitions**

  Style the trigger, options, selected check, panel, conversation actions, nav links, and activity summaries with the shared timing/easing tokens. Use opacity/translate for panel entry, subtle border/contrast for selection, and a pressed transform of zero so controls never appear to drift.

- [ ] **Step 5: Run the focused test to verify GREEN**

  Run the model picker test file and the existing app-shell test file. Expected: all pass without changing visible accessible labels.

---

### Task 4: Polish the reasoning and activity timelines without log noise

**Files:**
- Modify: `apps/web/src/features/chat/reasoning-disclosure.tsx`
- Test: `apps/web/src/features/chat/reasoning-disclosure.test.tsx`
- Modify: `apps/web/src/features/chat/activity-panel.tsx` only if an existing state needs a stable data attribute
- Modify: `apps/web/src/styles/app.css`

**Interfaces:**
- `ReasoningDisclosure` retains provider-supplied-only behavior, opt-in fetching, chronological sorting, latest-step auto-open, follow-latest scrolling, and jump-to-latest behavior.
- Activity data remains the server-projected `WebConversationActivityEntry` allow-list; no raw provider reasoning or private arguments are added.

- [ ] **Step 1: Write the failing timeline-state test**

  Extend the current disclosure tests to assert the latest article has `data-latest="true"`, the newest open article has `data-open="true"`, and clicking Step 1 changes its state to `data-open="true"` while Step 2 remains available.

- [ ] **Step 2: Run the focused test to verify RED**

  Run `pnpm --filter @morrow/web test -- src/features/chat/reasoning-disclosure.test.tsx`.

  Expected: the new data-attribute assertions fail.

- [ ] **Step 3: Add stable state attributes and active-stream state**

  Add `data-open`, `data-latest`, and `data-streaming` attributes to each reasoning entry. Keep the existing React `Set` state and query behavior. Do not add per-frame state or timers.

- [ ] **Step 4: Add bounded reveal motion**

  Add a finite entry reveal and a low-amplitude active marker pulse only for the newest streaming step. Retain the existing grid-row content expansion and reduced-motion override. Add `will-change` only to the short-lived marker/entry transition if browser QA shows it is necessary; remove it if it stays applied at rest.

- [ ] **Step 5: Run focused tests and browser state checks**

  Run the disclosure test file, then in Browser click an older reasoning step, scroll away from latest, confirm “Jump to latest” appears, and activate it. Expected: expansion, scroll-follow state, and latest focus all remain functional.

---

### Task 5: Project efficiency evidence from the existing authoritative run

**Files:**
- Modify: `services/orchestrator/src/acceptance/flagship-runner.ts`
- Modify: `benchmarks/harness-economics/metrics.ts`
- Modify: `services/orchestrator/test/harness-economics.test.ts`
- Modify: `services/orchestrator/test/flagship-build.test.ts` only if the extended persisted shape requires a fixture update

**Interfaces:**
- `FlagshipRun` retains all existing fields and adds numeric evidence fields: `providerCalls`, `cachedPromptTokens`, `duplicateObservations`, `contextCompactions`, `recoveryAttempts`, and `interventions`.
- `BenchmarkRecord` accepts the same optional counters; absent values remain absent/unknown rather than becoming zero by inference.
- `HarnessSummary` adds medians for available counters while the existing three-panel SVG remains pass rate/cost/time.

- [ ] **Step 1: Write failing metric tests**

  Add records with explicit counters and assert the summary reports their medians. Add a record with missing counters and assert the corresponding summary values are `null`, not `0`. Add a negative-counter record and assert parsing rejects it with a field-specific error.

- [ ] **Step 2: Run the benchmark test to verify RED**

  Run `pnpm --filter @morrow/orchestrator test -- test/harness-economics.test.ts`.

  Expected: TypeScript/expectation failures because the new fields do not exist.

- [ ] **Step 3: Implement explicit counter parsing and median aggregation**

  Add a shared non-negative integer reader in `metrics.ts`. For each optional counter, map an absent/null field to `null` in summary aggregation only when at least one record provides the field; do not synthesize a zero for records that omit it. Keep measured-cost precedence and current SVG output unchanged.

- [ ] **Step 4: Project counters from persisted events in `flagship-runner.ts`**

  Count `provider.usage` events for `providerCalls`; sum `cachedInputTokens` only when the event reports a numeric value; count `workspace.inspected` events whose payload has `duplicate: true`; count `context.compaction_completed`, `provider_recovery_required`, and `approval.requested` events for the remaining counters. Preserve the existing `FlagshipRun` failure classification and append-only evidence behavior.

- [ ] **Step 5: Run the benchmark and flagship deterministic tests**

  Run `pnpm --filter @morrow/orchestrator test -- test/harness-economics.test.ts test/flagship-build.test.ts`.

  Expected: all pass, with no provider calls.

---

### Task 6: Run deterministic verification and rendered visual QA

**Files:**
- No new product files; use the changed files from Tasks 1–5
- Temporary screenshots/logs: outside the repository, or Browser/IAB emitted images only

**Interfaces:**
- Browser flow under test: source-dev `/app/projects` → active Morrow project → `/app/chats` → fresh conversation → select DeepSeek V4 Pro → change reasoning level → open model picker → verify controls and console.

- [ ] **Step 1: Run focused web tests**

  Run:

  ```powershell
  pnpm --filter @morrow/web test -- src/features/chat/chat-composer.test.tsx src/features/chat/model-picker.test.tsx src/features/chat/reasoning-disclosure.test.tsx src/app/app-shell.test.tsx
  ```

  Expected: all focused tests pass.

- [ ] **Step 2: Run web check/build**

  Run `pnpm --filter @morrow/web check` and `pnpm --filter @morrow/web build`.

  Expected: both pass.

- [ ] **Step 3: Start the source web and repo orchestrator services**

  Use the repository's existing `pnpm --filter @morrow/web dev --host 127.0.0.1 --port 4318` and `pnpm --filter @morrow/orchestrator start` processes, verifying the exact PIDs/commands before leaving them running for QA. Do not stop unrelated installed Morrow processes.

- [ ] **Step 4: Exercise the desktop browser flow**

  Confirm page identity and non-blank content, select DeepSeek V4 Pro, inspect `aria-valuetext`, move the slider to High, open/close the model picker, toggle Trusted workspace, and confirm no framework overlay. Capture a desktop screenshot.

- [ ] **Step 5: Exercise the mobile layout and reduced-motion state**

  Check a mobile-sized viewport, confirm the composer wraps without clipping, the picker remains within the viewport, and all touch targets remain usable. Enable reduced-motion through the Browser accessibility/emulation path when available and confirm the same state changes occur without visible movement.

- [ ] **Step 6: Check console health and visual mismatch ledger**

  Read Browser console warnings/errors. Record five comparison points: composer focus, slider state, picker entry/selection, reasoning timeline reveal, and shell/action hover/selected state. Fix any material mismatch before proceeding.

---

### Task 7: Run the bounded live efficiency comparison

**Files:**
- Read: `benchmarks/harness-economics/README.md`
- Read: `docs/benchmark-plan.md`
- Append only through existing live-run machinery: `docs/evidence/flagship-runs.jsonl` if the selected scenario requires it
- Temporary record/report: outside the repository unless the user explicitly asks to keep it

**Interfaces:**
- Input records must identify harness, exact model/provider, task id, pass definition, duration, usage/cost source, and the optional efficiency counters from Task 5.
- The API budget is capped at the last `$1` the user authorized. Stop if the provider reports insufficient balance, auth failure, repeated no-output, or if the run cannot yield a comparable record.

- [ ] **Step 1: Preflight availability without inspecting credentials**

  Verify the repo runtime, current branch, running service identity, provider route availability through the existing API, and whether Hermes/Pi comparison commands or fixtures exist locally. Do not print environment variables or secrets.

- [ ] **Step 2: Run one serialized Morrow task set**

  Use the existing deterministic task fixtures first, then one small live DeepSeek task set if the route is configured. Keep the same model, prompt, project fixture, permissions, and pass definition for every run. Record raw outcome, counters, token usage, cost source, and limitations.

- [ ] **Step 3: Run a comparable baseline only when actually available**

  If Hermes/Pi is installed and can run the same fixture without new credentials or an unapproved external side effect, run the same task set once. Otherwise report the baseline as unavailable and do not infer superiority from Morrow-only results.

- [ ] **Step 4: Render and inspect the benchmark artifact**

  Run the standalone renderer with the captured records and inspect the resulting SVG outside the repo. Verify missing costs remain `n/a`, the three panels render, and the JSON summary includes the efficiency counters.

- [ ] **Step 5: Report the evidence boundary**

  State exact model/provider, task count, pass definition, measured/estimated cost, median time, provider/tool/duplicate/recovery counts, whether the comparison was comparable, and what remains unproven. Do not call a narrow run a general harness superiority claim.

---

## Final verification commands

After all tasks, run the focused suites again followed by:

```powershell
pnpm test
pnpm check
pnpm build
git diff --check
```

Expected: deterministic repository checks pass. Any live-provider failure is reported separately from deterministic verification and does not get hidden by rerunning until green.
