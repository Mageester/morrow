# Changelog

All notable changes to Morrow will be documented here.

The format follows Keep a Changelog, and releases will use Semantic Versioning once the first public version is established.

## [Unreleased]

## [0.1.0-beta.23] - 2026-07-06

### Fixed

- **P0 onboarding health false negative.** CLI onboarding no longer restarts the
  packaged service after provider setup. The delegated packaged CLI is not
  allowed to autostart the service, so the old restart path could stop a healthy
  service and then report it unreachable even though `morrow doctor` recovered
  and passed immediately afterward.
- Added timestamped lifecycle diagnostics around service start, stop, PID
  recovery, and health polling to make future restart failures reproducible.
- Removed the source CLI `morrow open` browser command and help text so Morrow's
  help no longer implies a browser application.

## [0.1.0-beta.22] - 2026-07-06

### Added — Morrow Terminal: CLI-First Coding Agent

- **CLI-only product direction.** The terminal is the product. Bare `morrow`
  launches the interactive terminal session directly — no browser, no web
  dashboard, no local server UI required.
- **Ask / Plan / Build / Mission modes.** Four purposeful modes replace the
  generic "agent" mode. Ask explores without touching files. Plan produces a
  repair plan without modifying anything. Build executes with approvals.
  Mission runs verified, accountable work with evidence.
- **Consumer onboarding.** A first-launch welcome panel guides new users through
  provider setup, project registration, and mode selection with plain-language
  instructions.
- **Responsive single-line status bar.** A compact status bar shows project,
  branch, provider, model, mode, and privacy state in one line that adapts to
  terminal width.
- **Model picker.** `/model` presents an honest picker listing only
  known-capable models for each configured provider, with clear labels for
  unconfigured providers.
- **Safe permission prompts.** Tool approvals render in-frame with clear
  descriptions. Enter never approves — a deliberate keypress is required.
- **Grouped tool activity.** `/activity` shows a compact, grouped view of
  session work — tool calls, their status, and results — instead of a flat log.
- **Input and paste reliability.** Bracketed-paste detection prevents
  multi-line paste from being interpreted as a submission. Cursor-position
  correction eliminates off-by-one caret drift after paste and line edits.
- **Streaming, cancellation, and resize.** Assistant tokens stream live into
  the transcript. Ctrl+C cancels a running task (first press) then exits
  (second press). Terminal resize recomposes the frame without corruption.
- **Resume.** `/resume` restores a prior session's conversation and context
  after relaunch, with Git drift detection and Cortex staleness warnings so
  Morrow does not blindly resume against a changed repository.
- **Session management.** `/new` starts a fresh session. `/branch` forks the
  current conversation. `/changes` shows the session's file changes. `/status`
  reports project, provider, model, and session state. `/cost` shows token and
  cost accounting.
- **Git drift awareness.** When the repository changes externally between
  sessions, Morrow detects the drift and warns before resuming.
- **Cortex staleness warnings.** Scoped fingerprints label project intelligence
  as `possibly_stale` when the files behind it change, including entry-point
  scope so an externally split entry module marks knowledge stale.
- **Human-readable error handling.** Common failures (provider unreachable,
  rate limited, context window exceeded, missing API key) produce plain-language
  guidance instead of raw stack traces.
- **`morrow capabilities`.** An honest live capability report showing what is
  configured, what is available, and what is not yet supported.

### Fixed

- **Lockfile consistency.** Regenerated `pnpm-lock.yaml` after the removal of
  `@playwright/test` from root devDependencies so `pnpm install
  --frozen-lockfile` succeeds on fresh clones and CI.
- **Resize test stability.** Increased the tick timeout in the session harness
  test to exceed the paint coalescer's minimum interval, eliminating a flaky
  resize repaint assertion under parallel test load.

## [0.1.0-beta.21] - 2026-07-05

### Added — Morrow Advantage: Morrow Cortex

- **Persistent project intelligence.** `morrow cortex` gives Morrow a durable,
  inspectable understanding of a repository that compounds across missions:
  `status`, `map`, `refresh`, `conventions`, `decisions`, `risks`, `learnings`,
  `rules`, `explain`, and `forget`.
- **Architecture maps** built deterministically from repository evidence —
  languages, components, workspaces, commands, config, docs, and
  generated/protected areas — on a canonical project-intelligence model.
- **Conventions, decisions, risks, rules, and mission learnings** are persisted
  as first-class knowledge. Inferred conventions are visibly distinct from
  approved ones, and explicit repository rules outrank anything inferred.
- **Stale-memory detection.** Scoped fingerprints label knowledge
  `possibly_stale` when the files behind it change — including an `entry_points`
  scope so an externally split entry module marks architecture knowledge stale
  instead of being silently trusted. Missions refresh affected knowledge before
  planning on it.
- **Scoped refresh** re-maps only the intelligence a change actually affects
  rather than discarding everything.
- **Change-impact analysis.** Before executing, a mission surfaces likely
  affected components/files, interfaces at risk, relevant history and failures,
  repository rules, possible regressions, and required verification drawn from
  persisted intelligence.
- **Adaptive replanning.** A bounded plan revision is recorded when a mission
  assumption is invalidated, capturing the task and verification changes.
- **Specialist mission roles** are persisted per mission.
- **Mission failure-ledger integration.** Real agent patch/tool failures
  (patch-context mismatches, failed commands) are recorded and their recovery is
  tracked, instead of reporting zero failures.

### Fixed

- **Independent review reliability.** Review completions request JSON-object mode
  through OpenAI-compatible providers (review purpose only); a bounded
  review-repair pass converts prose answers into the required schema, and invalid
  output falls back to `insufficient_evidence` rather than guessing approval.
- **Bounded post-review repair.** When a reviewer returns `revisions_required`,
  Morrow runs one bounded autonomous repair seeded with the reviewer's findings,
  then re-verifies and re-reviews, within a fixed cycle budget.
- **Grounded success criteria.** Generated criteria that reference nonexistent
  files or brittle inline `node -e` probes of guessed artifact shapes are
  rejected in favor of real repository scripts and tests.
- **Reviewer no-op filtering.** Placeholder risks like “none” or “no concerns”
  no longer become fake unresolved risks, while genuine findings (e.g. “No test
  coverage for…”) are preserved.
- **Windows installer long-path hardening.** The installer extracts the release
  archive with the .NET `ZipFile` extractor and uses short staging names, so
  deeply nested production dependencies no longer hit `MAX_PATH`; safety guards
  keep the regression from returning.
- **Mission short-id usability.** `morrow mission show|result|evidence|failures|
  revisions|checkpoints` accept the shortened mission ids printed by `mission
  list` (unique-prefix resolution, with clear ambiguity and not-found errors);
  `morrow mission --help` and `morrow cortex --help` render explicit help without
  starting a mission or entering Mission Control.
- **Windows filesystem reliability.** Atomic skill-directory installs retry
  briefly on transient Windows `EPERM`/`EACCES`.
- **Cross-platform Git stabilization.** Integration merges supply an explicit Git
  identity so identity-less CI environments no longer fail.
- **Cortex status freshness ordering.** The first `cortex status` after a change
  runs staleness detection before rendering, so it reports updated freshness
  honestly rather than only on a second call.

## [0.1.0-beta.20] - 2026-07-05

### Added — Morrow Advantage: Verified Missions

- **Missions.** `morrow mission "<objective>"` turns an objective into a durable,
  accountable unit of work: it drafts measurable success criteria, shows the
  contract, executes, verifies each criterion with concrete evidence, obtains an
  independent review, and grades itself honestly. Subcommands: `mission
  list|show|result|criteria|evidence|failures|checkpoints`.
- **Success criteria** with states (proposed/approved/in_progress/verified/
  failed/waived/unverified), per-criterion verification strategies, and evidence
  references. Vague criteria (“make it better”) are rewritten into observable
  outcomes.
- **Evidence ledger.** A criterion is verified only when linked to evidence whose
  status is `passed` (command exit code, HTTP probe, bounded diff, …) — never on
  an agent's say-so. Evidence is persisted and viewable after completion.
- **Failure intelligence & loop detection.** Failures are persisted with a
  category and a normalized signature; recovery escalates deterministically
  (patch-context: reread → reduce scope → targeted rewrite) and never repeats the
  same failed operation forever, escalating to `blocked` when exhausted.
- **Checkpoints & safe rollback.** Per-file content snapshots let rollback restore
  only the captured files — never a blanket working-tree reset — and it works
  after a restart.
- **Independent review.** A separate reviewer execution with isolated
  instructions returns a structured verdict (approved / approved_with_risks /
  revisions_required / insufficient_evidence); insufficient evidence can never
  become full completion.
- **Honest grading** into completed / completed_with_reservations /
  partially_completed / blocked / failed / cancelled, with a durable, resumable
  mission result and an append-only mission event timeline.
- **Mission REST API** and SQLite persistence (migration 25); state survives CLI
  closure and service restart.
- **Terminal Mission Control**: `/criteria`, `/evidence`, `/failures`,
  `/checkpoints` in the interactive shell.
- **Benchmark harness** (`benchmarks/morrow-evals`) measuring **final-claim
  accuracy** — does a full-success grade match a hidden ground-truth check? —
  across five deterministic scenarios. No fabricated competitor scores.

### Fixed

- `morrow projects select` now accepts the shortened project id shown by
  `projects list` when it uniquely identifies a project, with a clear error
  listing candidates when a prefix is ambiguous.

## [0.1.0-beta.19] - 2026-07-04

### Changed

- Terminal shell redesign: the bare `morrow` command opens a premium, terminal-first
  agent shell — MORROW wordmark header with compact project/branch/provider/model/mode/
  context status, clean user/assistant/plan/approval/result separation, inline Markdown,
  and a persistent composer with slash completion and context-sensitive footer hints.
- Grouped activity replaces raw tool logs: consecutive reads/searches/inspections
  collapse into single stage lines (Understanding, Inspecting, Planning, Editing,
  Running checks, Verifying, Completed), with workspace-relative paths and no tool IDs.
- Failed or interrupted tasks surface an inline Recovery section with actionable commands.
- Terminal Mission Control (`morrow mission`, Ctrl+T) provides a responsive operational
  cockpit for the task tree, agents, processes, worktrees, Git state, and verification.

### Notes

- Raw tool details, call IDs, and backend routing remain available through `/output`;
  they are hidden from the default conversation view.

## [0.1.0-beta.18] - 2026-07-03

### Fixed

- Context management: discovery-ignored paths (vendor, lockfiles, dist) remain accessible via explicit reads.
  Discovery exclusions no longer become universal access bans.
- Safe-reader no longer rejects files with "key" or "token" in their names (was blocking legitimate files
  like keymap.ts, tokenize.ts).
- Gitignore matcher handles negation rules (!pattern) correctly.
- Context budget failures provide actionable recovery options instead of only suggesting a larger model.
- Added .lock, .map, .svg, .csv to supported extensions for explicit reads.

### Added

- Unified terminal presentation model: extended events for git state, context usage, progress stages,
  processes, worktrees, agents, integrations, and recovery suggestions.
- 16 focused deterministic tests for context management requirements.
- 19 terminal presentation tests for extended events and adapter mapping.

### Changed

- Interactive CLI: Ctrl+T opens task tree, ? shows help on empty buffer, Ctrl+K palette,
  Ctrl+R history search, Ctrl+O output viewer, context-aware footer hints.

## [0.1.0-beta.17] - 2026-07-03

### Changed

- **DeepSeek now defaults to the V4 model family.** The provider default is
  `deepseek-v4-flash`, presets prefer `deepseek-v4-flash` for fast/cheap flows
  and `deepseek-v4-pro` for quality/coding/research, with the older
  `deepseek-chat`/`deepseek-reasoner` entries kept only as compatibility
  fallbacks.
- **OpenRouter now advertises DeepSeek V4 routes.** The OpenRouter provider and
  model registry expose `deepseek/deepseek-v4-flash` and
  `deepseek/deepseek-v4-pro` as selectable built-ins.

## [0.1.0-beta.16] - 2026-07-03

### Fixed

- **Packaged CLI command dispatch now matches the development CLI.** The
  installed launcher delegates product commands such as `ask`, `fix`, `plan`,
  `yolo`, `mission`, `symbols`, `processes`, `worktrees`, `integrate`,
  `projects`, and `chat` into the bundled compiled CLI while keeping packaged
  lifecycle commands in the launcher.
- **The Windows package now ships and validates the full terminal CLI surface.**
  Release packaging compiles `apps/cli` into `orchestrator/cli`, ships the shared
  dispatcher, verifies the bundled CLI loads under the bundled runtime, and
  asserts those files in the package contract before a ZIP is accepted.
- **Safe onboarding no longer blanket-enables high-risk skills.** The
  recommended setup enables only safe-default skills and leaves offensive or
  high-risk skills disabled until individually approved.
- **Project resolution now prefers intentional local context.** Explicit
  `--project` still wins, a registered workspace matching the current directory
  overrides a stale default, `morrow init` activates the new project, and
  one-shot chat reports the active project before work starts.

### Release notes

- This beta is intended to replace `0.1.0-beta.15`, whose public installer path
  could fail during `Extracting archive...` for consumers. The beta.16 artifact
  and `latest.json` manifest must be uploaded together so
  `irm https://morrowproject.getaxiom.ca/install.ps1 | iex` downloads the fixed
  package.

## [0.1.0-beta.9] - 2026-06-25

### Fixed

- **The packaged UI now loads at the service origin.** Opening
  `http://127.0.0.1:4317/` (what `morrow open` and the installer launch) renders
  the application instead of a raw JSON probe. Earlier betas kept an explicit
  `/` route that returned JSON and advertised a Vite dev URL
  (`http://127.0.0.1:5173`) that does not exist in an installed build, producing
  `ERR_CONNECTION_REFUSED`. The dev JSON probe now only exists when no UI bundle
  is present.
- **`/api/health` advertises the real UI origin.** It now reports
  `ui: http://127.0.0.1:<port>` and `uiServed: true` for packaged installs, so
  the installer and `morrow doctor` validate a URL that actually serves the app.
- **`morrow doctor` validates the live UI endpoint.** When the service is
  running it confirms the root path returns HTML, not JSON; it stays green and
  reports a skip when the service is intentionally stopped.
- **Installer renders cleanly on PowerShell 5.1.** `install.ps1` and
  `uninstall.ps1` force UTF-8 console output and are guarded to stay ASCII-only,
  eliminating the legacy-code-page mojibake on Windows PowerShell 5.1 while
  remaining correct on PowerShell 7.

### Known limitations

- The public installer and release manifest hosted at
  `morrowproject.getaxiom.ca` are served by a deployment outside this
  repository; updating them to this release requires that external pipeline.
- This unsigned Windows beta supports read-only agent tools. Terminal and file
  write execution remain intentionally gated pending their safety boundary.
- Live provider model discovery is not available; choose a listed or custom
  model ID in Settings -> Providers.

## [0.1.0-beta.6] - 2026-06-24

### Fixed

- `morrow`, `morrow start`, `stop`, `restart`, `status`, `open`, `doctor`, and
  `uninstall` now use the lifecycle surface instead of accidentally entering a
  chat prompt. A reachable local service recovers from a missing PID file.
- The portable package serves the built GUI itself, so its browser shortcut and
  `morrow open` load the application rather than a JSON health endpoint.
- Normal packaged CLI failures now render a short Morrow error instead of a
  Node stack trace.

### Known limitations

- This unsigned Windows beta supports read-only agent tools. Terminal and file
  write execution remain intentionally gated pending their safety boundary.
- Live provider model discovery is not available; choose a listed or custom
  model ID in Settings → Providers.

### Added

- **In-app provider configuration.** Settings → Providers now lets you paste an
  API key, save it, test the connection, set a default model, and remove
  credentials — with no PowerShell, environment variables, or service restart.
  New orchestrator endpoints `POST /api/providers/:id/configure` and
  `DELETE /api/providers/:id/credentials` persist credentials server-side and
  hot-apply them to the running process. DeepSeek is a first-class provider.
- `morrow providers configure` now applies changes through the running service
  (no restart) and accepts `--model`; added `morrow providers remove`.
- Providers honor a persisted `<PROVIDER>_MODEL` default-model override.

### Changed

- Removed the misleading "edit environment variables, then restart" provider
  setup copy from the app and docs; updated README and `docs/providers.md` to
  describe the real in-app / CLI flow.

### Foundation

- Initial repository foundation
- Product vision and architecture documents
- Hermes parity and benchmark plans
- Security, contribution, and AI-agent working agreements
