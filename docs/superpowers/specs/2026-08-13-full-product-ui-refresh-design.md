# Morrow Full Product UI Refresh

**Status:** Approved direction, ready for implementation planning

**Date:** 2026-08-13

**Branch:** `codex/full-product-ui-refresh`

## Objective

Bring every shipped web surface up to the quality, restraint, and emotional tone of Morrow's onboarding. This is a complete visual-system and product-surface redesign, not a cosmetic reskin. Existing product behavior, truthful states, local-first boundaries, and accessibility contracts remain intact.

The finished application should feel like the onboarding continues after the user selects **Open Morrow**.

## Direction

The onboarding is the visual source of truth:

- near-black, warm neutral foundations rather than generic dashboard gray;
- warm clay/copper accents used with restraint;
- editorial display typography paired with precise utility typography;
- large calm compositions with intentional negative space;
- soft atmospheric depth, fine borders, and controlled highlights;
- sculptural visual motifs used as identity, not decoration;
- motion that explains arrival, focus, progress, and state changes;
- direct, human copy with one obvious next action.

The product must remain an AI agent application. It must not resemble an operating system, enterprise admin console, analytics dashboard, or marketing site.

## Considered Approaches

### 1. Cosmetic reskin

Replace colors, radii, and shadows while keeping every layout. Fast, but it preserves the current generic card grid, weak hierarchy, and blocked first impression. Rejected.

### 2. Shell-first refresh

Redesign navigation, Home, and chat while allowing secondary routes to retain their current patterns. This improves the most visible screens but creates another quality seam inside the product. Rejected.

### 3. Unified product system

Extract the onboarding's visual grammar into shared foundations, rebuild the shell and primary workflows, then migrate every route and state onto the same system. This is the selected direction because it produces one coherent product rather than a collection of polished screens.

## Product-Wide Visual System

### Foundations

Create explicit product tokens for:

- layered backgrounds: canvas, rail, elevated field, inset field, active field;
- warm text hierarchy: primary, secondary, quiet, disabled;
- copper accent hierarchy: solid, soft, hairline, glow;
- semantic success, warning, danger, and information states that remain visually compatible with the warm palette;
- display and utility type scales;
- spacing, responsive gutters, content widths, and density modes;
- radii, hairline borders, ambient shadows, and focus rings;
- motion duration and easing for entrance, hover, expansion, progress, and route transitions.

Dark mode is the signature expression. Light mode remains fully supported and uses warm paper-like neutrals rather than plain white. Both modes must meet readable contrast targets.

### Shared Primitives

The redesign will establish reusable primitives instead of route-specific styling:

- `ProductHeader`: eyebrow, title, supporting copy, primary action, optional status;
- `AtmosphericSurface`: layered panel with quiet depth and optional visual motif;
- `ActionField`: large primary input or action region used by Home and chat;
- `SectionFrame`: consistent section rhythm without turning every section into a card;
- `DataRow`: compact, readable rows for projects, chats, memory, skills, providers, and history;
- `StateScene`: loading, empty, blocked, error, and success states with truthful next actions;
- `InspectorPanel`: contextual details for evidence, permissions, sources, costs, and settings;
- `SegmentedControl`, `ChoiceCard`, `QuietButton`, and premium form controls;
- `AmbientMark`: a restrained derivative of the onboarding sculpture language for empty and transition states.

Shared primitives must expose semantic HTML and accessible labels. Visual polish cannot depend on replacing native control behavior with inaccessible custom widgets.

## App Shell

The shell becomes a calm, continuous frame rather than a sidebar beside a dashboard.

- The navigation rail uses quieter grouping, stronger active-state composition, and a refined Morrow identity mark.
- Workspace selection becomes a compact contextual control integrated into the shell header instead of a full-width status strip.
- Runtime and account state move into a deliberate profile/status cluster. Persistent warnings appear only when action is required.
- Search and new-chat actions become premium command surfaces, not generic bordered buttons.
- The content canvas receives route-aware entrance motion and consistent responsive gutters.
- On small screens, the bottom dock and overlay navigation use the same materials and motion as desktop.

The shell must preserve keyboard navigation, the skip link, focus restoration after route changes, runtime truth, and honest account-pairing language.

## Home

Home becomes the clearest expression of the new product system.

- Replace the oversized bordered hero and disabled central CTA with a composed welcome field that adapts to readiness.
- With a project ready, the primary object is a generous conversational action field: “What should we work on?”
- Without a project or model, the same area becomes an elegant setup scene with one next action and visible progress. It must never present a dead primary button.
- Recent conversations and active missions become editorial rows and timelines with meaningful metadata, not repeated cards.
- Setup tasks collapse into a refined readiness path. Required work is visually distinct from optional enhancements.
- Empty space carries atmosphere through a subtle Morrow motif; it does not carry decorative dashboard widgets.

## Conversation Workspace

Chat should feel like Morrow's core instrument.

- Messages use a readable editorial column with restrained role distinction. Assistant content is not trapped in chat bubbles.
- The composer becomes a floating, layered command surface with model, reasoning, attachment/tool, and send controls organized by frequency.
- Streaming state, reasoning disclosure, tool activity, approvals, and mission progress animate into place without shifting the reading position unexpectedly.
- Evidence, costs, sources, permissions, and task details live in a contextual inspector that can open without overwhelming the conversation.
- Conversation actions, rename/delete dialogs, autoscroll state, and errors inherit the same visual system.
- Long technical output remains dense and scannable; visual polish must not reduce information fidelity.

## Projects, History, Missions, Memory, Skills, Teams, Connections, Settings, and Pairing

Every route receives a composed header, intentional content width, consistent state treatment, and route-specific hierarchy.

- **Projects:** local workspaces as calm rows with path, active state, and clear switching/creation actions.
- **History:** conversation index with strong search/filter rhythm and useful date/project context.
- **Missions:** active work as progress-led sequences with clear blocked, reviewing, verified, and failed states.
- **Memory:** a personal knowledge ledger; memory content leads, provenance and lifecycle details disclose progressively.
- **Skills:** a refined library of learned procedures with trust, evidence, and usage visible without dense dashboard chrome.
- **Teams:** named specialists shown as a purposeful working arrangement, including role, scope, tools, and handoffs.
- **Connections:** providers grouped by readiness and type, with configuration actions and honest credential/routing status.
- **Settings:** replace inline-styled form grids with coherent sections and premium controls; preserve exact privacy caveats.
- **Pairing:** focused single-purpose flow with clear local-versus-hosted consequences.

## States and Feedback

Every major data surface must define:

- initial loading and background refresh;
- empty and first-use state;
- recoverable error with retry;
- stale data with non-blocking warning;
- disabled action with an adjacent reason;
- active, blocked, awaiting approval, failed, completed, and verified execution states where applicable.

Skeletons and progress indicators use subtle opacity and light movement. Error treatment remains calm but unmistakable. Success appears as confirmation, not celebration theater.

## Motion

Motion follows the onboarding's controlled pacing:

- route content enters with short opacity/translation choreography;
- panels expand from their trigger context;
- active indicators glide rather than flash;
- streaming and task progress use low-amplitude, continuous cues;
- hover effects use highlight and depth rather than scaling entire cards;
- all non-essential animation is disabled under `prefers-reduced-motion`;
- no animation delays access to controls or truthful state.

## Responsive Behavior

The redesign covers desktop, tablet, and phone layouts.

- Desktop prioritizes a stable reading canvas and optional inspector.
- Tablet reduces rail width and collapses secondary metadata before primary content.
- Phone uses a compact top identity bar, bottom navigation, full-width action fields, and sheet-based secondary controls.
- No horizontal scrolling is permitted for ordinary content at 320 CSS pixels. Technical code/data surfaces may scroll within their own bounded region.

## Architecture and Change Boundaries

- Keep React, TanStack Router/Query, the existing API contracts, and the orchestrator as the authoritative state source.
- Concentrate foundational visual changes in the shared UI package and `apps/web/src/styles/app.css`.
- Split oversized page-level presentation into focused components when that makes the visual system reusable and testable.
- Remove route-local inline styling when the route is migrated.
- Do not change provider routing, permissions, memory semantics, persistence, billing, telemetry, or network behavior as part of this redesign.
- Preserve existing user-facing truthfulness fixes, especially privacy-preference wording.

## Verification

### Automated

- Existing web tests remain green.
- Add or update tests for altered navigation, readiness actions, dialogs, responsive semantics, and accessible state labels.
- Run `pnpm check`, `pnpm test`, and `pnpm build` before completion.
- Run `git diff --check` and the release packaging contract when preparing a beta.

### Visual

Capture and inspect, at minimum:

1. fresh install Home after onboarding;
2. ready Home with a project and provider;
3. empty conversation and active streaming conversation;
4. conversation with mission activity and contextual inspector;
5. Projects, History, Memory, Skills, Connections, and Settings;
6. one recoverable error state and one blocked/approval state;
7. desktop, tablet, phone, dark mode, light mode, and reduced motion.

Visual acceptance is based on the rendered product, not component tests alone.

## Acceptance Criteria

1. Exiting onboarding into Home feels like entering the same product: palette, type, depth, copy, motion, and control quality are continuous.
2. Every shipped `/app` route uses the new shared visual system; no route retains the old generic dashboard/card treatment.
3. Home never leads with a disabled primary CTA. The next useful action is obvious in every readiness state.
4. Conversation reading and composing are visibly first-class and remain fully functional during streaming, approvals, errors, and long output.
5. Loading, empty, stale, blocked, error, success, and verified states are coherent and truthful across routes.
6. Dark/light themes, keyboard use, focus visibility, reduced motion, and phone layouts are verified.
7. No privacy, provider, permission, memory, billing, or network claim becomes broader than the implemented behavior.
8. The final candidate is exercised from a clean packaged profile before release.

## Delivery Shape

Implementation is one coordinated product transformation delivered in reviewable commits:

1. visual foundations and shared primitives;
2. shell and responsive navigation;
3. Home and readiness experience;
4. conversation workspace and inspector;
5. secondary routes and all shared states;
6. accessibility, responsive, motion, and visual QA;
7. release evidence and beta packaging.

The commits are sequential parts of one redesign. No partial slice should be released as the finished refresh.
