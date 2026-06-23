# Continuation

> Always names the **exact** next step so any agent (or a fresh session) can
> resume without re-deriving context. Update this at every interruption.

## Concurrent-agent collision (2026-06-23) — RESOLVED

A second agent built a **persistent named agents** feature on this same branch.
Resolved cleanly:
- The migration-id collision (both claimed `id:15`) was fixed by renumbering mine
  to 16. The other agent then committed `feat(agents): persistent named agent
  teams + granular permissions` (`2dc4362`), which **included** my task-graph data
  model (migration 16 `task_parent_links`, `Task.parentTaskId`,
  `tasks.listChildren`, `SpawnSubagentSchema`).
- I then landed B14 subagent routes on top: `feat(tasks): subagent delegation`
  (`6d8a23d`). The user authorized "take over fully"; the other agent is stopped.
- Tree is GREEN: orchestrator 244, CLI 124, contracts 4, web 8.

The `skills/` directory contains ~20 extra skills created via the skill creator
(by the user/other agent). They are untracked — do NOT commit or delete them.

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
- **B5 — Skill Creator: VERIFIED.** **B6 — Skill Curator: VERIFIED.**
  §6 Skills fully VERIFIED.
- **B7 — Cron scheduler: VERIFIED.**
- **B13 (partial) — Diagnostics + baseline: VERIFIED.**
- **B14 (partial) — Subagent delegation + task graph: VERIFIED.** Worktrees pending.
- **B17 (partial) — Messaging adapters + notifications: VERIFIED.**
- **B11 (partial) — MCP client: VERIFIED** (stdio client, framing, transport,
  tool filtering, trust).
- **B18 (partial) — Doctor + updater: VERIFIED.**
- **B20 (partial) — Hermes import: VERIFIED.**
- **B9 (partial) — Execution backend interface + local backend: VERIFIED.**
- **B21 (partial) — Persisted command history: VERIFIED.**
- **B22b — Tamper-evident audit store: VERIFIED** (hash-chained append-only log).
- **Persistent named agents** feature landed in the tree (`feat(agents)`).
- Baseline: orchestrator 269, CLI 135, contracts 4, web 8, hermes-compat 4 —
  all green (5 workspace packages).

> NOTE: the live `skills/` directory contains ~20 extra skills created via the
> skill creator (untracked). Do NOT commit or delete them. Tests assert the 6
> built-ins as a subset, not an exact list.

## Exact next step — B12 plugin manager

B15 is implemented as a real local Playwright/CDP vertical slice. The current
working tree contains its source, tests, dependency manifest/lockfile, and durable
documentation updates; commit and push this coherent slice before starting B12.
Managed/cloud browser backends are intentionally still missing.

1. Run `pnpm check && pnpm test && pnpm build && pnpm run test:e2e` and inspect
   `git diff --check`.
2. Commit the B15 files with `feat(browser): add safe local Playwright control`
   and push `feat/morrow-agent-terminal` (PR #13 remains draft and unchanged).
3. Start B12 at `services/orchestrator/src/plugins/manifest.ts`: write the
   failing manifest-validation test first, then implement a local-only plugin
   manifest registry with enable/disable state and no implicit code loading.

## B15 evidence

- `services/orchestrator/test/browser-injection.test.ts` launches Chromium against
  a local controlled page; it verifies semantic refs, navigation, type/key/select,
  screenshot, dialog, console evidence, scoped upload/download, injection
  containment, SSRF rejection, cancellation, persistent profiles, CDP attach,
  pause/resume/panic, cleanup and sanitized append-only audit records.
- `pnpm --filter @morrow/orchestrator test -- browser-injection.test.ts` → 278
  orchestrator tests green before final workspace verification.

## Historical B15 design notes (superseded)

Browser automation needs Playwright/a real browser (CI-untestable here), so build
the *testable* parts honestly: a `BrowserController` interface, a Playwright-backed
impl behind it that refuses until a browser is available (like the Docker/SSH
stubs — never fake it), and a **pure prompt-injection guard** that IS testable.

1. `services/orchestrator/src/browser/types.ts`: `BrowserController` interface
   `{ id; open(url); snapshot(); click(ref); type(ref, text); screenshot();
   close() }` with `DomRef`/`PageSnapshot` types.
2. `services/orchestrator/src/browser/injection-guard.ts` (PURE, testable):
   `scanForInjection(pageText)` → findings for known prompt-injection patterns
   ("ignore previous instructions", "system prompt", hidden-instruction markers,
   data-exfil URLs). `sanitizeForModel(pageText)` → text with injection spans
   neutralized + a findings list. This protects the agent from malicious page
   content.
3. `services/orchestrator/src/browser/playwright.ts`: a controller that
   `import("playwright")`s lazily and throws a clear "browser not available"
   error if the dep/browser is missing — do NOT add a heavy hard dependency;
   never fake navigation.
4. Domain allow-list + no credential capture: guard `open()` against
   non-allowlisted domains when an allow-list is configured.
5. Tests `test/browser-injection.test.ts`: `scanForInjection` flags known
   patterns and ignores benign text; `sanitizeForModel` neutralizes an injected
   instruction while preserving normal content; the Playwright controller throws
   "not available" when the dep is absent (or skip that case if present).
6. `pnpm check && pnpm test && pnpm build`. Update matrix §9 (prompt-injection
   protection VERIFIED; browser controller SCAFFOLD) + status. Commit + push.

## Failing test to write first

`test/browser-injection.test.ts` — "scanForInjection flags an 'ignore previous
instructions' payload and leaves benign page text unflagged".

> Re-check `database.ts` for the current highest migration id before adding one.

## Still remaining (multi-session)

B9 Docker/SSH real impls; B15 browser (Playwright/CDP — CI-untestable here);
B16 desktop (UIA/AX/AT-SPI); B19 installers (Windows/Ubuntu); finish partials:
compareBaseline → agent write-path gate, MCP HTTP transport + routes,
apply-update automation + rollback + uninstall, CLI `morrow import` over
`@morrow/hermes-compat`, append-only tamper-evident audit store (B22).

## Deferred / bigger remaining (multi-session, see MORROW_BACKLOG.md)

Wire `compareBaseline` into the agent write path (finish B13). B9 Docker/SSH
backends; B11 MCP client; B15 browser; B16 desktop; B17 messaging adapters (+
notification delivery); B18 doctor/updater/uninstall; B19 installers; B20 Hermes
import; B21 TUI live tree/Ctrl+K.

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
