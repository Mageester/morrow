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
- **B5 — Skill Creator: VERIFIED** (`apps/cli/src/skills/creator.ts`,
  `skills create` interview/flag flow; generated bundles pass `verifySkill`).
- Baseline: orchestrator 215 tests, CLI 119, contracts 4, web 8 — all green.
  `pnpm check/test/build` green.

## Exact next step — B6 Skill Curator (dedupe, improve, lifecycle, backup)

Build on `apps/cli/src/skills/creator.ts` (`installSkill({overwrite})` already
supports controlled replacement). Keep it CLI-side alongside the registry.

1. New `apps/cli/src/skills/curator.ts` (pure where possible):
   - `findDuplicates(root, candidateSkillMd)` → list of installed skill ids whose
     SKILL.md is "near-duplicate" of the candidate. Use a cheap deterministic
     similarity: normalize whitespace/case, tokenize to a word set, Jaccard ≥ a
     threshold (e.g. 0.8). No network, no LLM.
   - `backupSkill(root, id)` → copy `<root>/<id>` to
     `<root>/.backups/<id>/<ISO-timestamp>/`; `listBackups(root, id)`;
     `rollbackSkill(root, id, timestamp)` → restore a backup over the live skill
     (verify after restore; refuse if the backup fails verification).
   - `markStale(root, id)` / `archiveSkill(root, id)` → move to
     `<root>/.archive/<id>/` (out of discovery) and back.
   - Pin: store pinned ids in config (`skills.<id>.pinned`) so the curator never
     auto-archives a pinned skill; surface in `skills list`.
2. CLI `apps/cli/src/commands/skills.ts` — add subcommands: `dedupe`,
   `backup <id>`, `backups <id>`, `rollback <id> <timestamp>`,
   `archive <id>`, `restore <id>`, `pin <id>`, `unpin <id>`. Wire `skills update
   <id>` to back up then `installSkill({overwrite:true})` (the "improve" path).
3. Tests first (red) — `apps/cli/test/skill-curator.test.ts`:
   - "findDuplicates flags a near-identical SKILL.md and ignores unrelated ones"
   - "backup → modify → rollback restores the original and re-verifies"
   - "archive removes a skill from discovery; restore brings it back"
   - "update backs up then overwrites, and the result still verifies".
4. `pnpm check && pnpm test && pnpm build`. Update matrix §6 remaining rows
   (Improve successful skills, Duplicate detection, Lifecycle) → VERIFIED +
   status. Commit `feat(skills): skill curator (dedupe, backup, rollback, lifecycle)`
   + push.

## Failing test to write first

`apps/cli/test/skill-curator.test.ts` — "backupSkill then rollbackSkill restores
the original SKILL.md and the restored skill still passes verifySkill".

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
