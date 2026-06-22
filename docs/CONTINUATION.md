# Continuation

> Always names the **exact** next step so any agent (or a fresh session) can
> resume without re-deriving context. Update this at every interruption.

## Resume command

```bash
cd "C:/Users/aidan/OneDrive/Documents/PlaceHolder"
git checkout feat/morrow-agent-terminal
pnpm install
pnpm check && pnpm test && pnpm build   # expect green
```

## Where we are (all committed + pushed on feat/morrow-agent-terminal)

- Durable docs maintained (parity matrix, master goal, backlog, status, this).
- **B1 — Full-text search: VERIFIED.**
- **B2 — Memory provenance + pin + tiers: VERIFIED.**
- **B3 — Loop detection: VERIFIED.**
- **B22 (partial) — Security hard-blocks: VERIFIED** (force-push, network-exfil,
  workspace-redirect escape, enforced before approval; YOLO cannot bypass).
- **B8 (partial) — Idempotent task creation: VERIFIED** (partial unique index +
  `Idempotency-Key` replay on inspect-workspace). REMAINING: `/retry` route +
  agent-chat creation path.
- **B10 (partial) — Live provider fallback: VERIFIED** (`openStreamWithFallback`,
  retryable-only, no mid-stream switch, `provider.fallback` event). REMAINING:
  explicit rate-limit guard/backoff.
- **B4 — Skill usage tracking + skill→slash: VERIFIED** (`skill_usage` table,
  repo, API, CLI client; verified skills → `/skill:<id>` wired + invoked).
- **B8 — Idempotency + retry: VERIFIED** (idempotent creation + `/retry`).
- Baseline: orchestrator 215 tests, CLI 112, contracts 4, web 8 — all green.
  `pnpm check/test/build` green.

## Exact next step — B5 Skill Creator (interview → generate → verify → install)

Goal: let the user describe a skill in natural language and have Morrow generate,
**sandbox-verify**, permission-review, and (on approval) install it into the
local skills directory. This is the marquee remaining capability and unblocks B6
(Curator: dedupe/improve/stale/pin/backup/rollback).

1. New `services/orchestrator/src/skills/creator.ts` (pure, testable):
   - `generateSkillFiles(spec)` → `{ "SKILL.md", "manifest.json",
     "permissions.json", entrypoint }` content map. `spec` = `{ id, name,
     description, instructions, requestedTools, requestedFilesystemScopes,
     requestedNetworkDomains, requiredSecrets, supportedPlatforms, riskClass }`.
     Compute `manifest.checksum = sha256(SKILL.md)` so the generated bundle
     passes `verifySkill` (mirror the hash in `apps/cli/src/skills/registry.ts`).
   - `validateSkillSpec(spec)` → list of issues (id kebab-case, non-empty
     instructions, tools ⊆ a known allow-list, no secret values inlined).
2. New `installSkill(root, files)` that writes the bundle to a temp dir, runs the
   same verification as `verifySkill`, and only on success moves it into
   `<root>/<id>` (refuse to overwrite an existing skill — that's a Curator
   update, B6). Return `{ installed, directory, issues }`.
3. Contracts: `CreateSkillSpecSchema` for the spec. Orchestrator route
   `POST /api/skills/preview` (returns generated files + verification, no write)
   and `POST /api/skills/install` (writes after a verified preview).
4. CLI `apps/cli/src/commands/skills.ts` — extend the existing `skills create`
   (currently a stub usage error) into an interview: prompt for name/description/
   instructions/tools, show the generated permissions for review, then install on
   confirm. Reuse `localSkillsRoot()`.
5. Tests first (red) — `test/skill-creator.test.ts`:
   - "generated bundle passes verifySkill (checksum matches)"
   - "validateSkillSpec rejects a bad id / unknown tool / inlined secret"
   - "installSkill writes a verified bundle and refuses to overwrite an existing
     skill". Plus a CLI test that the generated files round-trip through
     `discoverSkills`/`verifySkill`.
6. `pnpm check && pnpm test && pnpm build`. Update matrix §6 rows → VERIFIED +
   status. Commit `feat(skills): skill creator (generate, verify, install)` + push.

## Failing test to write first

`test/skill-creator.test.ts` — "a generated skill bundle passes verifySkill
because its manifest checksum matches the generated SKILL.md".

## Deferred (pick up later)

- **B8 idempotency** on the agent-chat creation path
  (`POST /api/conversations/:id/messages`) via the existing `readIdempotencyKey`.
- **B10 rate-limit guard:** token-bucket/backoff before B10 is fully closed.
- **B6 Curator** follows B5: dedupe (similarity over installed SKILL.md),
  improve successful skills, stale/archive lifecycle, pin, backup, rollback.

## Bigger remaining (multi-session)

B7 cron/scheduler + isolated runs + notifications; B9 execution backend interface
+ Docker/SSH; B11 MCP client; B13 LSP diagnostics; B14 worktrees + subagents;
B15 browser; B16 desktop; B17 messaging adapters; B18 doctor/updater/uninstall;
B19 Windows/Ubuntu installers; B20 Hermes import; B21 TUI live task tree/Ctrl+K/
persisted history. Full Hermes parity is multi-session — this file is the handoff.

## Broader remaining backlog (see MORROW_BACKLOG.md)

Highest-value, CI-testable next: B10 live provider fallback-on-error, B4 skill
usage tracking + skill→slash, B5 Skill Creator. Heavier/needs-environment: B7
cron, B9 Docker/SSH backends, B11 MCP client, B15 browser, B16 desktop, B17
messaging, B19 installers. Full Hermes parity is multi-session; this file is the
handoff each time.
