# Continuation handoff — AI teammates

Branch: `feat/agent-teammates` (off `eval/harness-comparison`). 11 commits, not
pushed. Both suites green at handoff:

- `services/orchestrator`: **2,314 passed**, 5 skipped, 226 files (~44s via
  `npx vitest run --maxWorkers=4`)
- `apps/web`: **362 passed**, 51 files
- `packages/contracts`: 80 passed

Run the app with `pnpm dev:app` → `http://127.0.0.1:4318/app/`. The orchestrator
is on 4317; Vite proxies `/api` to it.

---

## What was asked, and where it stands

The brief (`docs/tasks/agent-teammates-handoff.md`) had four steps. All four are
built and each one's gate was demonstrated against the real local database with
real provider calls, not fixtures.

| Step | State | Gate evidence |
| --- | --- | --- |
| 1. Roster in the rail | Done | Two teammates created through the UI, each given a task, both visible progressing in one window |
| 2. Inline work as evidence | Done | A completed turn reads as a scannable list; each line opens the real recorded output |
| 3. Multiple teammates per thread | Done | Research's thread handed work to Comms; the handoff row and Comms's answer are both visible in it |
| 4. Teach a routine by demonstration | Done | Recorded a span, named the proposal, saved it; it lists on Skills and is runnable |

Mid-session the user redirected twice, and both redirections are also done:

- **"The UI must be extremely close to Grok Bot… the bots should feel like
  texting a team member."** The visual system was rebuilt: cool near-black
  ground, sans throughout at a 14/20 working scale, message bubbles with
  bylines and clock times, denser rows, pill-shaped controls.
- **"The agent needs to know its specific purpose."** This was a real defect —
  see below. Fixed and verified.
- **"Upgrade the logo assets"** and **"the logo isn't very clean looking."**
  Done; the mark was redrawn (see below).

---

## The three things most worth knowing

### 1. A teammate's job description never reached the model

`agent.ts` opened every run with `You are Morrow, a secure personal AI coding
assistant`, and `assignedAgent.instructions` was **never read anywhere**. A
specialist called "Research" with a written job was told on every turn that it
was a general coding assistant.

Fixed in `services/orchestrator/src/execution/teammate-identity.ts` (a new seam,
extracted rather than inlined because `agent.ts` is the file the repo is trying
to shrink). Verified live — asked the Research teammate who it was:

> "I'm Research, your teammate on the morrow-axiom-site project, and my job is
> to answer questions about this project from what's already written down —
> reading only, never changing files."

**If you change prompt assembly, do not regress this.** The brief is a separate
system message placed *after* the core prompt, and it must stay unable to widen
anything: tools, memory scopes and budgets come from
`buildAgentExecutionPolicy` over durable rows.

### 2. The transcript projection must not carry command output

`test/conversations.test.ts` has a deliberate invariant test asserting that
`/activity` never exposes raw arguments, output, provider text or private
reasoning. An early draft of step 2 broke it by folding a stdout head into the
projection; that was reverted.

The shipped design instead puts a **handle** (`evidenceRef`, an id the entry was
already keyed on) in the projection, and serves output from a separate
on-demand endpoint. Keep that split. It is also what lets a run with two hundred
steps stay two hundred lines instead of two hundred logs.

### 3. Delegation still requires a team; handoffs deliberately do not

`delegations.team_id` is `NOT NULL`, so roster teammates (which are team-less by
necessity — a team agent cannot run a direct thread, see
`TEAM_AGENT_REQUIRES_DELEGATION` in `task-dispatcher.ts`) cannot use the
delegation tables. Thread handoffs therefore project from `tasks.parent_task_id`
+ `tasks.agent_id` instead, and the handoff route **refuses team agents
outright** so their team-level ceiling is never skipped.

If you want handoffs to carry objectives and acceptance criteria durably, that
means making `team_id` nullable — a SQLite table rebuild. It was judged not
worth the risk for this slice.

---

## Map of the change

### Server (`services/orchestrator`)

| File | What it is |
| --- | --- |
| `database.ts` migrations 52, 53 | `conversations.agent_id`; `routines` + `routine_recordings` |
| `web/roster-projection.ts` | The rail's projection. Every query bounded and index-backed — it is polled |
| `web/tool-evidence.ts` | One step's recorded output. Returns the result, **refuses the arguments** |
| `web/handoff-projection.ts` | Handoffs in a thread, projected from child tasks |
| `web/routine-proposal.ts` | Reads a recording back as a proposed routine; renders a routine as a message |
| `execution/teammate-identity.ts` | Who a run is, and its standing brief |
| `repositories/routines.ts` | Routines + recordings |
| `mission/task-dispatcher.ts` | A message inherits the conversation's agent; a mismatched one is refused (409) |

Routes added: `GET /projects/:p/roster`; `GET/POST/DELETE
/projects/:p/conversations/:c/recording`; `GET/POST
/projects/:p/conversations/:c/handoffs`; `GET
/projects/:p/conversations/:c/tasks/:t/evidence/:callId`; `GET/POST
/projects/:p/routines`; `DELETE /routines/:id`; `POST /routines/:id/run`.

### Web (`apps/web`)

`features/roster/` (rail, avatar, hiring panel, hooks), `features/chat/`
(`evidence-card`, `handoff-row`, `ask-teammate`, `record-routine`, rewritten
`work-summary`), `features/skills/routines-panel.tsx`,
`components/morrow-mark.tsx`, `styles/premium/roster.css` plus a rewritten
`tokens.css`.

### Two incidental repairs

- **`apps/web/vite.config.ts`** — the dev proxy honoured an ambient `PORT` even
  when it named Vite's own port, making every API call an opaque 502.
- **`apps/web/src/test-setup.ts`** — the web suite was **fully red before any of
  this work** on Node 26: a built-in `localStorage` global resolves to
  `undefined` without `--localstorage-file` and shadows jsdom's, so 95 tests
  threw before their first assertion. The harness now installs a real Storage.

---

## What is NOT done

### From the original brief, still open

These predate this session and are untouched:

1. **Ablation results.** `MORROW_ABLATE` exists in
   `services/orchestrator/src/execution/ablation.ts`; nothing has been run
   through it.
2. **Per-turn token attribution.** `prefix-stability.ts` ruled out cache churn;
   per-request `[input, cached]` capture is instrumented but has never run.
   **Do not cut any subsystem before that number exists.**
3. **Splitting the 6,699-line `agent.ts`.** One seam was extracted this session
   (`teammate-identity.ts`); the rest stands.

### Known rough edges in what shipped

- **`completedAt` is null on completed handoffs.** `tasks.completed_at` is not
  being set on the path these children take, so `ThreadHandoff.completedAt`
  reads null even for finished work. The projection is right; the write is
  missing. Low risk, visible in the API.
- **No test covers `RecordRoutine`, `AskTeammate` or `HandoffRow` at the
  component level.** Server behaviour for all three is well covered
  (`test/routines.test.ts`, `test/thread-handoffs.test.ts`); the React pieces
  were verified by driving the real UI, not by unit tests. That is a gap worth
  closing.
- **A routine cannot be edited after saving.** Only run and delete.
- **Only the user can start a handoff.** The model has no delegate tool, so a
  teammate cannot loop another one in by itself. That was deliberate for this
  slice — a tool that spawns agents is a security-sensitive surface per
  `AGENTS.md` — but it is the obvious next step for "acting like Grok Bot".
- **Light mode is correct but less exercised than dark.** Several fixed dark
  values were found and replaced with tokens; assume more remain on surfaces
  not visited (missions, projects, onboarding, pairing).
- **`docs/` was not updated.** No architecture record was written for the roster
  or the routines model.

---

## If you continue the "act like Grok Bot" direction

In rough order of value:

1. **Let a teammate loop in another teammate itself.** Currently only the user
   can. This needs a tool with an approval boundary — read `AGENTS.md`'s
   security-sensitive list first, and route it through the same
   `spawnAgentChatSubagent` path so the child's own policy still applies.
2. **Per-teammate memory actually visible.** `memoryReadScopes` /
   `memoryWriteScopes` exist on `AgentSchema` and are enforced, but the hiring
   panel does not expose them and nothing shows what a teammate has learned.
3. **Scheduled routines.** `services/orchestrator/src/schedule/` exists;
   a routine + a cron expression is most of "runs on its own".
4. **Component tests for the four new chat surfaces**, per the gap above.

## Constraints that still hold

From the original brief, and still binding:

- **No assets, fonts, logos, icons or copy from x.ai.** Layout ideas and
  information hierarchy only. The mark now in the app is Morrow's own, redrawn
  from `img/01_Master`.
- **System font stacks only** — `tokens.css` states why: nothing is fetched over
  the network, which is a privacy property of a local-first product.
- **Do not reproduce their product claims.** State only what Morrow does. The
  routine panel's wording is deliberately careful for this reason: running a
  routine re-asks the teammate with the observed steps as context; it does not
  replay recorded tool calls, and the UI says so.
- **Every step ships against real data.** No mocked rosters, no fixture threads.

## Verifying quickly

```bash
cd services/orchestrator && npx vitest run --maxWorkers=4
```

```bash
cd apps/web && npx vitest run && npx tsc -p tsconfig.json --noEmit
```

Screenshots from the session are not committed; regenerate by driving
`http://127.0.0.1:4318/app/` with Playwright (the orchestrator's dependency) —
`mcp__Claude_Browser__*` screenshots did not work in that session because the
browser pane was not displayed.
