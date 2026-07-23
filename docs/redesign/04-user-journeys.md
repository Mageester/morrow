# Morrow Redesign — Phase 2: User Journeys

> The nine journeys the product must support, prototyped in Phase 3 and implemented
> in Phase 5. Each notes the backing that already exists.

## Journey 1 — Normal conversation
User asks a question ("Which local model suits my RTX 4070?"). Mode: **Ask**. Morrow answers naturally with streaming markdown. **No mission is created.** The chat persists and is reopenable from the sidebar / Home "Recent".
*Backing:* `POST /api/conversations/:id/messages` (`mode: read-only`) → `GET /api/tasks/:id/events/stream`.

## Journey 2 — A complex task becomes a mission
User requests substantial work ("Research the best local AI models for my RTX 4070 and write it up"). Morrow, aware of user + project context (recalled memory), replies conversationally and (mode **Plan** or **Build**) presents a concise plan with **Start mission** / **Adjust plan**. The user starts it and **remains in the same conversation**; a compact mission card appears inline and progresses. No isolated debugging page.
*Backing:* memory recall per turn; `Mission.conversationId`; `/api/projects/:id/missions`; mission snapshot + SSE rendered as an in-chat card.

## Journey 3 — Build Auto
User selects **Build Auto**. Morrow generates acceptance criteria, performs the work, makes routine decisions, recovers from failures, and continues until criteria are genuinely met — surfacing only consequential approvals. The mission card shows honest progress; completion is evidence-gated.
*Backing:* `mode: agent`, `autoApprove: true`; criteria generation/approval; guardian + evidence; bounded auto-recovery; no false completion.

## Journey 4 — Provider missing
User asks for work with no provider configured. Morrow explains **before** creating a doomed mission:
> "Morrow needs an AI model before it can begin this work." → **Connect a provider · Use a local model · Review options.**
The user connects directly (friendly setup). The old failure string "Operation ended failed" never appears.
*Backing:* `listProviderStatuses`; composer readiness line; `/api/providers/*` + oauth; **gate mission creation on provider readiness** (small guard, currently the composer only warns).

## Journey 5 — Approval
Morrow reaches a consequential decision (e.g. "replace the current navigation"). A clear **approval card** appears in chat stating: what Morrow wants to do, why, consequences, and alternatives, with **Approve / Adjust / Decline**.
*Backing:* approvals table + `/api/approvals/:id/resolve`; mission attention projection already models `title/explanation/recommendation/choices/destructive`.

## Journey 6 — Recovery
A provider or tool fails. Morrow explains in plain language, shows **preserved progress** (checkpoint), and offers **Retry · Switch provider · Adjust plan · Stop**. Nothing is lost; the failure is actionable, not a buried caveat.
*Backing:* failure ledger + checkpoints + `worker-recovery`; retry/rollback/resume routes; non-retryable 401/402/403 → switch-or-block.

## Journey 7 — Project continuity
User opens a new conversation inside the **Morrow** project. Morrow already understands the product direction, the previously rejected UI, the current PR, and the quality expectations — without re-pasting. Project chats, missions, files, and memory are all present in the project view.
*Backing:* project-scoped memory + cortex intelligence recalled automatically; `/api/projects/:id/{conversations,missions,intelligence}`.

## Journey 8 — Memory learning
User rejects a result ("this looks like a debug site"). Morrow identifies the reusable lesson and **asks permission to remember it**:
> "I noticed you consistently reject interfaces that expose internal engineering concepts. Should I remember that consumer interfaces should hide operational detail by default?" → **Remember · Edit · Not now.**
If saved, it appears in Memory → *How you like to work*, fully editable, with provenance to this conversation.
*Backing:* learning extractor + `CreateMemoryEntrySchema`; **new** propose→confirm route; existing edit/delete.

## Journey 9 — Completed work
Morrow presents a **concise result** inline: what was done, deliverables (files/docs/site/diff), verification summary, caveats, and next actions. The result is saved to the **project** and appears in the **Library**. Raw activity remains available but is not the headline.
*Backing:* `MissionResult` + evidence + artifacts; mission → Library projection; verification summary already in `web.ts`.

## Cross-cutting requirements

- **Streaming** everywhere assistant text appears; **refresh preserves state** (durable conversations/missions); **reconnect** resumes the stream.
- **Mobile**: every journey is completable on a phone (composer, mission card, approval card, memory edit).
- **Honesty**: no journey ends in a claimed completion the backend cannot evidence.
