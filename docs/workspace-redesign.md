# Morrow Workspace-First Redesign — Research & IA (pre-implementation)

Status: **research deliverable only**. No UI implementation, no merge, no push until this is reviewed.
Sources: direct inspection of Hermes Agent docs + product pages (Nous Research), plus the repo's own
`docs/hermes-parity.md` and `packages/hermes-compat`.

---

## 1. Hermes research notes (direct inspection)

Hermes = Nous Research's **Hermes Agent** (desktop app + CLI). It is the product Morrow benchmarks against.

### Desktop app
- **Chat-first window, three regions:**
  - **Left rail** — sessions + navigation. Session list with archive, search by session ID, concurrent multi-profile sessions, resume.
  - **Center** — the dominant surface. Streaming responses with **live tool activity** and **structured tool-call summaries** inline as the agent works.
  - **Right preview rail** — renders web pages, files, and tool outputs **side-by-side while chat continues**. Shown when useful, not a permanent page.
- **Composer (bottom of center):** model picker dropdown sits in the composer footer (just left of the mic), always visible — never buried in a menu. Profile/workspace controls are pills in the same footer. Composer history via ↑/↓ arrows; queue editing before send; drag-drop file attach anywhere in the chat.
- **Bottom status bar:** live session state + quick controls (e.g. per-session YOLO/approval toggle) without opening Settings.
- **Model selection:** sticky — persists across restarts. Per-model presets for reasoning effort and fast-mode. Curated model list per provider (not a raw `/models` dump).
- **Secondary surfaces exist but do not dominate:** Skills browser/installer, Cron scheduler, Profiles switcher, Messaging gateway config, Agents / Command Center for orchestration. The file browser is **integrated throughout** — no separate navigation needed to explore a project.

### CLI (first-class)
- Entry: `hermes chat` → REPL. Banner, then a prompt. One-shot: `hermes -z "prompt"`.
- **Status line shows current model + provider.** Tool previews stream during execution (`--quiet` suppresses).
- In-session slash commands: `/model` (switch; `/model <name>` auto-routes to the right provider), `/skills <name>`, `/stop` (soft interrupt), `/rollback` (checkpoint revert), `/kanban`, `/bundles`, `/update`, `/quit`.
- Provider setup wizard outside a session: `hermes model` (OAuth, API keys, endpoints).
- Resume: `hermes chat --continue [name]`, `hermes chat --resume <id>`, `hermes sessions browse` (interactive picker w/ search). `--worktree` for isolated parallel runs. Ctrl+C interrupt.

**The through-line:** one dominant work surface, model/mode/provider always visible in the composer, secondary machinery revealed contextually (right rail) or via panes you opt into — not a permanent navigation tax. Same workspace concept in web and CLI.

---

## 2. Current-Morrow critique (first principles, no defense)

Default screen today is a **Missions table** behind a giant persistent sidebar:

```
New Mission · Missions · Active Runs · Settings
More ▸  Agent Studio · Skills · Browser · Files · Memory · Automations · Approvals · System Health · Install from Source · Help
```

Problems:
- **Architecture-as-navigation.** The sidebar exposes internal subsystems (Agents, Skills, Browser, Files, Memory, Automations, System Health) as top-level destinations. That is an admin dashboard, not an agent workspace.
- **"More" hides clutter, doesn't remove it.** 10 items collapsed under a disclosure is still 10 manual surfaces competing with the work.
- **No dominant work surface.** The default is a list you manage, not a place where the agent works. The user lands on a table, not a composer.
- **Inspection requires page-hopping.** To see a run's files, tools, agents, and approvals you navigate to separate pages instead of seeing them in-context around the active run.
- **Model/provider state is not surfaced where work happens.** (The new slash palette helps, but there is no always-visible model/mode/provider control in the work surface itself.)
- **Backend concepts leak as product features** ("Missions" table, "Active Runs", "Agent Studio", "Install from Source" in the app nav).

---

## 3. Comparison matrix

| Area | Hermes | Current Morrow | Required Morrow redesign |
|---|---|---|---|
| Default screen | Chat workspace, composer ready | Missions **table** | Live agent workspace: project + composer + plan + execution |
| Primary nav | Sessions rail only; everything else contextual | Giant sidebar: 4 primary + 10 under "More" | **Workspace · History · Settings** (+ Approvals only when pending) |
| Work surface | Center chat dominates, streamed tool calls | Shared with table/pages | One dominant conversation + plan + execution surface |
| Model/provider | Picker pill in composer footer, always visible, sticky | Slash `/model` only; no persistent control | Compact provider/model selector in top bar **and** composer; persists per session |
| Mode (Ask/Plan/Agent) | Implicit + per-session toggles in status bar | `composerMode` chips (new) | Explicit Ask / Plan / Agent toggle in the composer, Agent-first |
| Tool calls / plan | Streamed inline timeline + structured summaries | On separate run pages | Inline in the active run: plan steps, active step, tools, files, tests |
| Files / diffs | Right preview rail, contextual | "Files" page | Context drawer: touched files, diffs, previews |
| Agents | Auto-delegated; Command Center pane | "Agent Studio" page | Auto-created; delegated agents shown inline under the run |
| Skills | Slash + Skills pane | "Skills" page | Invoked via slash/auto; usage shown in run timeline |
| Browser | Tool activity | "Browser" page | Browser actions appear as tool activity in the run |
| Memory | Silent; advanced only | "Memory" page | Silent; inspection only in advanced Settings |
| Automations | Cron pane | "Automations" page | Settings or compact secondary workflow |
| Approvals | Inline + per-session toggle | "Approvals" page | Inline when pending; optional inbox only if several |
| System Health | `hermes status` / pane | "System Health" page | Settings → Diagnostics |
| Install | Out-of-app (`hermes model`, installer) | "Install from Source" nav item | Removed from app nav entirely |
| Help | Slash / onboarding | "Help" page | Command palette / onboarding / Settings |
| Sessions / resume | List + archive + search + `--resume`; web/CLI shared | Missions list; no unified resume story | History view; resume same run web↔CLI |
| CLI | First-class REPL, status line, slash, resume, worktree | Exists but secondary | Opens into same workspace concept; shared sessions |

---

## 4. New information architecture

**Primary navigation (max 3):**
- **Workspace** (default) — the live agent surface.
- **History** — past + resumable runs/sessions (replaces the Missions table as a *secondary* view).
- **Settings** — providers/models, automations, memory inspection, diagnostics (System Health), developer mode.

**Conditional:**
- **Approvals** — appears only when ≥1 approval is pending (badge), inline-first.

**Removed from primary nav** (mapped, not renamed):

| Old destination | New home |
|---|---|
| Missions (table) | Demoted to **History**; not the landing screen |
| Active Runs | Folded into Workspace (the active run *is* the workspace) + History for past |
| Agent Studio | Inline delegated-agents panel in the run; advanced authoring in Settings/dev mode |
| Skills | Slash command + run-timeline usage; browser in Settings |
| Browser | Tool activity inside the run |
| Files | Context drawer (touched files, diffs, preview) |
| Memory | Silent; inspection in Settings → Advanced |
| Automations | Settings → Automations |
| Approvals | Inline in run; conditional nav entry only when pending |
| System Health | Settings → Diagnostics |
| Install from Source | Removed from app nav (installer is web/CLI) |
| Help | Command palette + onboarding + Settings |

---

## 5. Wireframe (ASCII)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ TOP BAR                                                                     │
│  ◆ Morrow   [Project ▾]   [openai · gpt-5.4 ▾]   [Agent ▾]   ● ready   ⚙   │
├──────────────┬─────────────────────────────────────────┬────────────────── ┤
│ RAIL (narrow)│ MAIN WORK AREA (dominant)               │ CONTEXT DRAWER     │
│              │                                         │ (only when useful) │
│ ▸ Workspace  │  Goal: "Fix the failing tests"          │  Files changed     │
│ ▸ History    │                                         │   M router.ts +12  │
│ ▸ Settings   │  ▣ Plan                                 │   M models.ts  -3  │
│  (Approvals) │   1. ✓ Inspect test failures            │  ┌──────────────┐  │
│   ·badge·    │   2. ▶ Patch routePreset override       │  │  diff / file │  │
│              │   3. ◻ Run vitest                       │  │   preview    │  │
│              │                                         │  └──────────────┘  │
│              │  ⚙ tool: read router.ts                 │  Agents (2)        │
│              │  ⚙ tool: edit router.ts                 │   ▷ test-fixer     │
│              │  ⚠ approval: run shell `pnpm test`      │  Logs · Browser    │
│              │     [Approve] [Deny]                    │                    │
│              │                                         │                    │
│              │ ┌─────────────────────────────────────┐ │                   │
│              │ │ [Ask|Plan|Agent]  type a goal…   ⏎  │ │                   │
│              │ │ openai·gpt-5.4 ▾   ☑ autonomous     │ │                   │
│              │ └─────────────────────────────────────┘ │                   │
├──────────────┴─────────────────────────────────────────┴────────────────── ┤
│ STATUS BAR:  ● running · step 2/3 · openai gpt-5.4 · Agent · ⏸ pause  ↻    │
└───────────────────────────────────────────────────────────────────────────┘
```

CLI mirror (same concept):
```
morrow › project: morrow   model: openai/gpt-5.4   mode: agent   ● ready
> Fix the failing tests in this project
  ▣ plan
    1 ✓ inspect failures   2 ▶ patch override   3 ◻ run vitest
  ⚙ read router.ts · edit router.ts
  ⚠ approve: pnpm test  [y/n]
  /model  /plan  /agent  /stop  /rollback  /resume  /skill
```

---

## 6. Routes to remove / merge / hide (implementation checklist — NOT yet done)

- **Default route** → `Workspace` (live run), not Missions.
- **Remove from nav:** `agents`, `skills`, `browser`, `files`, `memory`, `automations`, `system`, `download`, `help`.
- **Merge:** `projects`(Missions)+`runs` → History (secondary); active run → Workspace.
- **Hide/conditional:** `approvals` → inline + conditional nav badge.
- **Relocate to Settings:** automations, memory inspection, system/diagnostics, developer/Studio authoring.
- **Add:** top-bar project + provider/model + mode controls; context drawer; status bar; Ask/Plan/Agent in composer (reuse existing `composerMode`).

---

## 7. Acceptance criteria the redesign must satisfy

Launch → open project → select provider/model → enter one goal → watch plan appear → watch file inspection →
watch tools execute → approve one action → see files changed → see tests run → cancel & resume → close & continue later →
resume same run from CLI — all without visiting multiple pages.
