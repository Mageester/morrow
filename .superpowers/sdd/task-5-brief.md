# Task 5 Brief — Morrow Design-System Package

Base: `ea98699`

## Goal

Extend the existing `packages/ui` package (currently only `README.md`) into the reusable, accessible Morrow design-system foundation. Do not delete or overwrite the existing README without preserving its accurate guidance.

## Owned files

- `packages/ui/**`
- `pnpm-lock.yaml`

Do not modify files outside this ownership.

## Required package

Create package metadata and TypeScript configs matching repository workspace patterns. Package name: `@morrow/ui`; private ESM package; exports for `.` and `./styles.css`; `check`, `test`, and `build` scripts.

Add only dependencies required by this task: React, React DOM, Radix Slot/Dialog where used, clsx, TypeScript, Vitest, Testing Library, jest-dom, React type packages, and jsdom. Keep exact versions compatible with current workspace lockfile.

## Required foundations

- `src/styles/tokens.css`: approved light-first tokens and global `[data-theme="dark"]` overrides from plan.
- `src/styles/global.css`: accessible global base styles; visible focus; reduced-motion override for every motion declaration.
- Reusable exported components: `Button`, `Surface`, `StatusPill`, `EmptyState`, `ErrorCard`, `ProgressSteps`, `Timeline`, `ArtifactFrame`.
- Semantic variants only; no product-specific raw color props.
- Icon-only controls, if any, require accessible names.
- Keep product-specific composition out of package.

## Required behavior and tests

Use strict TDD: write each failing test, observe expected failure, then add minimum implementation.

At minimum prove:

- `Button` renders an accessible primary action named `Start mission`.
- `ErrorCard` explains preserved work, lists attempted recovery, and exposes recommended action as an accessible button.
- Status, progress, timeline, empty-state, surface, and artifact primitives render semantic content and accessible structure.
- Component APIs preserve ordinary React props where appropriate.

Run:

```powershell
pnpm --filter @morrow/ui test
pnpm --filter @morrow/ui check
pnpm --filter @morrow/ui build
```

## Constraints

- Calm, minimal, premium, light-first; optional global dark mode only.
- WCAG 2.2 AA target: keyboard use, visible focus, semantic names, contrast, reduced motion, mobile-safe targets.
- No secrets, telemetry, external inference, hosted dependencies, or unrelated refactors.
- Reuse existing repo package conventions. Smallest coherent implementation.

## Delivery

Write `.superpowers/sdd/task-5-report.md` with RED/GREEN evidence, exact final commands/results, file summary, self-review, privacy/security impact, known limitations, and rollback. Commit owned implementation files plus report with Conventional Commit message `feat(ui): add Morrow design-system foundation`.
