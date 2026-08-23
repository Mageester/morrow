# Morrow — consolidated agent brief

You are working on **Morrow**, a self-hosted personal AI agent.
Repo: `/home/dread/Projects/Morrow-clean` → `github.com/Mageester/morrow`.

Work through the workstreams below in the stated order. Everything here was
verified on 2026-08-23; re-verify before acting on anything that looks stale,
but do not re-derive facts already stated — they cost real time to establish.

---

## 0. Context you need before touching anything

**Stack:** pnpm 10.12.1 workspace + turbo, Node 22+, TypeScript, Vitest.
`apps/` (cli, web, landing, dashboard) · `packages/` (contracts, ui, hosted-contracts)
· `services/` (orchestrator, hosted-api) · `installer/` · `benchmarks/` · `skills/`

**Commands:**
```
pnpm check      # turbo check (tsc, all packages) + scripts/validate-repository.mjs
pnpm test       # turbo run test --concurrency=1
pnpm build      # turbo build
pnpm dev:app    # web on :4318 + orchestrator on :4317
```
`pnpm check` and `pnpm test` are green on `main` as of `9154441`. Keep them green.
Any red you find that you did not cause is a finding — report it, don't silently fix around it.

**Current state:** `main` @ `9154441`, version `0.4.0`. A source install of this exact
commit runs locally at `~/.local/share/morrow` (service on :4317, UI at
`http://127.0.0.1:4317/app/`, DB schema 64/64).

**Hard constraints — violating any of these is a failed task:**
1. **Never touch `~/.morrow`.** Real user data: 68MB SQLite DB, credentials,
   conversations, projects. Migrations are one-way. A backup exists at
   `~/.morrow/morrow.db.pre-0.4.0-20260823-115737.bak` (+ `-wal`, `-shm`) — do not
   rely on it as a licence to be careless.
2. `installer/install.sh` must stay **ASCII-only** (asserted by
   `scripts/validate-repository.mjs`) and must keep every safety invariant in
   `scripts/lib/installer-safety.mjs`: atomic `app.new`/`app.old` swap, rollback on
   failed health probe, SHA-256 verification of artifacts, refusal of a `--prefix`
   inside the data home, rejection of non-release artifact URLs.
3. **`skills/` (215 files) is a live feature**, not dead weight — it backs the skill
   registry (`apps/cli/src/skills/registry.ts`). Do not "clean" it.
4. These require **explicit human confirmation before you act** — prepare them fully,
   then stop and ask: force-pushing the `v0.4.0` tag, dispatching the Release
   workflow, merging or closing any PR, deleting any remote branch, creating GitHub
   issues, and anything touching the Cloudflare dashboard.

**Priority signal from the maintainer:** *speed and efficiency are a very high
priority*. Treat measurable latency and resource wins as first-class deliverables,
not cleanup. Every perf claim must come with a before/after number produced by a
repeatable command.

---

## W1 — Ship 0.4.0 correctly  ⟨blocking⟩

**The bug:** the `v0.4.0` tag points at `ff066dd` (`chore(release): prepare 0.4.0`).
Six commits landed *after* it, including the **entire POSIX installer**:

```
c67986d feat(installer): add a macOS and Linux installer
13c6846 fix(cli): make Morrow uninstallable on macOS and Linux
18d5d01 fix(installer): verify the service that answers is the one just installed
48921ce fix(cli): stop a service started from a source checkout, and stop lying about start
7f50b34 fix(installer): give the installed Morrow its web app back
9154441 Merge pull request #83 from Mageester/release/0.4.0
```

Verified: `git cat-file -e ff066dd:installer/install.sh` → **absent at the tag**.

`softprops/action-gh-release` reuses an existing tag and **ignores
`target_commitish`**, so dispatching Release today publishes a 0.4.0 built from
`ff066dd` — with no POSIX installer in it.

**Do:**
1. Verify the above still holds.
2. Prepare the tag move to `9154441`. **Stop and ask before force-pushing.**
3. Confirm release preconditions: root `package.json` is `0.4.0` (release.yml asserts
   `inputs.version === package.json version`) and `CHANGELOG.md` has a
   `## [0.4.0] - 2026-08-22` section (`scripts/release-notes.mjs` fails without it).
   Both currently pass.
4. **Stop and ask before dispatching Release.**

**Root cause worth fixing, not just the symptom:** nothing prevented a tag from being
cut mid-release-branch. Add a CI guard that fails if a `v*` tag is not an ancestor of
`main`, or if `package.json`'s version has a tag pointing somewhere other than the
release commit.

---

## W2 — The install-site pipeline  ⟨RESOLVED — replaces the earlier "unknown pipeline" item⟩

**This is answered. Do not go looking for it, and do not ask for Cloudflare
credentials.** An earlier draft of this brief claimed the pipeline was
undocumented and unreviewed. That was wrong: it is documented and drift-gated,
just in a **second repository**.

```
/home/dread/Projects/morrow-axiom-site   →  github.com/Mageester/morrow-axiom-site
branch main · Vite · `npm run build` → dist/ · npm (package-lock.json)
```

- `public/install.sh`, `public/install.ps1`, `public/releases/latest.json` are
  **vendored copies**, served verbatim ahead of the SPA catch-all.
- `scripts/sync-install-assets.mjs` copies them from the Morrow repo — from a local
  `../morrow` checkout if present, else `raw.githubusercontent.com/Mageester/morrow/<ref>`.
  It normalises EOL per target (CRLF for `.ps1`, LF for `.sh` — a CRLF `install.sh`
  is unrunnable, the kernel reads the shebang as `/bin/sh\r`).
- `.github/workflows/ci.yml` runs `sync-install-assets.mjs --check` on every push and
  PR to `main`, failing on drift. **A drift gate already exists.**
- `public/_redirects` is `/*  /index.html  200` — that is the SPA catch-all that makes
  unknown paths return 200 + HTML.
- `latest.json` is **enriched** during sync: it adds `commit` and
  `source{repository,tag,commit}` beyond the GitHub release asset. `install.sh` uses
  that commit to verify a source checkout is the release it claims to be. Provenance
  for *source installs* is therefore stronger than the earlier draft stated.
- `tests/install-assets.spec.ts` guards regression. It exists because the
  Astro→React rebuild (`af705e2`) once dropped `install.ps1` and `latest.json`, and
  the advertised command piped the site's own HTML into PowerShell.

**What is still genuinely open — this is the real work:**

1. **The sync is manual and lags.** `morrow-axiom-site` CI only runs on pushes to
   *that* repo. Changing `installer/install.sh` in the Morrow repo triggers nothing.
   The site's own history is a row of after-the-fact commits — `chore: sync
   install.sh — installed Morrow gets its web app back`, `— identity-checked health
   gate`, `— uninstall and --ref fixes`. Each is a window where production served a
   stale installer. **Fix: have the Morrow repo notify the site repo** (repository
   dispatch on installer changes, or a scheduled `--check`), so drift is detected
   from the side that changes.
2. **Publishing 0.4.0 will NOT update the install site.** `readReleaseManifest()`
   takes `releases.find(r => !r.draft)` at sync time — so `latest.json` only advances
   when someone pushes to `morrow-axiom-site`. This is a **W1 dependency**: after the
   0.4.0 release publishes, the site sync must run or `curl | sh` keeps serving 0.3.0.
   Wire this into the release flow rather than leaving it to memory.
3. **No checksum or signature for the `install.sh` bytes themselves.** The commit
   field proves the *source tree*; nothing proves the *script*. Publish
   `install.sh.sha256` and have CI verify the live bytes against the tagged commit.
4. **Two dead deploy configs.** `vercel.json` is a leftover from a Vercel-era deploy
   and is inert on Cloudflare. In the Morrow repo, `deploy-landing.yml` deploys
   `apps/landing` to GitHub Pages — which is **not** the install domain, 404s on
   `install.sh`, and is wired to a mismatched Pages `build_type` (`legacy`/`gh-pages`
   branch while the workflow uses `deploy-pages@v4`). Decide: delete
   `deploy-landing.yml` and `apps/landing` if `morrow-axiom-site` is the real site, or
   consolidate. Shipping two half-wired pipelines is the underlying defect.
5. **Confirm the hosting product.** Headers and `_redirects` are consistent with
   Cloudflare Pages; the zone `getaxiom.ca` is on Cloudflare NS. You have Cloudflare
   MCP and an authorized `npx wrangler` — confirm it yourself:
   `npx wrangler whoami`, `npx wrangler pages project list`, then the project's
   `build_config` via the Cloudflare API for build command, output dir, and trigger.
   Report what you find. **Do not change any Cloudflare configuration.**

**Verified evidence (do not re-derive):** production `install.sh` sha256
`1e475486033ee62bebb5e572de41a154b523a03be512ad808cda4092178dbe8e` == Morrow `HEAD`
`9154441`. Production serves `install.ps1`, `install.sh`, `releases/latest.json`
(0.3.0), and **no** `release-manifest.json`. Neither installer reads
`release-manifest.json` — both read only `/releases/latest.json`
(`install.sh:532`, `install.ps1:15`), so its absence is a fingerprint, not a defect.

## W3 — Performance and efficiency  ⟨very high priority⟩

**Do not build a benchmark harness. One already exists — extend it.**

```
benchmarks/harness-comparison/    run.ts morrow-adapter.ts pi-adapter.ts tasks.ts
                                  report.ts validate.ts verify.ts prefix-stability.ts
                                  live-attribution.ts results/*.jsonl
benchmarks/harness-economics/     deterministic.ts delegation-scenario.ts metrics.ts
services/orchestrator/benchmark/  cli.ts hot-paths.ts explain-hot-queries.ts
                                  metrics.ts runner.ts tasks.ts report.ts
services/orchestrator/test/harness-comparison.test.ts

pnpm --filter @morrow/orchestrator benchmark
pnpm --filter @morrow/orchestrator benchmark:hot-paths
pnpm --filter @morrow/orchestrator benchmark:query-plans

docs/benchmark-plan.md  docs/performance-hot-paths.md
docs/harness-comparison-2026-08-20.md  docs/harness-efficiency-report-2026-08-11.md
```

**Do:**
1. **Read the existing plan and prior reports first.** Understand what was already
   measured and what the adapters cover before adding anything.
2. Run the current suites. Record a clean baseline on `main` @ `9154441`.
3. **Cross-harness comparison** — the maintainer explicitly wants this. Extend
   `harness-comparison` so Morrow is measured head-to-head against the other
   adapter(s) on identical tasks. Report tokens, wall-clock, tool-call count, and
   cost per completed task. Keep the fixture deterministic; a benchmark that
   silently depends on a live provider is not a benchmark.
4. **Hot paths.** Use `benchmark:hot-paths` and `benchmark:query-plans` to find real
   costs. Prior art: commit `5bc7ff9` killed a 30s pre-provider delay, enabled SQLite
   WAL, and optimised chat streaming — look at what that commit did and where similar
   wins remain. The DB is 68MB with 64 migrations; check that hot queries have
   indexes and are not doing table scans.
5. **Startup and first-token latency** are what users feel. Measure CLI cold start,
   service boot to healthy, and time-to-first-token in chat. Optimise those.
6. **Land regression gates.** Add perf budgets to CI so wins don't silently rot.
   A win with no gate is a temporary win.

**Every claim needs a number and the command that reproduces it.** No "should be
faster". Write results to `docs/` with the date and commit.

---

## W4 — CLI onboarding is weird and boring — redesign it

Maintainer's words. Current implementation:

```
apps/cli/src/commands/onboard.ts        607 lines
apps/cli/src/commands/provider-setup.ts 345 lines
apps/cli/test/onboard.test.ts
apps/cli/test/provider-setup.test.ts
```

It is **8 sequential blocking prompts**: `welcome → profile → usecase → provider →
mode → skills → project → mission`, driven by `ask`/`select`/`confirm` from
`./common.js`. That linearity is the problem — it interrogates the user before
showing them anything worth having.

The CLI shell was rebuilt on **Ink** (React for terminals) in #78 — onboarding should
use that, not raw prompt calls. Web onboarding lives at
`apps/web/src/features/onboarding/` and there is prior design thinking in
`docs/superpowers/specs/2026-08-12-premium-onboarding-design.md` and
`docs/superpowers/plans/2026-08-12-premium-onboarding-release.md`. Read both before
designing; don't reinvent decisions already made.

**Design goals:** get to something working in as few keystrokes as possible. Sensible
defaults with escape hatches, not an interrogation. Show value before asking for
configuration. Skippable and resumable — `onboard reset` and `onboard status` already
exist and must keep working. Provider setup is the one genuinely required step; treat
everything else as deferrable.

Keep the existing tests passing or update them deliberately with the reasoning stated.

---

## W5 — Bug hunt

`docs/KNOWN_ISSUES.md` is **866 lines** of evidence-based beta.29 findings with a
P1/P2/P3 severity legend, split into **verified** vs **hypothesis** (the file is
explicit that a hypothesis is not a root cause — respect that distinction).
Related: `docs/MORROW_BACKLOG.md`, `docs/ENGINEERING_LOG.md`.

Note: only **4** TODO/FIXME markers exist across `apps/`, `packages/`, `services/`.
The code is not littered with self-reported debt, so grepping for markers will not
find bugs. Hunting must be empirical.

**Do:**
1. Triage `KNOWN_ISSUES.md` against current `main`. Many entries predate 0.4.0 and are
   likely already fixed. For each: still reproducible, or resolved? Move resolved ones
   to `ENGINEERING_LOG.md` with `[RESOLVED <date>]` — that convention is documented in
   `docs/CURRENT_STATE.md`.
2. Fix surviving P1s first, then P2s.
3. Hunt empirically: run the installed build, exercise real flows (onboarding, chat,
   missions, teammates, skills), and use the Playwright e2e suite in `apps/web/e2e/`.
4. Investigate the 4 skipped/todo tests — a skipped test often marks a real bug.
5. Every fix gets a regression test.

---

## W6 — Delete what's useless

**Verified candidates:**
- `output/playwright/*.png` — **20 committed screenshots** (build artifacts in git).
  Delete and gitignore.
- `docs/` is **244 files**, 11 with a dead beta version in the *filename*
  (`BETA29_UX_INVENTORY.md`, `BETA30_CLI_ACCEPTANCE.md`, `BETA30_PRODUCT_GOAL.md`,
  `BETA31_BROWSER_VISION.md`, …). Current release is 0.4.0. Archive or delete what
  documents shipped-and-gone beta phases; keep anything still describing live
  behaviour.
- `benchmarks/` has **dated result artifacts committed** (`*.jsonl`, `*.svg`,
  `deterministic-summary-*.json`, `morrow-live-deepseek-snapshot.json`). Keep the
  harness code and a small reference baseline; drop the accumulated run output.
- Dead code: unused exports, unreachable branches, superseded modules. `pnpm check`
  will not catch unused exports — use a dedicated pass.

**Do not delete `skills/`.** See constraint 3.

Deletion must be justified per item. "Looks old" is not justification — check whether
anything imports or links it first.

---

## W7 — Branch and PR backlog

**16 open PRs**, oldest from **2026-06-20**:

```
2026-06-20 #3   chore(deps): bump actions/checkout 4→7
2026-06-20 #4   chore(deps): bump actions/setup-node 4→6
2026-06-20 #10  DRAFT feat(web): build premium product shell
2026-06-21 #12  DRAFT feat(cli): add local Morrow command interface
2026-06-21 #13  DRAFT feat: terminal agent repair workflow
2026-06-26 #14  fix: align auth, installer, and release flow
2026-06-27 #15  chore(deps): bump pnpm/action-setup 4→6
2026-06-27 #16  chore(deps): bump softprops/action-gh-release 2→3
2026-06-27 #17  chore(deps): bump actions/configure-pages 5→6
2026-07-02 #23  feat: Hermes-parity slice batch
2026-07-10 #37  docs(demo): beta.28 terminal evidence package
2026-07-15 #53  Advanced agent consumer proof
2026-07-15 #54  fix(cli): never silently resume a different workspace than cwd
2026-07-15 #56  Release: Morrow v0.1.0-beta.30
2026-07-16 #61  DRAFT fix: make context preflight resumable
2026-07-25 #65  DRAFT Reliability foundation slice 1
```

- **#15, #16, #17 touch the release/deploy path you are changing in W1/W2** — evaluate
  them there, not in isolation.
- **#56** is a beta.30 release PR, five versions stale — almost certainly closeable.
- **#54** describes a real correctness bug (workspace isolation); check whether 0.4.0's
  `fix(cli): stop a service started from a source checkout` already covers it.
- **`try-teammates`** is 30 commits ahead of `main` and overlaps the 0.4.0 teammate
  work heavily — decide rebase vs close.
- Fully merged, safe to prune: `feat/cli-liveness-and-failures`,
  `feat/cli-shell-rebuild`, `fix/package-export-surface`.
- `scripts/branch-inventory.mjs` and `scripts/check-branch-freshness.mjs` already
  exist (`pnpm branches:inventory`, `pnpm branches:freshness`) — use them.

Recommend an action per PR with reasoning. **Do not merge or close anything without
confirmation.**

---

## W8 — Housekeeping

- `@clerk/shared` build scripts are **ignored by pnpm** (`pnpm approve-builds`).
  Pre-existing. Determine whether Clerk actually needs its postinstall; if yes,
  approve it, if no, document why it's suppressed.
- **pnpm drift:** `packageManager` pins `pnpm@10.12.1`; corepack is advertising 11.x.
  Decide deliberately. Upgrading changes the lockfile format — do not do it as a side
  effect of something else.
- No prebuilt artifacts exist for **macOS or Linux**: `release.yml` has only a
  `build-windows` job, and the live manifest carries a single `windows-x64` artifact.
  Every POSIX user therefore does a **full source build** — clone, `pnpm install`,
  `turbo build`, ~800MB `node_modules`, several minutes. The installer already
  supports prebuilt tarballs (`install_prebuilt`, exercised by
  `scripts/install-integration.test.mjs` and `scripts/install-sh.test.mjs`), and its
  header states it "keeps working unchanged the day platform tarballs start
  shipping." **Adding `build-linux` and `build-macos` jobs is the single largest
  first-run UX win available** and the contract is already defined. Fold this into W1
  if you get there before the release dispatch; otherwise do it immediately after.

---

## Execution order

```
W1 ─┬─ W2   ship correctly + make the install path provable   ⟨do first, related⟩
    └─ W8(prebuilts)
W3        performance                                          ⟨maintainer's stated top priority⟩
W4 ‖ W5   onboarding redesign ‖ bug hunt                       ⟨independent, parallelisable⟩
W6 ‖ W7   dead weight ‖ backlog                                ⟨independent⟩
W8        remaining housekeeping
```

## Definition of done

- `pnpm check` and `pnpm test` green.
- Every perf claim carries a before/after number and a reproducing command.
- Every bug fix carries a regression test.
- Every deletion carries a one-line justification.
- Anything requiring confirmation is **prepared and presented, not executed**.
- A single summary at the end: what changed, what was measured, what you chose not to
  do and why. Report failures honestly — a partial result stated plainly is worth more
  than a confident overstatement.
