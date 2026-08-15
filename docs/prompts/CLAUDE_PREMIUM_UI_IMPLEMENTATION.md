# Claude prompt: implement the Morrow premium UI reference

You are taking ownership of a full visual refresh of the Morrow web application. This is an implementation task, not an invitation to invent a different design.

## Read before editing

Read these files completely and inspect every referenced image:

1. `AGENTS.md`
2. `README.md`
3. `docs/design-principles.md`
4. `docs/redesign/premium-reference/README.md`
5. `docs/redesign/premium-reference/reference.css`
6. `docs/redesign/premium-reference/reference.js`
7. `docs/redesign/premium-reference/MOTION_AND_RESPONSIVE.md`
8. `docs/redesign/premium-reference/ACCEPTANCE.md`
9. `docs/redesign/premium-reference/shots/manifest.json`
10. Every PNG under `docs/redesign/premium-reference/shots/`

The screenshots define the intended rendered result. The HTML/CSS/JavaScript reference defines measurable layout and hierarchy. Treat them as an implementation contract, not mood-board inspiration. Do not reinterpret the design, substitute a generic component-library look, simplify away its editorial composition, or reintroduce dashboard-card clutter.

## Required result

Implement the premium charcoal-and-copper visual system across the real Morrow application while preserving every existing user capability and privacy boundary.

Map the references as follows:

- Home reference to `/app`
- Chat reference to `/app/chats/:conversationId`
- Projects reference to `/app/projects`
- Memory reference to `/app/memory`
- Skills reference to `/app/skills`
- History reference to `/app/chats`
- Connections reference to `/app/connections`
- Settings reference to `/app/settings`

Missions, Teams, pairing, onboarding, empty states, approvals, recovery, errors, dialogs, and responsive navigation must inherit the same token system and component grammar. Preserve the onboarding quality bar; do not regress it.

## Non-negotiable visual rules

- Preserve the framed charcoal application shell, warm-white typography, restrained copper illumination, subtle green health states, fine borders, and deliberate editorial serif hierarchy.
- Use one clear primary action per context. Routine actions stay neutral. Destructive actions appear only after deliberate intent.
- Keep information dense when useful but never cramped. Use progressive disclosure for details and advanced controls.
- Chat is an editorial conversation workspace, not a stack of generic bubbles. The live-work rail must remain contextual and collapsible.
- Projects are living workspaces, not folders or a card dashboard.
- Memory is a curated, traceable private library.
- Skills show method, provenance, and proof; they must not resemble an extension marketplace.
- History leads with outcomes and decisions rather than transcript titles.
- Connections use compact provider rows and expandable detail rather than enormous stacked cards.
- Settings use focused chapters rather than an endless wall of forms.
- Do not add gradients, glass, glow, animation, or decorative elements beyond what the reference demonstrates.

## Engineering boundaries

- Inspect existing interfaces before creating abstractions.
- Reuse stable production data flows, queries, routes, mutations, error boundaries, permission checks, and server-side secret boundaries.
- Do not modify orchestrator behavior, provider routing, memory semantics, permissions, persistence, or API contracts merely to make the UI easier.
- Do not add telemetry, hosted assets, external fonts, external inference, or silent network calls.
- Keep local-first behavior and provider choice explicit.
- Break shared visual primitives into focused modules with clear interfaces; do not create a single enormous page or stylesheet.
- Add or update tests for every changed behavior and important rendered state.
- Preserve unrelated working-tree changes. Work on a dedicated branch and commit focused slices using Conventional Commits.

## Execution order

1. Inventory real routes, components, tests, live states, and protected boundaries.
2. Define shared tokens and shell primitives first.
3. Implement Home and Chat as the vertical visual slice, including desktop and mobile states.
4. Verify functional parity, accessibility, and screenshot fidelity before expanding.
5. Implement Projects, Memory, Skills, History, Connections, and Settings in coherent slices.
6. Apply the system to Missions, Teams, pairing, onboarding, empty, loading, approval, recovery, error, and dialog states.
7. Run focused checks after each slice and the complete repository gates before reporting completion.

## Visual verification

For each mapped route:

1. Start the real application with deterministic local data.
2. Capture the production route at the reference viewport.
3. Compare it directly with the corresponding PNG.
4. Correct geometry, type, spacing, color, hierarchy, overflow, focus, and responsive behavior.
5. Record any intentional deviation and its reason.

Do not claim the redesign is complete because components or tests exist. Completion requires rendered, reachable production routes that visibly match the references and retain working behavior.

## Completion evidence

Return:

- changed files grouped by responsibility;
- commands run and exact outcomes;
- production screenshots for every mapped desktop route plus Home and Chat mobile;
- focused and full-suite test results;
- accessibility and reduced-motion results;
- privacy/security impact;
- intentional visual deviations;
- known limitations;
- rollback steps.

Do not release, merge, or deploy until the user has reviewed the rendered production screenshots.
