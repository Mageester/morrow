# Morrow Master Goal

## Mission

Turn Morrow into a complete personal agent platform that reaches **verified**
feature parity with Hermes, then exceeds it in: terminal UX, autonomy, security,
transparency, memory control, reliability, and installation.

Morrow is a privacy-focused, local-first, self-hosted personal AI agent — not an
OS, control plane, or generic SaaS. Hermes is the capability reference, never a
source of copied branding, wording, prompts, assets, or code.

## Non-negotiable definition of done

Morrow can, with automated + manual proof:

1. Complete and verify autonomous coding work.
2. Survive restart and resume in-flight work.
3. Inspect output, audit, diff, and undo.
4. Create, test, install, and improve skills.
5. Search and explain memory.
6. Run cron and messaging tasks.
7. Use MCP / plugins.
8. Safely control browser and desktop.
9. Delegate to subagents.
10. Switch providers with fallback.
11. Install cleanly on Windows and Ubuntu.
12. Panic-stop all automation.
13. Pass all automated and manual acceptance tests.

## Engineering invariants

- **Contracts first.** Anything crossing the orchestrator↔client boundary is a
  zod schema in `packages/contracts`.
- **No fake interfaces.** Every surfaced capability has backend behavior.
- **Tests gate status.** A capability is not "done" without an automated test.
- **Green trunk.** `pnpm check && pnpm test && pnpm build` stay green on the
  branch after every committed slice; `pnpm run test:e2e` for UI-visible changes.
- **Security is structural.** Hard-block secret exfiltration, privilege
  escalation, destructive system/git actions, workspace escape, covert
  monitoring, hidden persistence, unauthorized data transfer — enforced in code
  with tests, not by prompt.
- **Local-first / provider choice preserved.** No silent telemetry, external
  inference, or hosted dependency.
- **Never** commit secrets, logs, databases, or user runtime data.
- **Never** copy Hermes code/branding/prompts verbatim. Re-implement natively.

## Branch & PR discipline

- Work on `feat/morrow-agent-terminal`.
- Keep PR #13 a **draft**. Never merge, never retarget.
- Conventional Commits. One coherent slice per commit. Push immediately.

## Architecture map (current)

```
packages/contracts      zod protocol (single source of truth for the API)
services/orchestrator    Fastify runtime, agent engine, providers, tools, repos
  src/execution          agent loop, adaptive budget, continuation
  src/provider           anthropic / openai / gemini / openai-compatible / mock
  src/routing            presets, models, router (provider selection + fallback)
  src/repositories       sqlite-backed persistence (better-sqlite3)
  src/tools              catalog, command-executor/-policy, diff-applier, git
  src/workspace          inspector, safe-reader, search, validator
apps/cli                 terminal TUI (events→reduce→state→view→renderer) + client
apps/web / apps/desktop  web shell / desktop shell
skills/                  signed built-in skills (manifest + permissions + SKILL.md)
packages/{ui,config,hermes-compat}  shared UI, config, Hermes import surface
```

## Working order (impact-ranked)

The live ordering is in `MORROW_BACKLOG.md`; `MORROW_STATUS.md` records what is
done; `CONTINUATION.md` always names the exact next step. The matrix
(`HERMES_PARITY_MATRIX.md`) is the scoreboard.
