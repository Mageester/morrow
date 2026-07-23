# Production interaction inventory

This ledger is the completion gate for production `/app` controls. A row is complete only when its behavior is data-backed, keyboard-operable, responsive, tested, and manually verified. `Removed` is valid when no backend behavior exists; silent no-op is never valid.

| Route | Element | Expected behavior | API dependency | Keyboard | Loading | Success | Empty | Error | Mobile | Automated test | Manual result |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Global | Sidebar navigation | Navigate among every shipped route and identify current page | Router | Tab, Enter, arrow behavior where grouped | N/A | Route changes once | N/A | Not-found boundary | Collapsible/bottom navigation | Pending Slice 6 | Pending |
| Global | New chat | Create or open an empty durable conversation | `POST /api/conversations` | Tab, Enter | Disabled + progress | Focus composer | Recoverable empty project state | Actionable retry | Full-width touch target | Pending Slice 5/6 | Pending |
| Global | Theme picker | Apply and persist light/dark/system | Local theme state | Native selection | N/A | Immediate theme update | System default | Safe system fallback | Reachable in mobile nav/settings | Pending Slice 6 | Pending |
| `/app/` | Shared composer | Preserve draft and submit accepted messages | Conversation/message APIs | Full editing, Enter send, Shift+Enter newline, IME-safe | Accepted submission only | Stream response | Suggested actions from real state | Draft retained + retry | Keyboard-safe autosize | Pending Slice 4/5 | Pending |
| `/app/` | Continue cards | Open real recent conversation or mission | Conversation/mission lists | Tab, Enter | Skeleton | Correct durable target | Honest empty state | Non-blocking warning | Single-column | Pending Slice 6 | Pending |
| `/app/chats` | Conversation row | Open durable history | Conversation list | Tab, Enter | Skeleton | Correct active item | New-chat invitation | Retry | Touch target | Pending Slice 5/6 | Pending |
| `/app/chats/:id` | Send | Accept once, preserve until accepted, stream canonical reply | Message dispatch + task SSE | Enter/button | Disabled while accepting | One assistant row | N/A | Draft retained | Reachable above keyboard | `conversation-page.test.tsx`, `chat-stream.test.ts`, `conversations.spec.ts` | PASS desktop/mobile, refresh/reconnect and no duplicates |
| `/app/chats/:id` | Stop generation | Cancel current task once | Task cancel API | Tab, Enter | Busy | Terminal cancelled state | Hidden when idle | Retry canonical fetch | Touch target | `conversation-page.test.tsx`, `conversations.spec.ts` | PASS active cancel and canonical terminal reconcile |
| `/app/chats/:id` | Mode picker | Select Ask/Plan/Build/Build Auto truthfully | Routing/mission dispatch | Native/combobox keys | Catalogue readiness | Persist selection | Default Ask | Explain unavailable mode | Bottom-sheet or native-safe | Pending Slice 7 | Pending |
| `/app/chats/:id` | Model picker | Search/select available backend models | `GET /api/models`, refresh | Combobox keys | Skeleton/refresh | Stable visible model | Connect-provider CTA | Stale/unavailable explanation | Responsive popover | Pending Slice 7 | Pending |
| `/app/chats/:id` | Rename/archive/delete | Mutate durable conversation with confirmation | Conversation APIs | Menu/dialog keys, focus return | Busy per action | Canonical list refresh | N/A | Retry without state loss | Sheet/dialog | `conversation-page.test.tsx`, `conversations.spec.ts` | PASS list reconciliation, focus trap/return, mobile confirmation |
| `/app/chats/:id` | Mission card/panel | Start, inspect, approve, recover, stop in same chat | Mission APIs + SSE | Card/button/dialog keys | Streaming/skeleton | Canonical mission state | Hidden without mission | Reconnect/retry | Collapsible full-width panel | Pending Slice 8 | Pending |
| `/app/projects` | Project row | Open data-backed project continuity | Projects API | Tab, Enter | Skeleton | Correct detail route | Honest empty state | Retry | Single-column | Pending Slice 9 | Pending |
| `/app/projects/:id` | Continuity sections | Show real chats/missions/files/memory/decisions/repos/artifacts | Project projection APIs | Landmark/tab semantics only if interactive | Skeleton per section | Project-isolated data | Per-section empty | Non-blocking warning | Stacked | Pending Slice 9 | Pending |
| `/app/missions` | Mission row | Open/return to mission's conversation context | Mission list | Tab, Enter | Skeleton | Correct target | Honest empty state | Retry | Touch target | Pending Slice 8 | Pending |
| `/app/library` | Output row | Open a real persisted output | Library projection | Tab, Enter | Skeleton | Safe output view | Honest empty | Retry | Stacked | Pending Slice 11 | Pending |
| `/app/memory` | Search/filter | Filter real project-isolated memory | Memory list | Input/select keys | Debounced/busy | Matching rows | No-match message | Retry | Stacked controls | Pending Slice 10 | Pending |
| `/app/memory` | Confirm/reject/edit/delete/pin/enable | Apply explicit lifecycle mutation with confirmation where destructive | Memory APIs | Button/dialog/form keys | Busy per row | Canonical refresh | N/A | Preserve edit + retry | Accessible row menu/sheet | Pending Slice 10 | Pending |
| `/app/connections` | OpenRouter Connect/Save/Cancel | Validate key server-side; persist only after authenticated success | Provider configure/test | Form keys, Escape cancel, focus return | Save/test busy | Durable connected health state | Local setup form | Classified auth/rate/network with first/replacement truth | Full-width form | `connections-page.test.tsx`, `connections.spec.ts` | PASS desktop/mobile, no populated-key screenshot |
| `/app/connections` | Test/Refresh | Authenticate and refresh normalized model catalogue | Provider test/refresh | Tab, Enter, focus preserved | Busy | Durable health time/count updated | Authenticated zero-model state retains health | Classified retry; cached truth retained | Touch target | `providers.test.ts`, `connections-page.test.tsx`, `connections.spec.ts` | PASS desktop/mobile |
| `/app/connections` | Replace/Disconnect | Validate replacement before swap; confirm credential removal | Provider configure/delete | Dialog trap, Escape, focus return | Busy | Authoritative cache update before reconcile | Setup form | Prior key retained on failed replace | Responsive dialog | `connections-page.test.tsx`, `connections.spec.ts` | PASS desktop/mobile |
| `/app/settings` | Settings controls | Only render implemented theme/privacy/runtime preferences | Existing local/runtime settings | Native/form keys | Per-control | Persisted state | N/A | Roll back + explain | Stacked | Pending Slice 6/12 | Pending |

## Audit status

- Baseline rows created: 2026-07-22.
- Completed rows: 6.
- Unexplained dead controls allowed: 0.
- Final semantic-control sweep: pending Slice 12.
