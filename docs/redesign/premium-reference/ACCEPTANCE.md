# Premium UI implementation acceptance

## Visual fidelity

- Render each mapped route at 1600 by 1000 and compare it to the corresponding desktop image.
- Render Home and Chat at 390 by 844 and compare them to the mobile images.
- Match the shell geometry, content width, typography hierarchy, surface colors, borders, radii, shadows, density, and copper emphasis.
- Do not replace editorial layouts with generic card grids, tables, dashboard metrics, or off-the-shelf component-library defaults.
- Any intentional visual deviation must be documented with a functional, accessibility, or platform reason and approved before landing.

## Functional preservation

- Existing routing, persistence, provider configuration, server-side credentials, task execution, streaming, recovery, memory controls, permissions, pairing, and project isolation continue to work.
- No secret, credential, provider token, private message, or unrestricted filesystem path enters browser storage or browser-visible payloads.
- Existing honest state language remains accurate. Never turn unknown cost, provider state, or verification into a fabricated success value.
- Destructive operations preserve existing confirmation and reversibility boundaries.

## Accessibility

- Keyboard navigation reaches every control in logical order.
- Focus-visible treatment is unambiguous on every surface.
- Text and controls meet WCAG 2.2 AA contrast requirements.
- Dynamic status uses appropriate live-region semantics without announcing decorative changes.
- Icon-only controls have accessible names.
- Reduced-motion behavior follows `MOTION_AND_RESPONSIVE.md`.

## Verification commands

At minimum run:

```powershell
pnpm test
pnpm check
pnpm build
node docs/redesign/premium-reference/capture.mjs
git diff --check
```

Also run focused route and component tests for every modified production file. Capture production screenshots separately; the static reference screenshots are design evidence, not proof that the production app matches.

## Rollback

Keep the redesign presentation-only until functional parity is demonstrated. If a feature flag exists, retain the prior shell behind it until acceptance passes. Do not migrate or rewrite authoritative backend data solely for this redesign.
