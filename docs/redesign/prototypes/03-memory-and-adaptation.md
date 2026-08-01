# Morrow Redesign — Phase 2: Memory & Adaptation Model

> How Morrow "learns how you think, remembers what matters, and gets more useful
> every time." This is a product capability, not marketing. It reuses the existing
> deterministic memory store (`memory_entries`, project-isolated, no vector DB) and
> cortex learning — the redesign gives them a transparent, controllable home.

## 1. Principle

Morrow does not retrain a foundation model. It improves through **persistent, controlled context and learned workflows**: what it remembers about you and your projects, and the reusable skills it distills from proven work. Every remembered thing is inspectable, editable, and reversible. Nothing is captured silently.

## 2. The five memory layers → existing schema

The brief's five layers map cleanly onto the shipped `MemoryScope` / `MemoryType` enums — no new store required, only presentation and a couple of thin routes.

| Vision layer | What it holds | `scope` | representative `type` | Home |
|---|---|---|---|---|
| **Personal profile** | Stable facts about the user: goals, hardware, tools, responsibilities, constraints, communication style. | `user_global` / `user` | `user_preference` | Memory → **About you** (cross-project) |
| **Working preferences** | How you like work done: response style, approval tolerance, quality bar, preferred models, formatting, frustrations. | `user` | `communication_preference`, `user_preference` | Memory → **How you like to work** |
| **Project memory** | Purpose, decisions, architecture, rejected approaches, status, backlog, key files, definitions of done, recurring failures. | `project`, `repository`, `subtree` | `project_architecture`, `architectural_decision`, `repository_convention`, `protected_file`, `recurring_risk` | Project → Memory (+ cortex intelligence) |
| **Episodic** | Time-stamped events from important conversations and missions: decisions, outcomes, failures, recoveries, feedback, corrections. | `episodic`, `mission` | `successful_approach`, `failed_approach` | Memory → **Lessons** / mission timeline |
| **Outcome learning** | Post-work evaluation distilled into durable lessons (see §4). | `procedural`, `knowledge` | `validation_expectation`, `successful_approach`, `failed_approach` | Memory → **Lessons** |

Every entry already carries: `source` (user / summary / cortex), `evidenceReferences` (provenance), `lifecycle`, `pinned`, `enabled`, `confidence` (0–1), `usageCount` / success / failure contribution, `staleness`, `sensitivity` (public→secret), `lastVerifiedAt`, timestamps. That is exactly the metadata a transparent Memory UI needs.

## 3. Memory UI contract ("About You", never invasive)

Sections, each a list of editable cards:

- **About you** — personal profile (cross-project). e.g. *"Building the Morrow Project."* · *"Windows + Fedora; desktop has an RTX 4070."* · *"Cares about advanced AI-agent workflows."*
- **How you like to work** — e.g. *"Be direct; avoid fake productivity."* · *"Continue complex tasks until genuinely complete."* · *"Hide internal engineering detail unless useful."* · *"Manually inspect visual work before declaring done."*
- **Current goals** — e.g. *"Turn Morrow into a real product."* · *"Improve long-running autonomy."*
- **Project memory** — per active project (with cortex architecture/decisions/conventions/risks/rules folded in).
- **Lessons** — outcome-learned items with the mission/feedback that produced them.
- **Skills** — learned workflows (see §5).

Each card exposes: **edit · confirm · reject · enable/disable · pin · delete**, plus **source/provenance**, **scope** (global/project), **confidence**, **sensitivity**, and **last used**. Controls map to existing routes (`PATCH`/`DELETE /api/memory/:id`, `CreateMemoryEntrySchema`, cortex `rules`/`conventions` routes). No embeddings, vectors, or raw retrieval scores are shown.

## 4. Outcome learning loop

After meaningful work (a mission or a substantial chat), Morrow evaluates and may distill a lesson:

- Did the user accept the result? What was rejected? What needed correction?
- Which workflow / model / agent performed best? What wasted time? What should change next time?

The result is a candidate memory (`lifecycle: candidate` → `evidence_collected` → `active`) or a learned skill. Candidates are **proposed to the user, never silently promoted** (see Journey 8). The canonical worked example from *this* engagement:

> **Lesson:** "Passing automated tests does not prove consumer-quality UX. For this user, frontend completion requires direct browser inspection and visual approval."
> *(scope: user · type: validation_expectation · source: user feedback · confidence: high)*

The backend already extracts evidence-backed mission learnings (`mission/learning-extractor.ts`, `cortex/automatic-memory.ts`); the redesign surfaces them for confirmation instead of leaving them invisible.

## 5. Learned skills

`LearnedSkill` is fully modeled (scope, semver `version`, `triggerConditions`, `steps`, `permissions` [tools/filesystem/network/secrets], `validationRequirements`, `provenance`, `state` candidate→validating→active→superseded→rolled_back, success/failure counts, confidence, rollback history) and produced by `cortex/automatic-skills.ts`. It has **no HTTP routes or UI yet** — the one net-new backend surface the redesign must add (list/get/enable/disable, scoped read).

Example the user should see:

> **Skill — "Morrow release acceptance"** (v1.2.0 · project-scoped · active · 4✓/0✗)
> Steps: test a clean consumer install → connect a real provider → run a real mission → inspect desktop **and** mobile UI → verify recovery → challenge unsupported completion claims → **do not approve on tests alone.**
> Permissions: read-only + browser. Origin: distilled from missions M-118, M-121.

Skills are **visible, editable, versioned, disableable, scoped (global or project), traceable to origin, and never silently granted dangerous permissions.** Permission changes and new dangerous scopes require explicit user consent.

## 6. Adaptation is demonstrable

A completion criterion (§8 of the product spec) is that Morrow can **show adaptation from prior feedback**. Concretely: once the "browser inspection before done" lesson is saved, a later Build/Build-Auto mission's acceptance criteria automatically include a manual browser-inspection step, and the mission panel shows *"Applied your rule: inspect UI in a real browser before declaring complete."* This closes the loop from feedback → memory → changed behavior, visibly.

## 7. Safety

- Sensitive/secret memories are gated and never auto-saved; suggestions for them require explicit confirmation.
- Personal profile (cross-project) is a deliberate, separate scope; project memory cannot read it unless surfaced by the user.
- Skills never gain filesystem/network/secret permissions without explicit approval; Build Auto cannot escalate a skill's permissions.
- All memory/skill mutations are auditable.
