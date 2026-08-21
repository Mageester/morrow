# Next-session handoff — AI teammates, and a UI that deserves them

Paste the block below into a fresh Claude Code session at the repo root.

---

You are picking up Morrow (`/home/dread/Code/morrow`), a self-hosted local-first
AI agent. Branch `eval/harness-comparison` is ahead of `main` with a completed
cross-harness eval; read `docs/harness-comparison-2026-08-20.md` first. Test
suite is ~2,269 tests in ~44s via `npx vitest run --maxWorkers=4` in
`services/orchestrator`. Keep it green.

The goal of this session: Morrow has one conversation with one assistant. The
product it should be is **a roster of named AI teammates you message like
colleagues**, each holding its own job, memory and tools, working in parallel
and handing work between themselves — and a UI that makes that legible.

The reference is `https://x.ai/bot` (Grok Bot). Open it before you start. Read
it for *interaction patterns and information density*, not for assets — see
"What not to copy" below, which is a hard constraint, not a style note.

## What the last session left

Steps 2 and 3 of `docs/tasks/next-session-handoff.md` are **unfinished** and
still worth doing; this session's work does not replace them.

- Step 1 (comparative eval) is **done**. Morrow lost: 92% pass rate to pi's 96%,
  at 2.4x the cost per task. `benchmarks/harness-comparison/`.
- Step 2 (ablation) has its **mechanism but no results**. `MORROW_ABLATE` in
  `services/orchestrator/src/execution/ablation.ts` disables individual
  subsystems; nothing has been run through it yet.
- Step 3 (splitting the 6,699-line `agent.ts`) is **untouched**.
- One open measurement blocks step 2's conclusions: Morrow's per-turn token cost
  is measured but unattributed. `prefix-stability.ts` ruled out cache churn;
  per-request `[input, cached]` capture is instrumented but has never run. Do
  not cut any subsystem before that number exists.

If this session's feature work touches `agent.ts`, prefer extracting a seam over
patching inline — that is step 3's direction and it is cheaper to do while you
are already in the file.

## Do not rebuild what exists

This feature is mostly **surfacing and connecting primitives Morrow already
has.** Read these before designing anything:

| You need | It already exists |
| --- | --- |
| Named agents with own instructions/model/budgets | `AgentSchema` in `packages/contracts/src/index.ts:604` |
| Teams, delegation, shared-memory policy | `packages/contracts/src/teams.ts`, `repositories/{agents,teams,delegations}.ts` |
| Parent/child task delegation in the loop | `agent.ts` — `assignedAgent`, `assignedDelegation`, `buildAgentExecutionPolicy` |
| Per-agent memory read/write scopes | `memoryReadScopes` / `memoryWriteScopes` on `AgentSchema` |
| Scheduled/recurring work | `services/orchestrator/src/schedule/` |
| Signing in to real tools, using a browser | `services/orchestrator/src/browser/`, `src/mcp/` |
| Learning a repeated procedure | `src/cortex/` + `src/skills/` (Cortex already observes evidence-backed repeated procedures) |
| A teams page to grow from | `apps/web/src/features/teams/teams-page.tsx` |

The honest gap analysis is: the **domain model is largely there and the surface
is not**. Budget accordingly — if you find yourself designing a new agent
schema, stop and go read the existing one.

## Step 1 — Make the roster real, in the UI

The single biggest change is conceptual: the left rail stops being a list of
*conversations* and becomes a list of *teammates*.

Each row: avatar, name, last line of what it did, timestamp, and a live status
(working / waiting on you / idle). Selecting one opens the thread with that
teammate. A "New agent" affordance creates one with a name, a job description
(its `instructions`), and optionally its own model.

Ship this against real data from the existing agents API. Do not mock it.

Gate: you can create two agents, give each a task, and watch both progress in
one window.

## Step 2 — Inline work, not a wall of text

The reference's strongest idea is that tool work is **shown as compact,
scannable evidence** rather than narrated in prose. A step is one line: what
tool, what target, what result. Screenshots and command output are collapsed
cards you can open, not inline dumps.

Morrow already records everything needed — `task_evidence`, tool call records,
`activity-panel.tsx`, `work-summary.tsx`. This is a presentation change over
existing durable data.

Gate: a completed task reads as a scannable list of what happened, and the
evidence is one click away from each line.

## Step 3 — More than one teammate in a thread

Let a thread contain several agents that pass work between themselves, with the
handoffs visible ("Asking Research…", "Looping in Comms…"). Morrow's delegation
records already carry parent/child structure; this is largely a projection.

Keep the authority model intact: a delegation's effective budget is the
intersection of the agent's own ceiling, the team default, and the parent task's
authority, computed server-side. **Never widen it from agent output.** That rule
already exists in the code and it must survive this feature.

Gate: a two-agent thread completes work with each handoff visible and each
agent's budget enforced independently.

## Step 4 — Teach a routine by demonstration

"Watch me do this once, then do it yourself." Cortex already observes repeated
procedures and `create_skill` exists but is deliberately gated behind explicit
user request. The feature is an explicit *record mode*: the user opts in, works
through a task, and Morrow proposes a named routine at the end.

Do this last. It is the least well-supported by existing primitives and the
easiest to get wrong, and steps 1–3 deliver most of the value without it.

## UI direction — concrete deltas

Morrow's current system (`apps/web/src/styles/premium/tokens.css`) is a warm
editorial one: paper/charcoal ground, copper accent, Georgia display serif,
194px rail, 286px activity panel. It reads like a publication.

The reference reads like a workspace. The measured deltas:

| | Morrow today | Direction |
| --- | --- | --- |
| Ground | warm charcoal / paper | near-black, cool neutral (reference body is `rgb(10,10,10)`) |
| Type | Georgia serif display + Inter | sans throughout; display weight, not a serif |
| Density | editorial, generous | denser rows, more information per screen |
| Rail | conversation list, 194px | teammate roster with avatars and status |
| Accent | copper | one saturated accent, used sparingly for status |
| Radius | 9–22px | keep — the reference is similarly rounded |

**Keep light mode.** It is an existing user capability with a Settings control,
and dropping it to chase a dark reference would be a regression. Build the dark
system first, then the light counterpart with identical geometry.

**Keep the system-font rule.** `tokens.css` says "System stacks only — nothing
is fetched over the network." That is a privacy property of a local-first
product, not a stylistic choice. The reference uses a proprietary webfont; you
cannot and should not.

## What not to copy

This matters and it is not negotiable.

- **No assets, fonts, logos, icons, illustrations, or copy from x.ai.** Their
  typeface (`universalSans`) is licensed to them. Take layout ideas and
  information hierarchy; write your own words and ship your own marks.
- **Do not clone their brand identity.** A Morrow that looks like a Grok Bot
  reskin is both a legal exposure and a worse product — it tells users you have
  no point of view. Adopt the *patterns*: roster-as-rail, evidence-as-rows,
  visible handoffs, status-first density. Render them in Morrow's own identity.
- **Do not reproduce their product claims.** "Its own computer", "signs into
  your tools", "24/7" are marketing statements about their infrastructure. State
  only what Morrow actually does, verified.

If you find yourself matching a hex value from their stylesheet, you have
crossed from inspiration into copying. Derive Morrow's dark palette from
Morrow's existing charcoal ramp instead.

## Out of scope

Licensing, macOS packaging, the landing site
(`docs/tasks/landing-redesign-prompt.md`), and pricing surfaces. The reference
site sells a $200/month product; that is not what you are building today.

## Delivering

Work on a branch off `eval/harness-comparison`. Commit in logical units with
real messages. Do not push.

Two standing requirements:

1. **Every step ships against real data.** A roster of fake agents proves
   nothing. If a step cannot be wired to the real API in the time available,
   ship fewer steps rather than a mock.
2. **Screenshot each gate.** The whole premise is that the current UI "is not
   it". A claim that the new one is better should be something the user can
   look at, not something you assert. `mcp__Claude_Browser__*` drives the dev
   server; `pnpm dev:app` serves the app at `http://127.0.0.1:4318/app/`.
