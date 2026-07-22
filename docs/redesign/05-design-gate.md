# Morrow Product Reset — Design Gate

> Approval package for the chat-first product direction. This gate authorizes
> production frontend planning only. It does **not** authorize production UI
> implementation, database migrations, or merging PR #64.

## Decision requested

Approve, reject, or request changes to this product direction:

1. **Conversation is the primary product.** Home begins with a shared composer;
   ordinary Ask/Plan turns remain chat.
2. **Missions are durable work inside conversations.** A compact card carries the
   understandable state; a secondary panel carries execution detail.
3. **Projects provide continuity.** Chats, missions, files, instructions, memory,
   and outputs share one persistent context.
4. **Memory is visible and controlled.** Personal, working-preference, project,
   episodic, and outcome memory are inspectable, editable, scoped, and removable.
5. **The presentation becomes calm and personal.** The reliable orchestrator is
   preserved beneath a consumer-facing interface rather than exposed as the
   interface.

If approved, the next step is a migration plan and the first narrow production
slice. PR #64 remains open and unmerged until that approval is explicit.

## Working prototype

- Prototype: [`prototypes/morrow.html`](prototypes/morrow.html)
- Reproducible capture and validation: [`prototypes/capture.mjs`](prototypes/capture.mjs)
- Machine-readable report: [`prototypes/shots/final/validation-report.json`](prototypes/shots/final/validation-report.json)
- Optional screen picker: add `?controls=1`. Direct state links use
  `?screen=<state>&theme=light|dark`.

This is a static interaction prototype with realistic mock data. It does not call
the orchestrator, mutate user data, authenticate providers, or execute tools.

## Product thesis

**Morrow is a personal adaptive intelligence you talk to, that can also take on
serious work and get more useful to you every time.**

Missions, agents, memory, verification, providers, and artifacts remain important,
but become supporting systems beneath a continuous conversation. The first screen
must read as “an AI I can talk to that can also do real work,” not “a workflow
engine I need to operate.”

## Information architecture

| Surface | Primary job | Relationship to conversation |
|---|---|---|
| Home / Today | Start or resume work; see active work and recent context | Shared composer and continuity launchpad |
| Chat | Ask, plan, build, approve, recover, and receive results | Primary working surface |
| Projects | Preserve chats, missions, files, decisions, and context | Context boundary for new and existing chats |
| Missions | Portfolio of durable work across conversations | Opens the originating conversation; detail is secondary |
| Library | Keep reports, sites, diffs, documents, results, and skills | Receives durable outputs from completed work |
| Memory | Inspect and control what Morrow knows and applies | Explains how prior context changes later work |
| Connections | Configure cloud and local model readiness | Prevents doomed work before it starts |
| Settings | Appearance, working defaults, memory, and local data | Global preferences, not operational controls |

Desktop navigation is a narrow sidebar with recent conversations as the continuity
spine. Mobile uses **Home · Chats · New · Missions · More**; secondary surfaces
remain reachable through More. No unfinished surface should masquerade as complete.

## Chat, modes, and missions

The composer presents intent, not orchestration:

| Mode | User promise | Existing backend mapping |
|---|---|---|
| Ask | Help without making changes | `read-only` |
| Plan | Research and plan without making changes | `plan-only` |
| Build | Do the work; ask at consequential decisions | `agent`, `autoApprove: false` |
| Build Auto | Own routine decisions and recover until criteria are met | `agent`, `autoApprove: true` |

Ask/Plan never need a mission. Substantial Build/Build Auto work can become a
mission without moving the user to a separate debug page. The conversation shows
plain-language progress, approval, recovery, and completion. The panel exposes the
authoritative plan, evidence, provider/model, applied memory, and activity when
needed. Build Auto never bypasses dangerous-action or permission boundaries.

## Memory and adaptation

The Memory surface is organized around user meaning rather than storage internals:

- **About you:** explicit cross-project personal profile.
- **How you like to work:** communication, quality, approval, and validation rules.
- **Current goals:** active outcomes Morrow should carry forward.
- **Project memory:** architecture, decisions, conventions, risks, and local rules.
- **Lessons:** evidence-backed outcomes from prior chats and missions.
- **Skills:** visible, scoped, versioned workflows with permissions and provenance.

Every item must remain editable, confirmable, rejectable, enable/disableable,
pinnable, and deletable. Sensitive candidates require explicit confirmation.
Project memory remains project-isolated. Adaptation must be demonstrable—for
example, a saved “inspect UI in a real browser” rule appearing in a later mission's
acceptance plan.

## Journey coverage

| Journey | Prototype evidence | Gate health |
|---|---|---|
| Normal conversation | `chat-normal-desktop-light` | Clear chat, no mission created |
| Complex work becomes a mission | active mission desktop/tablet/mobile | Mission stays in conversation |
| Build Auto | active mission with Build Auto selected | Autonomy visible without debug language |
| Provider readiness | Connections + recovery | Friendly state; no raw HTTP/provider error |
| Consequential approval | approval desktop/mobile | What, why, consequence, alternative, choices |
| Recovery | recovery light/dark | Preserved progress and actionable options |
| Project continuity | project desktop | Chats, mission, files, and project memory together |
| Memory learning | Memory desktop/mobile + applied rule in mission panel | Transparent and visibly applied |
| Completed work | completed result + Library | Evidence, caveat, deliverables, and durable output |

## Visual direction and audit outcome

- Warm off-white and deep-neutral themes; restrained violet accent.
- Normal-sized headings, readable body copy, generous but purposeful spacing.
- Minimal borders and status pills; no operational dashboard chrome.
- Home is personal and useful without an active mission.
- Technical detail is progressively disclosed through the mission panel.
- Approval and recovery use plain language and preserve the user's place.

The prototype audit found and resolved: visible prototype controls, missing mobile
navigation, conflated mission/approval states, a non-working mobile detail action,
contradictory provider copy, raw transport/checkpoint language, placeholder-style
Library tiles, a Settings navigation dead end, clipped mobile composer controls,
mobile approval clipping, missing focus treatment/labels, reduced-motion handling,
small touch targets, and low-contrast text.

## Validation evidence

`node .\docs\redesign\prototypes\capture.mjs` renders 26 accepted states at
1600×1000, 1024×900, and 390×844. The latest report records:

- zero Axe violations in the captured static states;
- zero page or console errors;
- zero detected horizontal viewport overflow;
- no tested mobile key target below 44×44 CSS pixels;
- visible mobile navigation in every mobile capture;
- a dedicated keyboard-focus capture; and
- successful mobile mission-detail open/close interaction.

This is strong prototype evidence, not a claim that the future production app is
fully WCAG-conformant. Streaming, async state, forms, screen-reader journeys, zoom,
and real backend failure paths still require production acceptance testing.

Repository verification at this gate: `pnpm.cmd check` passed 7/7 packages plus
repository validation, `pnpm.cmd build` passed 6/6 build targets, and the web unit
suite passed 154/154 serially. The repo-wide `pnpm.cmd test` remains red on one
pre-existing contracts fixture: `test/web.test.ts` omits the now-required
`summary.modelLabel`. The same mismatch exists at pre-design-gate head `5fcf966`,
and this design-only change does not touch `packages/contracts`. It is recorded,
not silently fixed, because production code is outside this approval gate.

## Screenshot index

All accepted captures live in [`prototypes/shots/final`](prototypes/shots/final).

| Area | Captures |
|---|---|
| Home | `home-desktop-light`, `home-desktop-dark`, `home-tablet-light`, `home-mobile-light` |
| Keyboard | `home-keyboard-focus-desktop-light` |
| Chat | `chat-normal-desktop-light` |
| Active mission | `chat-active-mission-desktop-light`, `chat-active-mission-desktop-dark`, `chat-active-mission-tablet-light`, `chat-active-mission-mobile-light` |
| Mission detail | `chat-mission-detail-mobile-light` |
| Approval | `chat-approval-desktop-light`, `chat-approval-mobile-light` |
| Recovery | `chat-recovery-desktop-light`, `chat-recovery-desktop-dark` |
| Completion | `chat-completed-result-desktop-light` |
| Projects / Missions | `project-desktop-light`, `missions-desktop-light` |
| Memory | `memory-desktop-light`, `memory-desktop-dark`, `memory-mobile-light`, `memory-mobile-dark` |
| Library | `library-desktop-light` |
| Connections | `connections-desktop-light`, `connections-desktop-dark` |
| Settings | `settings-desktop-light` |

Representative files:

- [`home-desktop-light.png`](prototypes/shots/final/home-desktop-light.png)
- [`chat-active-mission-desktop-light.png`](prototypes/shots/final/chat-active-mission-desktop-light.png)
- [`chat-approval-mobile-light.png`](prototypes/shots/final/chat-approval-mobile-light.png)
- [`chat-mission-detail-mobile-light.png`](prototypes/shots/final/chat-mission-detail-mobile-light.png)
- [`memory-desktop-dark.png`](prototypes/shots/final/memory-desktop-dark.png)
- [`library-desktop-light.png`](prototypes/shots/final/library-desktop-light.png)

## Preserve vs. replace

### Preserve

- Mission lifecycle, controller/guardian, checkpoints, recovery, evidence, and
  truthful completion.
- Conversation/message persistence, streaming task events, project ownership, and
  conversation-to-mission links.
- Provider/model routing, local/cloud choice, server-side secrets, and readiness.
- Project-isolated memory and cortex intelligence with provenance and sensitivity.
- Web API/client, SSE, Query/Router, theme, focus, and live-region foundations where
  they remain compatible.

### Replace or evolve

- Replace the mission-console shell and Home mission launcher.
- Replace standalone mission-detail navigation with in-chat cards plus a panel.
- Evolve UI tokens/components into the quiet chat-first system.
- Add stable secret-free browser projections for conversations, projects, memory,
  Library, and chat events.
- Add the missing learned-skill read controls and memory propose/confirm surface.

## Production migration strategy after approval

1. **Freeze contracts and read models.** Add backwards-compatible browser
   projections and characterize existing routes before UI replacement.
2. **Ship the conversation spine.** New shell, Home, composer, persisted chat,
   streaming/reconnect, modes, and provider-readiness guard behind a feature flag.
3. **Integrate missions into chat.** Reuse existing mission snapshots/SSE;
   implement compact card, approval/recovery/result states, and detail panel.
4. **Add continuity surfaces.** Projects, Library projections, and recent chats.
5. **Surface controlled adaptation.** Memory UI, propose/confirm, applied-memory
   evidence, then learned-skill list/enable/disable.
6. **Run real acceptance.** Desktop/mobile, light/dark, refresh/reconnect, provider
   failure, project isolation, permissions, browser accessibility, and rollback.
7. **Remove the old presentation only after parity.** Keep the old route available
   behind the flag until the new slice passes evidence-backed acceptance.

Rollback is presentation-only: disable the feature flag and return to the existing
web shell. No backend store is discarded, rewritten, or destructively migrated in
the initial slices.

## Known prototype limitations

- Static mock data; no live persistence, streaming, provider auth, files, tools, or
  permission execution.
- Send, model setup, memory mutation, Library actions, and most secondary buttons
  demonstrate placement/copy rather than completed workflows.
- The mobile More drawer and full model picker are specified but not built in this
  gate prototype.
- The validation report covers rendered states, not real asynchronous races,
  reconnect behavior, authentication, project isolation, or security boundaries.
- Final production typography and icon packaging should use the repository's
  approved assets and bundle strategy.

## Exact approval checklist

Please approve or request changes to:

- the chat-first thesis and eight-surface information architecture;
- the Ask / Plan / Build / Build Auto mental model;
- missions embedded in conversations with secondary detail panels;
- the Memory and visible-adaptation model;
- the calm light/dark visual language and responsive navigation;
- the approval, recovery, project-continuity, and result treatments; and
- the staged preserve-first migration strategy.

No production frontend implementation or database migration begins until this gate
is explicitly approved.
