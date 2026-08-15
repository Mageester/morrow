# Premium Chat Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make pending approval actions reliably usable and restore the premium conversation composer hierarchy without changing execution policy.

**Architecture:** Keep approval state and mutation behavior in `PendingApprovals`; move only the visual boundary in the conversation layout so approval cards are part of the transcript flow and the composer remains a non-overlapping anchor. Scope visual changes to the existing premium conversation/composer styles so the shared product token system remains the source of truth.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, CSS, existing Morrow premium style layers.

## Global Constraints

- Preserve approval decisions, project scoping, task execution, provider routing, and all server-side permission boundaries.
- `Trusted workspace` must remain accurately described as auto-approval for ordinary workspace actions only.
- No external provider call, credential change, or user workspace mutation is required for verification.
- Preserve the existing deep-charcoal editorial design system and verify desktop plus mobile rendering.

---

### Task 1: Approval-safe conversation layout

**Files:**
- Modify: `apps/web/src/features/chat/conversation-page.tsx`
- Modify: `apps/web/src/features/chat/conversation-page.test.tsx`
- Modify: `apps/web/src/styles/product-refresh.css`

**Interfaces:**
- Consumes: `PendingApprovals({ active, conversationId, conversationTaskIds, projectId })`
- Produces: transcript-flow placement in which the approval region precedes the composer and never belongs to a clipped transcript container.

- [ ] **Step 1: Write the failing regression test**

```tsx
const approval = screen.getByRole("region", { name: "Approvals waiting for your decision" });
const composer = screen.getByRole("form", { name: "Message Morrow" });
expect(approval.closest(".morrow-conversation-action-shelf")).not.toBeNull();
expect(within(approval).getByRole("button", { name: "Allow once" })).toBeEnabled();
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `pnpm --filter @morrow/web test conversation-page.test.tsx`

Expected: FAIL because the current approval region is nested in the scrolling transcript and there is no dedicated action shelf.

- [ ] **Step 3: Move the approval region into an explicit action shelf above the composer**

```tsx
<div className="morrow-conversation-action-shelf">
  <PendingApprovals {...approvalProps} />
</div>
<div className="morrow-conversation-composer"><ChatComposer {...composerProps} /></div>
```

Add the shelf and composer spacing styles so neither uses overlap or a higher stacking context to cover the other.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm --filter @morrow/web test conversation-page.test.tsx`

Expected: PASS and the existing approval-resolution assertion remains green.

### Task 2: Quiet the composer into one writing surface

**Files:**
- Modify: `apps/web/src/styles/premium/composer.css`
- Modify: `apps/web/src/features/chat/chat-composer.test.tsx`

**Interfaces:**
- Consumes: existing `ChatComposer` markup and accessible labels.
- Produces: a visually tiered message field, compact control row, and separate reasoning row without changing submission data.

- [ ] **Step 1: Write the failing behavior/copy test**

```tsx
expect(screen.getByText("Trusted workspace", { exact: true })).toBeVisible();
expect(screen.getByText("Ordinary workspace actions can continue without stopping; other actions still ask.")).toBeVisible();
expect(screen.getByRole("button", { name: /Show thinking/i })).toBeVisible();
```

- [ ] **Step 2: Run the focused test to verify it fails after the intended copy/layout contract is asserted**

Run: `pnpm --filter @morrow/web test chat-composer.test.tsx`

Expected: FAIL until the contract uses the final truthful permission language and the existing visual-control grouping is retained.

- [ ] **Step 3: Apply minimal premium CSS changes**

Keep all controls accessible, reduce redundant borders, make the textarea the visual primary action, and use copper only for focus, selected state, and send. Do not alter `ChatComposerSubmission` or request payloads.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `pnpm --filter @morrow/web test chat-composer.test.tsx`

Expected: PASS with existing mode, provider, reasoning, and trust tests intact.

### Task 3: Rendered desktop/mobile validation

**Files:**
- Modify only if a rendered mismatch requires a narrowly scoped CSS correction: `apps/web/src/styles/product-refresh.css` or `apps/web/src/styles/premium/composer.css`

**Interfaces:**
- Consumes: local `/app/chats/:conversationId` route, pending-approval fixture state, existing responsive rules.
- Produces: no clipping, overlap, horizontal overflow, or console errors at desktop and mobile widths.

- [ ] **Step 1: Render the conversation at desktop and mobile widths**

Use the in-app Browser on the local app. Check the pending approval’s `Allow once` interaction, composer focus state, and `Show thinking` control.

- [ ] **Step 2: Record any mismatch before styling it**

The mismatch ledger must include the source screenshot, the rendered state, and the exact selector changed.

- [ ] **Step 3: Apply the smallest CSS correction**

Only adjust the selector proven by the mismatch ledger; retain the temporary viewport reset after mobile validation.

- [ ] **Step 4: Run focused and release checks**

Run: `pnpm --filter @morrow/web test conversation-page.test.tsx chat-composer.test.tsx`, `pnpm check`, `pnpm build`, and `git diff --check`.

Expected: all modified component tests, type checking, build, and whitespace checks pass.
