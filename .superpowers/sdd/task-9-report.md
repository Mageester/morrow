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

## Final Verification

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

## Accessibility Review

- Task 8's persistent `tablist`, tabs, tabpanels, roving keyboard controls,
  and hidden inactive panels are retained unchanged.
- Work/Result headings proceed from their section `h2` to artifact-frame `h3`
  titles; the public frame supports semantic levels 2 through 6.
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
