# Task 9 Report — Adaptive Work and Verified Results

## Scope

Implemented the browser-safe Work and Result mission views:

- a complete typed artifact renderer registry with a metadata fallback for an
  unexpected runtime kind;
- shared `ArtifactFrame` presentation for every artifact kind, with safe text
  previews only;
- Result hierarchy for verification state, summary, deliverables, evidence,
  caveats, and honest unavailable actions;
- Work and Result wiring within the existing stable Task 8 tabpanels;
- an optional `ArtifactFrame` heading level to preserve heading order when a
  frame appears below a Work or Result section heading.

No contract, controller, stream, attention, permissions, path-opening, or
external-data behavior changed.

## TDD Evidence

### RED

Before production components existed:

```powershell
pnpm --filter @morrow/web test -- work-tab.test.tsx result-tab.test.tsx
pnpm --filter @morrow/ui test -- components.test.tsx
```

Observed expected failures:

- both web suites could not resolve the absent `work-tab.js` and
  `result-tab.js` modules;
- the new public `ArtifactFrame headingLevel={3}` test failed because the
  frame still rendered an `h2` and forwarded the unknown prop to the DOM.

The focused Work/Result tests were then green after the minimum renderer,
result, wiring, and heading-level implementation.

A second RED→GREEN regression covered unknown MIME metadata:

```powershell
pnpm --filter @morrow/web test -- work-tab.test.tsx
```

With a whitespace-only MIME string, the test failed because metadata displayed
blank text instead of `Unknown format`. The implementation now trims MIME
metadata before applying the safe fallback; the same focused test passed
afterward.

## Historical Final Verification

This evidence records the initial Task 9 delivery. The later review fixes and
the current accessibility follow-up below supersede its rendered heading and
preview details.

```text
pnpm --filter @morrow/web test -- mission-page.test.tsx work-tab.test.tsx result-tab.test.tsx
PASS — 3 files, 16 tests

pnpm --filter @morrow/web test
PASS — 8 files, 62 tests

pnpm --filter @morrow/ui test
PASS — 1 file, 14 tests

pnpm --filter @morrow/web check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/ui check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/web build
PASS — Vite production build

Test-Path apps/web/dist/index.html
PASS — True

pnpm --filter @morrow/ui build
PASS — tsc -p tsconfig.build.json

git diff --check 22a24b88cce90f26182cede95774ba804163a3bd
PASS — no whitespace errors
```

## Security and Privacy Review

- Artifact preview and caveat strings are rendered as React text nodes. There
  is no `dangerouslySetInnerHTML`, HTML parsing, iframe, script, macro,
  dynamic import, arbitrary fetch, or content execution path.
- `openPath` is intentionally not rendered as a link or action. The current
  browser projection offers no authorized open/download/share contract.
- The renderer uses an allowlisted registry for all declared artifact kinds and
  uses the same metadata/text-only fallback when a malformed runtime kind
  reaches the component.
- Unknown, null, and whitespace MIME values render the explicit `Unknown
  format` fallback; preview absence is also visible rather than inferred.
- No credentials, browser storage, telemetry, network request, permission
  change, or external data flow was added.

## Historical Accessibility Review

- Task 8's persistent `tablist`, tabs, tabpanels, roving keyboard controls,
  and hidden inactive panels are retained unchanged.
- The initial slice used a shared frame heading API; later fixes establish the
  current Work `h2` → `h3` and Result `h2` → `h3` → `h4` hierarchy below.
- Artifact frames remain named regions through their title; result sections
  use explicit headings and caveats are always present in the visible DOM,
  never hidden in a disclosure.
- Safe previews preserve whitespace, wrap long unbroken text, and have a
  bounded scroll area instead of forcing horizontal page overflow.

## Limitations

- The current contract does not expose a verified artifact authorization URL,
  download token, share action, version history, or itemized verification
  criteria. The UI correctly does not fabricate them.
- Artifact previews are limited to the projected text field. Rich file,
  browser, office, or binary previews remain outside this safe slice.
- The Result view can only report the supplied verification state, summary,
  evidence count, and caveats; it does not infer success from mission status.

## Rollback

Revert `feat(web): add adaptive work and verified results`. This restores the
Task 8 Work/Result placeholders and removes only Task 9 components, tests,
styles, report, and the artifact-frame heading-level extension. Contracts,
server projection, streaming, approvals, and permissions remain unchanged.

---

## Review-Fix Pass — Truthful Result and Artifact Semantics

### Scope

This follow-up corrects Task 9 review findings without changing the browser
contract, controller, stream, attention behavior, permissions, or artifact
actions:

- Result labels now use an explicit mission-state × verification mapping.
  Non-completed states retain their known projected outcome, and `Completed
  and verified` appears only for `completed_verified` plus `passed`.
- Result summaries and caveats are trimmed. Empty summaries use an explicit
  fallback, and a caveated verification or completion state without usable
  caveat details visibly reports that omission.
- Artifact titles normalize to `Untitled artifact`; artifact list keys include
  ID, version, and index to avoid duplicate-key identity collisions.
- Text previews are keyboard-focusable named scroll containers.
- Result heading hierarchy is `h2` result, `h3` subsections, and `h4`
  deliverable artifact titles. Work remains `h2` then `h3` artifacts.

### RED Evidence

Before the follow-up implementation:

```powershell
pnpm --filter @morrow/web test -- work-tab.test.tsx result-tab.test.tsx
```

Expected failures were observed:

- 54 Result cases failed because verification labels replaced known draft,
  input-needed, working, reviewing, blocked, failure, cancelled, and
  superseded mission outcomes; completed states also lacked the requested
  explicit mapping.
- Result hierarchy rendered sections as `h2` and artifact titles as `h3`.
- Empty/whitespace summaries and caveats remained blank, including an invalid
  `Completed with caveats` plus `No caveats were reported` pairing.
- Work emitted React's duplicate-key warning for equal artifact IDs, retained
  whitespace-only titles, and exposed no focusable labelled preview.

### GREEN and Final Evidence

```text
pnpm --filter @morrow/web test -- work-tab.test.tsx result-tab.test.tsx
PASS — 2 files, 62 tests

pnpm --filter @morrow/web test -- mission-page.test.tsx work-tab.test.tsx result-tab.test.tsx
PASS — 3 files, 72 tests

pnpm --filter @morrow/web test
PASS — 8 files, 118 tests

pnpm --filter @morrow/ui test
PASS — 1 file, 14 tests

pnpm --filter @morrow/web check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/ui check
PASS — tsc -p tsconfig.json

pnpm --filter @morrow/web build
PASS — Vite production build

Test-Path apps/web/dist/index.html
PASS — True

pnpm --filter @morrow/ui build
PASS — tsc -p tsconfig.build.json
```

### Security and Accessibility

- Normalization operates on already-projected strings and preserves React text
  rendering; it introduces no execution, URL, file, or network path.
- The earlier native `pre` focus treatment is superseded by the current
  focusable preview region described below.
- The complete table-driven result test covers every `WebMissionUiState` with
  every verification state for non-completed outcomes and every verification
  state for both completed outcomes.

### Rollback

Revert `fix(web): preserve truthful result and artifact semantics` to remove
only this corrective pass. The original Task 9 artifact/result slice remains
available; no data, permission, external-flow, or server rollback is needed.

---

## Accessibility Follow-up — Named Artifact Preview Regions

### RED Evidence

```powershell
pnpm --filter @morrow/web test -- work-tab.test.tsx
```

The updated accessibility test failed as expected because the current preview
was an `aria-label`led `pre`, not the required focusable named `region`.

### GREEN and Final Evidence

The preview now uses a focusable `div role="region"` named `Preview of
<artifact title>`. Its inner `pre` contains only text and has no accessible
name or tab stop. Scroll bounds, overflow, and visible focus styling reside on
the region.

```text
pnpm --filter @morrow/web test -- work-tab.test.tsx result-tab.test.tsx
PASS — 2 files, 62 tests
```

### Current Accessibility and Truth Semantics

- Work uses a semantic `h2` followed by `h3` artifact titles. Result uses an
  `h2` delivery state, `h3` subsections, and `h4` primary artifact titles.
- The Result component consumes the projected mission state alongside
  verification state, so a known working, blocked, failed, cancelled, or
  superseded outcome cannot be upgraded to a generic completion label.
- Preview strings remain plain React text inside `pre`; the focusable wrapper
  adds no content execution, URL, or action capability.

### Rollback

Revert `fix(web): expose accessible artifact previews` to restore the prior
Task 9 preview markup only. The artifact registry, Result truth mapping, and
all server-side boundaries remain unchanged.
