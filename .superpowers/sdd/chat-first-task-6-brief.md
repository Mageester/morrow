# Task 6 brief — Chat-first shell and Home

Base commit: `48b7727`

## Objective

Replace the prototype shell/Home with a narrow, responsive, production chat-first foundation backed only by real local data. Add durable Chats navigation and a real Chats list/new-chat flow while preserving every reviewed Slice 1–5 security and lifecycle boundary.

## Required behavior

- Primary destinations: Home, Chats, Projects, Missions, Library, Memory, Connections, Settings. Every visible control must navigate to implemented content or an explicit honest unavailable/next-slice state; no silent dead controls.
- Provide a prominent New chat action. It must use the real project-scoped conversation API, create exactly once, navigate to `/app/chats/:conversationId?projectId=:projectId`, and focus the composer. Handle no-project, accepting, error, and retry states without duplication.
- Add `/app/chats` with real project-scoped recent conversations, stable active/archive truth, loading, honest empty, retained-cache warning, retry, and touch/keyboard-safe rows.
- Show real recent conversations in the shell and preserve active-route semantics. Do not invent people, prompts, history, learning, or status.
- Home must derive its greeting/summary/continue surfaces from actual projects, conversations, active missions, and confirmed learning exposed by existing safe APIs. If an API is not yet available for a category, omit it or show an honest empty/next-slice state; never mock it.
- Preserve the reviewed Task 4 composer and Task 5 conversation route behavior. Home/shared-composer sends must follow accepted-only clearing and canonical navigation semantics.
- Implement accessible keyboard navigation, visible focus, correct landmarks/current-page state, logical focus after navigation/new chat, 44px touch targets, no horizontal overflow, reduced-motion respect, and responsive desktop/tablet/mobile navigation.
- Theme choices must support light, dark, and system; persist explicit choice, follow live OS changes in system mode, apply before paint, and remain usable on mobile. Do not overwrite an explicit stored choice.
- Preserve cached useful data on background refetch errors and show non-blocking warnings.
- Keep project ownership explicit in every conversation query/mutation and cache key.

## Tests and evidence

- Write RED tests before production changes for shell navigation, New chat idempotency/focus/error behavior, Chats data states, Home real-data/empty/error behavior, and theme persistence/system changes.
- Add deterministic packaged Playwright navigation coverage for desktop keyboard and mobile touch across all destinations, New chat, recent chat, active route, theme choices, refresh persistence, focus, overflow, and no duplicated conversation creation.
- Run focused web tests, full web tests if proportional, type check, production build, packaged browser spec, and `git diff --check`.
- Record implementation, privacy/security impact, failures, exact commands/results, limitations, and executable rollback in `.superpowers/sdd/chat-first-task-6-report.md`.

## Constraints

- Smallest coherent change. Reuse existing contracts, clients, queries, components, and APIs before introducing abstractions.
- Do not implement Task 7 model-catalogue selection or Task 8 missions-in-chat here.
- Do not weaken provider, SSE, idempotency, ownership, credential, or draft-isolation boundaries.
- Do not touch unrelated untracked artifacts. Commit the implementation locally with a Conventional Commit. Do not push or merge.
