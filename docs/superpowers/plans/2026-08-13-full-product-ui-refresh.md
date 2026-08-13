# Full Product UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every shipped Morrow web surface feel like a continuous extension of the onboarding experience.

**Architecture:** Extract onboarding's visual grammar into a product-wide CSS layer and a small set of semantic React primitives, then migrate the shell, Home, chat, and secondary routes onto those foundations. Keep TanStack Router/Query, API contracts, and all local-first behavior unchanged; verify presentation through component tests and clean-profile browser captures.

**Tech Stack:** React 19, TypeScript, TanStack Router/Query, Lucide icons, Vitest, Testing Library, Vite, CSS custom properties and responsive media queries.

## Global Constraints

- The onboarding is the source of truth for palette, typography, depth, spacing, controls, copy tone, and motion.
- Redesign every shipped `/app` route; do not leave an old dashboard-style route behind.
- Preserve all provider, privacy, permission, memory, billing, persistence, and network behavior.
- Home must never lead with a disabled primary action.
- Preserve keyboard navigation, visible focus, reduced motion, 320 CSS pixel support, dark and light themes.
- Retain exact truthful privacy-preference caveats.
- Do not add telemetry, hosted dependencies, or a broad component framework.
- Do not release a partial slice as the finished redesign.

---

### Task 1: Product foundations and semantic primitives

**Files:**
- Create: `apps/web/src/styles/product-refresh.css`
- Create: `apps/web/src/components/product-frame.tsx`
- Create: `apps/web/src/components/product-frame.test.tsx`
- Modify: `apps/web/src/main.tsx`

**Interfaces:**
- Consumes: existing theme attributes and `--morrow-*` variables from `apps/web/src/styles/app.css`.
- Produces: `ProductHeader`, `SectionFrame`, `StateScene`, and `AmbientMark` React components; product-wide `--morrow-product-*` tokens and `.morrow-product-*` classes.

- [ ] **Step 1: Write the failing primitive tests**

```tsx
render(<ProductHeader eyebrow="Local intelligence" title="Memory" description="Things Morrow remembers." />);
expect(screen.getByRole("heading", { name: "Memory", level: 1 })).toBeVisible();
expect(screen.getByText("Local intelligence")).toBeVisible();

render(<StateScene action={<a href="/app/projects">Choose project</a>} title="A project gives Morrow context" description="Choose a local workspace." />);
expect(screen.getByRole("link", { name: "Choose project" })).toBeVisible();
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `pnpm --filter @morrow/web test -- product-frame.test.tsx`

Expected: FAIL because `product-frame.tsx` does not exist.

- [ ] **Step 3: Implement semantic primitives**

Implement exact exports:

```tsx
export function AmbientMark({ variant = "orb" }: { variant?: "orb" | "arc" }): JSX.Element;
export function ProductHeader(props: { eyebrow?: string; title: string; description?: string; action?: ReactNode; status?: ReactNode }): JSX.Element;
export function SectionFrame(props: { children: ReactNode; className?: string; label?: string }): JSX.Element;
export function StateScene(props: { title: string; description: string; action?: ReactNode; tone?: "quiet" | "error" | "success"; children?: ReactNode }): JSX.Element;
```

Add a post-`app.css` import in `main.tsx`:

```ts
import "./styles/product-refresh.css";
```

Define warm canvas, rail, field, text, copper, semantic, radius, shadow, content-width, and motion tokens for dark and light themes. Include global typography smoothing, selection color, focus ring, route entrance, buttons, inputs, surfaces, skeletons, and `prefers-reduced-motion` overrides.

- [ ] **Step 4: Run the focused test and web typecheck**

Run: `pnpm --filter @morrow/web test -- product-frame.test.tsx`

Run: `pnpm --filter @morrow/web check`

Expected: PASS.

- [ ] **Step 5: Commit the foundations**

```powershell
git add -- apps/web/src/main.tsx apps/web/src/styles/product-refresh.css apps/web/src/components/product-frame.tsx apps/web/src/components/product-frame.test.tsx
git commit -m "feat(web): establish onboarding-led product system"
```

### Task 2: Continuous app shell and responsive navigation

**Files:**
- Modify: `apps/web/src/app/app-shell.tsx`
- Modify: `apps/web/src/app/app-shell.test.tsx`
- Modify: `apps/web/src/styles/product-refresh.css`

**Interfaces:**
- Consumes: `AmbientMark` and product tokens from Task 1; existing `useRuntimeStatus`, `useActiveProject`, `CommandPalette`, and `NewChatButton` behavior.
- Produces: `.morrow-shell-*` semantic regions; compact workspace control; profile/runtime cluster; route canvas.

- [ ] **Step 1: Add failing shell behavior tests**

```tsx
expect(screen.getByRole("navigation", { name: "Primary" })).toBeVisible();
expect(screen.getByRole("link", { name: /Current workspace/i })).toHaveAttribute("href", "/app/projects");
expect(screen.queryByText("Choose a project to begin")).not.toBeInTheDocument();
expect(screen.getByRole("status", { name: /Morrow runtime/i })).toBeVisible();
```

Retain existing tests for mobile navigation, current page, focus restoration, and onboarding mounting.

- [ ] **Step 2: Run shell tests and confirm RED**

Run: `pnpm --filter @morrow/web test -- app-shell.test.tsx`

Expected: FAIL on the new accessible workspace and runtime composition.

- [ ] **Step 3: Recompose the shell markup**

Replace the full-width `WorkspaceContext` strip with a compact link in a route header cluster. Group runtime and local-profile state into one labelled status control. Keep navigation labels and routes unchanged. Add an ambient brand mark and route-canvas wrapper around `Outlet`.

Do not remove:

```tsx
<a className="morrow-skip-link" href="#main-content">Skip to content</a>
```

Keep route-change focus restoration on `mainRef` and Escape behavior for mobile navigation.

- [ ] **Step 4: Implement desktop, tablet, and mobile shell styling**

Style the rail as a warm continuous material; make active navigation a copper inset highlight; use a composed mobile topbar and bottom dock; place route content inside a max-width canvas. At 900px collapse metadata; at 720px switch to mobile navigation; at 320px preserve all primary actions without horizontal overflow.

- [ ] **Step 5: Run shell tests and commit**

Run: `pnpm --filter @morrow/web test -- app-shell.test.tsx`

Run: `pnpm --filter @morrow/web check`

```powershell
git add -- apps/web/src/app/app-shell.tsx apps/web/src/app/app-shell.test.tsx apps/web/src/styles/product-refresh.css
git commit -m "feat(web): redesign the Morrow app shell"
```

### Task 3: Home and first-workspace experience

**Files:**
- Modify: `apps/web/src/features/home/home-page.tsx`
- Modify: `apps/web/src/features/home/home-page.test.tsx`
- Modify: `apps/web/src/features/onboarding/getting-started.tsx`
- Modify: `apps/web/src/features/onboarding/getting-started.test.tsx`
- Modify: `apps/web/src/styles/product-refresh.css`

**Interfaces:**
- Consumes: `ProductHeader`, `SectionFrame`, `StateScene`, `AmbientMark`; existing project/provider/conversation/mission queries.
- Produces: readiness-aware `.morrow-home-refresh`; `ReadinessPath`; ready-state conversational action field.

- [ ] **Step 1: Add failing readiness tests**

```tsx
expect(await screen.findByRole("link", { name: "Choose a local project" })).toBeVisible();
expect(screen.queryByRole("button", { name: "New chat" })).not.toBeInTheDocument();
expect(screen.getByRole("region", { name: "Workspace readiness" })).toBeVisible();
```

For a ready project:

```tsx
expect(await screen.findByRole("button", { name: "Start a conversation" })).toBeEnabled();
expect(screen.getByText("Continue where you left off")).toBeVisible();
```

- [ ] **Step 2: Run Home tests and confirm RED**

Run: `pnpm --filter @morrow/web test -- home-page.test.tsx getting-started.test.tsx`

Expected: FAIL because the old hero renders a disabled New chat button.

- [ ] **Step 3: Build the readiness-aware hero**

Use exactly one primary action:

- no project: `Choose a local project` link;
- project but no provider: `Connect a model` link;
- ready: enabled `NewChatButton` labelled visually as `Start a conversation`.

Keep optional privacy, teams, and pairing items below required readiness. Preserve the wording that privacy preference does not enforce routing.

- [ ] **Step 4: Redesign recent work and missions**

Replace repeated bordered tiles with editorial `DataRow`-style links, clear date/project metadata, mission progress, and attention indicators. Use `StateScene` for no project, selection stale, load error, and empty recent work.

- [ ] **Step 5: Run focused tests and commit**

Run: `pnpm --filter @morrow/web test -- home-page.test.tsx getting-started.test.tsx`

Run: `pnpm --filter @morrow/web check`

```powershell
git add -- apps/web/src/features/home/home-page.tsx apps/web/src/features/home/home-page.test.tsx apps/web/src/features/onboarding/getting-started.tsx apps/web/src/features/onboarding/getting-started.test.tsx apps/web/src/styles/product-refresh.css
git commit -m "feat(web): transform the Morrow home experience"
```

### Task 4: Conversation as the core instrument

**Files:**
- Modify: `apps/web/src/features/chat/conversation-page.tsx`
- Modify: `apps/web/src/features/chat/conversation-page.test.tsx`
- Modify: `apps/web/src/features/chat/chat-composer.tsx`
- Modify: `apps/web/src/features/chat/chat-composer.test.tsx`
- Modify: `apps/web/src/features/chat/activity-panel.tsx`
- Modify: `apps/web/src/styles/product-refresh.css`

**Interfaces:**
- Consumes: existing conversation submission, streaming, approvals, mission, model picker, reasoning, and draft-store behavior.
- Produces: `.morrow-chat-workspace`, `.morrow-chat-reading-column`, `.morrow-chat-command-field`, and `.morrow-chat-inspector` composition.

- [ ] **Step 1: Add failing semantic composition tests**

```tsx
expect(screen.getByRole("main", { name: "Conversation workspace" })).toBeVisible();
expect(screen.getByRole("form", { name: "Message Morrow" })).toHaveClass("morrow-chat-command-field");
expect(screen.getByRole("complementary", { name: "Conversation details" })).toBeVisible();
```

Retain tests for Enter/Shift+Enter, draft isolation, model selection, cancellation, autoscroll, rename, archive, and delete.

- [ ] **Step 2: Run conversation tests and confirm RED**

Run: `pnpm --filter @morrow/web test -- conversation-page.test.tsx chat-composer.test.tsx`

Expected: FAIL on missing workspace, command-field, and inspector semantics.

- [ ] **Step 3: Recompose the conversation page**

Use a centered editorial reading column. Render assistant content without a bubble; keep user prompts as quiet inset fields. Move conversation metadata, activity, evidence, costs, sources, and permissions into a complementary inspector that is present in the DOM and collapsible visually. Keep approval prompts in the reading flow when they block progress.

- [ ] **Step 4: Redesign the composer and streaming states**

Make the form a layered command field. Place textarea first, then model/reasoning/context controls, then send/cancel. Provide adjacent reason text for disabled send. Add an accessible low-amplitude streaming indicator and preserve `aria-live` behavior.

- [ ] **Step 5: Run tests and commit**

Run: `pnpm --filter @morrow/web test -- conversation-page.test.tsx chat-composer.test.tsx conversation-mission-live.test.tsx`

Run: `pnpm --filter @morrow/web check`

```powershell
git add -- apps/web/src/features/chat/conversation-page.tsx apps/web/src/features/chat/conversation-page.test.tsx apps/web/src/features/chat/chat-composer.tsx apps/web/src/features/chat/chat-composer.test.tsx apps/web/src/features/chat/activity-panel.tsx apps/web/src/styles/product-refresh.css
git commit -m "feat(web): rebuild the conversation workspace"
```

### Task 5: Secondary routes and shared states

**Files:**
- Modify: `apps/web/src/features/projects/projects-page.tsx`
- Modify: `apps/web/src/features/chat/chats-page.tsx`
- Modify: `apps/web/src/features/memory/memory-page.tsx`
- Modify: `apps/web/src/features/skills/skills-page.tsx`
- Modify: `apps/web/src/features/connections/connections-page.tsx`
- Modify: `apps/web/src/features/teams/teams-page.tsx`
- Modify: `apps/web/src/features/placeholders/settings-page.tsx`
- Modify: `apps/web/src/features/pairing/pairing-page.tsx`
- Modify: matching `*.test.tsx` files for each changed route
- Modify: `apps/web/src/styles/product-refresh.css`

**Interfaces:**
- Consumes: Task 1 primitives and all existing route APIs/mutations.
- Produces: consistent `.morrow-route-*`, `.morrow-data-row`, `.morrow-choice-card`, `.morrow-inspector-block`, and shared state styling across every route.

- [ ] **Step 1: Add route-contract tests**

For each page, assert a level-one heading, a route description, the current primary action, and the page's specific empty/error state. Add the shared expectation:

```tsx
expect(container.querySelector(".morrow-page__heading")).toBeNull();
expect(container.querySelector(".morrow-product-header")).toBeTruthy();
```

- [ ] **Step 2: Run route tests and confirm RED**

Run: `pnpm --filter @morrow/web test -- projects-page.test.tsx chats-page.test.tsx memory-page.test.tsx skills-page.test.tsx connections-page.test.tsx teams-page.test.tsx settings-page.test.tsx pairing-page.test.tsx`

Expected: FAIL because routes still use the legacy heading/card grammar.

- [ ] **Step 3: Migrate Projects, History, and Missions**

Use `ProductHeader` and editorial rows. Preserve active project selection, project paths, archived chat filters, mission progress, and all retry behavior.

- [ ] **Step 4: Migrate Memory, Skills, and Teams**

Lead with content and progressive disclosure. Preserve memory source/confidence/lifecycle, permanent-delete wording, skill trust/evidence/permissions, team roles/tools/scopes/handoffs, and all mutations.

- [ ] **Step 5: Migrate Connections, Settings, and Pairing**

Replace inline styles in Settings with named classes and shared form controls. Preserve configured-provider truth, connection testing, key safety, saved privacy preference caveat, destructive reset controls, and pairing's billing-only explanation.

- [ ] **Step 6: Run route tests and commit**

Run the command from Step 2 again.

Run: `pnpm --filter @morrow/web check`

```powershell
git add -- apps/web/src/features apps/web/src/styles/product-refresh.css
git commit -m "feat(web): refresh every product surface"
```

### Task 6: Responsive, theme, motion, and accessibility completion

**Files:**
- Modify: `apps/web/src/styles/product-refresh.css`
- Modify: `apps/web/src/state/theme.test.tsx`
- Modify: `apps/web/src/app/app-shell.test.tsx`
- Modify: `apps/web/src/app/error-boundary.tsx`
- Modify: `apps/web/src/app/error-boundary.test.tsx`

**Interfaces:**
- Consumes: all refreshed classes.
- Produces: complete dark/light token mappings, 320px layout, reduced-motion behavior, and unified error boundary.

- [ ] **Step 1: Add semantic accessibility regression tests**

Assert visible focus targets, route-change main focus, labelled mobile navigation, status roles, dialog labels, and retry actions. Confirm the error boundary uses `StateScene` and exposes one `Try again` button.

- [ ] **Step 2: Add explicit CSS acceptance rules**

Include:

```css
@media (max-width: 720px) { /* mobile shell and sheets */ }
@media (max-width: 380px) { /* 320px-safe gutters and actions */ }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
}
```

Map all product tokens under both `[data-theme="dark"]` and `[data-theme="light"]`/root behavior. Avoid relying on color alone for selected, active, warning, and error states.

- [ ] **Step 3: Run web tests and commit**

Run: `pnpm --filter @morrow/web test`

Run: `pnpm --filter @morrow/web check`

```powershell
git add -- apps/web/src/styles/product-refresh.css apps/web/src/state/theme.test.tsx apps/web/src/app/app-shell.test.tsx apps/web/src/app/error-boundary.tsx apps/web/src/app/error-boundary.test.tsx
git commit -m "fix(web): complete responsive accessible polish"
```

### Task 7: Integrated verification and release evidence

**Files:**
- Create: `output/product-refresh/` screenshots (verification artifacts, not committed unless repository policy explicitly tracks them)
- Modify: `CHANGELOG.md`
- Modify: root `package.json` version only when preparing the approved beta release

**Interfaces:**
- Consumes: completed redesign.
- Produces: deterministic checks, clean-profile rendered evidence, packaged-candidate evidence, and release notes.

- [ ] **Step 1: Run deterministic repository gates**

Run sequentially:

```powershell
pnpm check
pnpm test
pnpm build
git diff --check
```

Expected: all exit 0.

- [ ] **Step 2: Launch a clean isolated source preview**

Use a unique `MORROW_HOME` and ports. Verify `/api/health` reports this worktree's service root and entry script before opening `/app/`.

- [ ] **Step 3: Capture the required visual matrix**

Capture and inspect:

- fresh Home after onboarding;
- ready Home;
- empty and active conversation;
- conversation inspector and approval/blocked state;
- Projects, History, Memory, Skills, Connections, Settings;
- recoverable error;
- desktop 1440x900, tablet 900x1024, phone 390x844, and 320px width;
- dark, light, and reduced-motion runs.

Reject screenshots that are loading, stale, occluded, or served by a different worktree.

- [ ] **Step 4: Package and verify the candidate**

Run the repository's package command and package/install contract tests. Launch the portable artifact with a second clean data root and verify its health identity, rendered Home, web assets, and version.

- [ ] **Step 5: Update release notes and commit**

Document the full refresh, user-visible changes, accessibility/responsive coverage, verification commands, rollback to the prior beta, and any honest residual limitations.

```powershell
git add -- CHANGELOG.md package.json pnpm-lock.yaml
git commit -m "chore(release): prepare Morrow UI refresh beta"
```

- [ ] **Step 6: Push and open a review PR**

Push `codex/full-product-ui-refresh`, open a PR to `main`, attach visual evidence and check results, request independent review, and only dispatch the existing release workflow after merge.
