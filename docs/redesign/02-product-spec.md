# Morrow Redesign — Phase 2: Product Experience Specification

> The product Morrow becomes, and why. Every capability named here is backed by a
> concrete schema/route observed in the repo (see `01-discovery.md`) so the design
> is buildable, not aspirational.

## 1. Product thesis

**Morrow is a personal adaptive intelligence you talk to, that can also take on serious work and get more useful to you every time.**

One continuous intelligence that knows you, remembers what matters, understands your projects, improves from outcomes, creates reusable skills, and takes durable ownership of complex work — communicated through a friendly, chat-first surface, with execution machinery exposed only when it helps.

A first-time user must understand it in five seconds: *"an AI I can talk to that can also do real work for me."* Not *"software for monitoring a workflow engine."*

Morrow is **not** primarily a mission launcher, workflow dashboard, task database, developer console, orchestration monitor, or coding-only agent. Missions, agents, memory, verification, skills, providers, and artifacts are **supporting systems beneath a conversation.**

## 2. Experience principles

1. **Conversation is the product.** Everything reachable from a sentence. Chat is the default surface; every other view is where a conversation's *artifacts* accumulate.
2. **Personal, not operational.** The interface speaks to a person ("Good morning, Aidan — what should we work on?"), not to an operator watching a queue. No raw enums, status-pill soup, or debug phases on the primary surfaces.
3. **Truthful by construction.** The backend never fabricates progress or completion; the UI inherits that. "Working", "Needs you", "Done — verified", "Done — with caveats", "Recovered", "Blocked" are shown honestly. **Passing tests is never presented as done UX.**
4. **Adaptation is visible and controlled.** Morrow shows what it has learned and lets the user inspect, edit, confirm, reject, and delete every memory and skill. Nothing is captured silently; nothing dangerous is granted casually.
5. **Progressive disclosure of power.** A newcomer sees a chat box. Depth (modes, mission detail, verification evidence, model routing, activity logs) is one deliberate click away, never in the way.
6. **Calm, premium, quiet.** Warm off-white / deep neutral, restrained violet accent, generous but not empty space, normal-sized headings, minimal borders, purposeful motion. Inspired by Claude's clarity, Claude Code's active-work honesty, Linear's precision, Notion's readability — copying none.
7. **Local-first and private.** Secrets never reach the browser; memory is project-isolated and user-owned; personal data never leaks into shareable artifacts.

## 3. Information architecture & navigation

### 3.1 Surfaces

| # | Surface | Route | Purpose | Backing |
|---|---|---|---|---|
| 1 | **Home / Today** | `/` | Personal launchpad: greeting, large composer, continue-where-you-left-off, active work, recent chats, suggestions, "what Morrow learned". | conversations + missions + memory (project-scoped), recent-first |
| 2 | **Chat** | `/c/$conversationId` | The primary working surface. Streaming markdown, modes, attachments, embedded mission cards, approvals, memory chips. | `/api/conversations/*`, `/api/tasks/:id/events/stream` |
| 3 | **Projects** | `/projects`, `/projects/$id` | Persistent working environments: a project's chats, missions, files, memory, instructions, connected repo. | `/api/projects/*`, `intelligence`, `conversations`, `missions` |
| 4 | **Missions** | `/missions`, embedded panel | Portfolio of durable work; detail lives in a side panel attached to its conversation, not a standalone page. | `/api/projects/:id/missions`, mission snapshot + SSE |
| 5 | **Library** | `/library` | Real outputs: documents, generated sites, code diffs, research, uploads, saved results, templates, skills. | mission artifacts, files, `LearnedSkill` |
| 6 | **Memory** | `/memory` | "About you", how you like to work, current goals, project memory, learned lessons, skills — all editable. | `memory_entries`, cortex intelligence, learnings, rules |
| 7 | **Connections** | `/connections` | Providers/models: configured state, active model, local vs cloud, health, auth, friendly setup. | `/api/providers/*`, presets, models, oauth |
| 8 | **Settings** | `/settings` | Appearance, defaults (mode/model/autonomy), privacy, data, about. | local prefs + provider defaults |

### 3.2 Sidebar (narrow, quiet, collapsible)

```
Morrow
[ + New chat ]

Home
Chats
Projects
Missions
Library

Recent
  • Redesign Morrow as chat-first…
  • Local model research
  • Agent workflow planning

Memory
Connections
Settings
─────────────
● Claude Opus · local profile
```

- Primary group: Home, Chats, Projects, Missions, Library.
- **Recent** conversations inline for one-click continuity (this is the continuity spine, not a buried list).
- Utility group: Memory, Connections, Settings.
- Footer: active model + runtime dot (calm, single line — replaces the old status-pill cluster).
- Mobile: sidebar collapses to a bottom tab bar (Home · Chats · New · Missions · More) + a slide-over for the full nav.
- **No section may present itself as a finished product area if it is not.** Incomplete surfaces are hidden or honestly marked "Early", never faked.

### 3.3 The composer (shared Home + Chat component)

A single large composer is the gravitational center. It carries:
- multiline input, attachments (files/images), send;
- a **mode switch** (Ask · Plan · Build · Build Auto — see §4);
- a quiet **model chip** (e.g. "Claude Opus" / "balanced") opening a picker (presets + models);
- a provider-readiness line when nothing is connected (friendly, not an error).

## 4. Interaction modes

Four modes near the composer, understandable without documentation. Each maps to existing `SendMessage` fields — no new execution engine.

| Mode | Meaning to user | `SendMessage` mapping | Autonomy |
|---|---|---|---|
| **Ask** | Normal conversational help. Answers, research, thinking. No changes. | `mode: "read-only"` | none |
| **Plan** | Research and produce a thorough plan; make no changes. | `mode: "plan-only"` | none |
| **Build** | Do the work; ask before consequential decisions. | `mode: "agent"`, `autoApprove: false` | ask-at-risk |
| **Build Auto** | Take ownership: set acceptance criteria, make routine calls, recover from failures, continue until genuinely met. | `mode: "agent"`, `autoApprove: true` | autonomous |

Modes are presented as *intent*, never as "routing" or "orchestration settings". Build / Build Auto are the two that can escalate a message into a **mission**.

## 5. Conversation ↔ mission relationship

This is the redesign's core structural move, and the backend already supports it (`Mission.conversationId`, `SendMessage.missionId`, messages carry `taskId`).

- **A conversation can exist with no mission.** Ask/Plan turns are ordinary chat.
- **A mission is born from a conversation turn** (Build / Build Auto on a substantial request). Morrow first replies conversationally, may present a concise plan, and offers **Start mission** / **Adjust plan**. The user stays in the same conversation.
- **A mission links back** to its originating conversation and project. It is never a separate destination the user is thrown into.
- **In-chat presence:** an active mission renders as a **compact progress card** inline — title, understandable current activity, progress, elapsed, attention flag. Updates arrive as concise conversational events ("I finished the dashboard structure." / "I hit a provider issue and recovered." / "I need your approval before replacing the navigation." / "Implementation complete — running browser acceptance."). Raw event logs never flood the chat.
- **Depth on demand:** a **mission detail panel** (collapsible side panel attached to the conversation) exposes authoritative status, progress, elapsed, active model/provider, current step, plan checklist, approvals, agents/specialists, files, deliverables, verification, recovery state, and full activity. Most users never open raw Activity.

State vocabulary (mapped from `MissionStatus`/runtime for humans):

| User-facing | Backend |
|---|---|
| Working | running |
| Planning / Needs your approval | draft / awaiting_criteria_approval |
| Needs you | blocked (attention) / approval pending |
| Recovered | failure recorded + recovered |
| Done — verified | completed |
| Done — with caveats | completed_with_reservations / partially_completed |
| Stopped | cancelled |
| Couldn't finish | failed |

## 6. Project model

Projects are persistent working environments (backed by `projects` + `/api/projects/*` + intelligence).

A project contains: chats, missions, files, instructions/goals, project memory, a connected repository/workspace, created artifacts, decisions, reusable skills, results. Opening a **new conversation inside a project** automatically carries relevant project history (the backend already recalls project-scoped memory + intelligence for each turn) — the user does not re-paste background. Project memory is **strictly isolated**; it cannot leak into unrelated projects (enforced in `memory.ts` by project-id scoping).

There is always at least one project (the local workspace). A reserved **Personal** space hosts cross-project "About you" profile memory (§ see `03-memory-and-adaptation.md`).

## 7. Security & privacy model

Carried verbatim into design; the backend already enforces most of it.

- **Secrets never reach the browser.** Provider keys/tokens live server-side (`provider/secrets.ts`, oauth-flow never emits token material). The UI shows connection *state*, never values.
- **Memory is user-visible and reversible.** Every entry is inspectable, editable, confirmable, rejectable, disable/enable, pin, delete — with source/provenance, scope, confidence, sensitivity, timestamps. No hidden capture; no vector-store internals, embeddings, or raw retrieval scores in the normal UI.
- **Sensitive memory is not saved casually.** `sensitivity: secret/sensitive` entries are gated; suggestions for sensitive facts require explicit confirmation and are never auto-promoted.
- **Project isolation.** Retrieval is project-scoped; personal profile is a separate explicit scope. Private context never enters public/shareable artifacts.
- **Auditability.** Memory and skill changes are recorded; the tamper-evident audit log (`audit/log.ts`) covers execution. Build Auto does **not** bypass permission boundaries — destructive/consequential actions still raise approvals; autonomy pre-approves *plan/criteria*, not dangerous tools.
- **Injection safety.** Hidden prompts / credentials found in tool content never become instructions and never surface as UI directives (`browser/injection-guard.ts`, `mcp/trust.ts`).

## 8. Acceptance criteria (product-level)

The redesign is done only when all hold (verified by real browser journeys, not seeded screenshots):

1. Morrow is unmistakably **chat-first**; Home feels personal and useful even with no active mission.
2. Missions are integrated **into conversation**; technical mission detail is secondary (panel, not page).
3. Projects preserve continuity; a new chat in a project already understands its history.
4. Memory is **real, transparent, editable, project-isolated, useful**; Morrow can demonstrably act on a previously-saved preference.
5. Morrow can **propose a memory**, and the user can inspect/confirm/edit/reject/delete it.
6. Provider setup is friendly; a missing provider produces an actionable explanation, **never** "Operation ended failed" and never a doomed mission.
7. The four modes work and are understandable without docs.
8. Approvals, recovery, streaming, refresh-preserves-state, and reconnect all work in the browser.
9. Outputs land in **Library**; the project keeps its results.
10. Desktop **and** mobile feel polished; light and dark are both first-class; WCAG AA.
11. No major page is a fake placeholder. Nothing claims completion the backend can't prove.
12. PR #64 remains unmerged until explicit visual approval.

## 9. Visual direction (summary; realized in prototypes)

Reuse and extend the existing Morrow tokens (already aligned to the brief): warm off-white `#f7f6f3` light / deep neutral `#181817` dark; violet accent `#6558d9` (light) / `#8b7ff0` (dark); soft radii (8–16px); one restrained shadow. Narrow quiet sidebar; readable 15–16px body; normal headings; minimal borders; limited pills; subtle motion; no oversized hero text inside working screens; no dead space; no dashboard chrome. Full token + component spec is expressed directly in the prototype design system.
