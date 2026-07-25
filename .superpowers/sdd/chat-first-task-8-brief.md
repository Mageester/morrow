# Task 8 brief — Missions inside chat (increment 1)

Base commit: `8c4e141` (Slice 7). Branch `feat/morrow-web-app-foundation` (PR #64, open/draft/unmerged).

## Objective

Make a mission appear *inside* the conversation it belongs to: a compact mission card with a collapsible detail panel, using the existing mission engine and projection. Keep the conversation route stable. Provide a reachable way to start a conversation-linked mission.

## Scope (this increment)

- Expose the conversation↔mission link in the web layer (`WebMissionSummary.conversationId`, populated by the projection; `CreateWebMissionSchema.conversationId`; the create route links it).
- A **mission card** in the conversation: title, current activity/phase, progress, honest state, attention flag, details toggle.
- A **mission detail panel**: status, step, model, current work, plan checklist, verification, recent activity.
- Conversation wiring: the conversation shows its linked mission (filtered from the project mission list) and offers "Start a mission from this chat".

## Deferred (next increment, noted honestly)

- In-chat plan proposal + Adjust before Start; conversational mission event feed; approval/recovery cards rendered inline (approvals already exist via the attention projection and appear in the panel/mission page).

## Constraints

- Smallest coherent change; reuse the mission projection, snapshot, and web routes. Do not weaken Slice 1–7 boundaries. Commit locally with a Conventional Commit; push; keep PR #64 open/draft/unmerged.
