# Changelog

All notable changes to Morrow will be documented here.

The format follows Keep a Changelog, and releases will use Semantic Versioning once the first public version is established.

## [Unreleased]

### Added

- **`morrow providers login codex|claude`.** The server-side "sign in with your
  subscription" OAuth flow (PKCE against OpenAI's/Anthropic's first-party
  clients) existed but had no CLI entry point. `morrow providers login <codex|
  claude|openai|anthropic>` walks the authorize-URL / paste-code exchange;
  `morrow providers logout <provider>` clears the stored tokens; `morrow
  providers list` shows the live connected/expired/disconnected state per
  provider. Once signed in, chat/agent requests use the ChatGPT or Claude
  subscription instead of `OPENAI_API_KEY`/`ANTHROPIC_API_KEY`.

## [0.1.0-beta.29] - 2026-07-11

### Changed - task-first terminal clarity

- **The final answer stays primary.** Each user task has isolated activity,
  tools, patches, and recovery state; the current answer remains visible above
  a compact completion card even in short terminals.
- **Evidence is quieter and more truthful.** Intermediate narration is
  suppressed in line mode, duplicate tool/activity lines are coalesced, and
  only explicitly identified test/check/build commands earn a `Verified`
  label. Stalled and budget-limited work is shown as paused, not failed.
- **Reports and resume are dependable.** `/output [full|failures] [task-id]`
  accepts only project-scoped full IDs or unique prefixes, full reports retain
  bounded observable activity, and resumed streams start after persisted
  history so an earlier interruption cannot hide the resumed answer.

### Added - consumer diagnostics

- **One canonical `morrow doctor`.** Source and packaged launchers now use the
  same offline-safe diagnostic engine. It checks version/runtime, platform,
  config parsing, writable state, provider setup, service identity, repository
  registration, skills, PATH, terminal, and Unicode behavior.
- **Stable and redacted diagnostics.** `morrow doctor --json` emits a versioned
  JSON-only schema with meaningful exit codes. `--export` writes an
  owner-readable diagnostic file with secret fields, credential-shaped values,
  and the user-home prefix redacted.

### Fixed - security and lifecycle integrity

- Task IDs are encoded on every API/SSE path, and task report lookup can no
  longer fall back to arbitrary raw IDs or read another registered project.
- Provider and tool text is stripped of terminal control sequences before
  interactive or redirected rendering.
- Terminal events persist exactly once, patch recovery uses real correlated
  payloads, and duplicate completion events produce one completion card.
- Installer health gates require the Morrow service identity and supported API
  version. Missing PID recovery additionally verifies the owning OS command
  line before any process can be terminated.
- Removed a raw workspace-path stdout leak and retired the broken duplicate
  CommonJS-in-ESM doctor implementation.

## [0.1.0-beta.28] - 2026-07-10

### Changed - terminal-first agent experience

- **CLI-only terminal overhaul.** Morrow now stays in the normal terminal
  scrollback buffer with native selection, deterministic Ctrl+C behavior, and
  visible feedback when input arrives while the agent is busy. The Morrow
  avatar and terminal identity adapt cleanly across narrow and wide layouts;
  no browser UI opens as part of the terminal workflow.
- **Truthful runtime statistics.** Provider, model, context, token, and cost
  fields reflect persisted facts. Unavailable values remain explicitly
  unknown instead of being fabricated.
- **Safer project continuity.** Current-working-directory resolution is
  bounded and predictable, cross-project resume is refused, and prior results
  remain retrievable after an orchestrator restart.

### Added - durable task reports

- **Durable output commands.** `/output`, `/output full`, `/output failures`,
  and `/export` use the same bounded persisted task facts, including canonical
  final-answer selection, tool totals, recovery facts, and restart-safe
  retrieval.
- **Bounded report requests.** Task-report reads have explicit time bounds so a
  missing or unhealthy service fails visibly instead of hanging the terminal.
- **ConPTY/PTTY acceptance coverage.** The terminal interaction path is covered
  across rendering, normal scrollback, input reliability, task execution,
  output retrieval, export, and restart recovery.

### Fixed - assistant and recovery report integrity

- **Authoritative assistant turn boundaries.** Persisted turn IDs identify the
  canonical tool-free Final Answer and keep completed non-final turns out of
  it. Replayed events and cumulative snapshots cannot accumulate or duplicate
  assistant content.
- **Bounded Intermediate Activity.** Reports include each non-final assistant
  turn at most once as concise user-facing activity, exclude the canonical
  final turn, and do not expose raw planning narration or hidden reasoning.
- **Clean Recovery Summary.** Failed tool calls and strategy switches are
  deduplicated and grouped from authoritative persisted facts. Reports state
  what failed, the recovery strategy, and the final outcome without repeated
  payload dumps; generated Markdown contains no whitespace-only lines.

## [0.1.0-beta.27] - 2026-07-08

### Fixed - reliable consumer edit recovery

- **File-scoped search works.** `search_text`, `search_files`, and `list_files`
  now accept a contained file path as their scope instead of failing with
  "Workspace start path must be a directory"; a file path searches just that
  file. Containment and traversal checks are unchanged and still run first.
- **`create_file` recovers into an edit.** When `create_file` targets a file
  that already exists, Morrow automatically switches to a whole-file edit that
  flows through the same approve/apply/change-set pipeline, so the original is
  backed up and the overwrite is undoable. Only regular files are overwritten;
  a directory at the path is a hard error, blank content will not replace a
  non-empty file, and identical content is reported as a no-op. The tool result
  records the conversion.
- **The malformed-patch loop is broken.** When a model repeatedly proposes a
  diff with a wrong hunk line count — each attempt differently broken, so no
  per-hash retry ceiling ever trips — Morrow now counts failures per target file
  and, after two, tells the model to stop authoring diffs and call `create_file`
  with the complete file contents, which applies as a safe backed-up edit. This
  is the escape hatch out of the beta.26 second-pass edit loop.
- **Failed verification cannot report success.** A `run_command` that exits
  non-zero is a failed verification even though the tool ran. A task no longer
  ends as `completed` when the last required change or verification failed and
  was not recovered; it stops cleanly as interrupted. A later successful run
  clears the outstanding failure.
- **Honest YOLO wording.** YOLO is described as workspace-autonomous — it edits,
  runs, and verifies inside the workspace without prompting, and is explicitly
  not unlimited system access — across the status line, `/yolo policy`, the
  command list, and onboarding.

## [0.1.0-beta.26] - 2026-07-08

### Fixed - consumer onboarding and execution flow

- **Multiline initial missions are preserved.** Custom onboarding missions now
  use an explicit multiline prompt, so pasted task requirements are retained
  instead of being truncated at the first line.
- **YOLO carries into the first mission.** Choosing YOLO during onboarding now
  persists the auto-approval default and launches the initial mission in the
  selected project with that scoped autonomy.
- **Approval rendering is defensive.** Missing or malformed approval metadata no
  longer crashes the terminal renderer; command and change-set approvals are
  displayed through a safe view model with conservative fallbacks.
- **Child workspaces stay exact.** When Morrow is launched from an ancestor
  repository while a registered child workspace is selected, the child project
  wins so parent sessions and parent Git changes are not reused accidentally.
- **Nested Git status is scoped.** Header/status Git reads now use a top-anchored
  pathspec for child workspaces and record ancestor-root context instead of
  presenting unrelated parent dirty counts as child changes. Agent-facing Git
  inspection tools also scope status, diff, and log reads to the registered
  workspace when it sits inside an ancestor repository.
- **Progress and terminal outcomes are clearer.** Stall detection now treats
  changed tool observations as meaningful progress, emits a warning before a
  stall, and keeps completed/stalled/cancelled/failed/interrupted terminal
  outcomes mutually exclusive in the CLI presentation state.
- **Large edit recovery is bounded.** Valid large `create_file` and
  `propose_patch` arguments are capped only in model-facing context after the
  raw tool call is persisted, while malformed patch parse failures return
  actionable bounded feedback or stop cleanly. Turns containing only failed
  tool calls no longer reset progress just because the model narrated the retry.
- **Explicit file-only missions are enforced.** When a mission says to use only
  named deliverable files, auxiliary scratch writes are rejected and the model is
  directed to verify with commands such as `node -e` instead.

### Security

- Codex Security diff scan completed with preflight ready, 12/12 discovery rows
  reviewed, and 0 reportable findings. Evidence is preserved under
  `docs/security/beta26-scan/`.

## [0.1.0-beta.25] - 2026-07-07

### Fixed — agent patch & tool-call reliability

- **Multi-file change state transitions** are stabilized: proposing a patch now
  transitions through `proposing_changes` before the dry-run, so multi-file and
  iterative edits follow a valid, predictable state sequence.
- **Stale patch recovery.** When a patch no longer applies cleanly (the file
  changed earlier in the run), Morrow returns bounded, structured feedback — the
  target file, failed hunk, conflict category, and a current-file hash/content
  preview — so the model regenerates against current contents instead of
  resending a stale diff. Recovery only accepts conservative *unique* matches
  (line-number drift, CRLF/LF differences, harmless trailing whitespace, a
  unique changed-context deletion target); ambiguous matches are rejected.
- **Malformed tool-argument recovery.** Invalid provider tool-call arguments are
  no longer a hard failure. A single conservative repair pass fixes code fences,
  surrounding prose, and trailing commas; truncated, merged, escaped-path, or
  otherwise unparseable input is classified and refused with a bounded
  correction opportunity. Write-tool arguments are schema-validated before
  dispatch, so a malformed argument can never reach `applying_changes`.
- **Bounded retries.** Repeated stale patches or malformed arguments are limited
  to one corrective retry per patch hash / tool, then stop cleanly instead of
  looping.
- **No-op patch rejection.** An approved edit patch that produces no content
  change is rejected as `patch_no_effect` before it can be recorded as a
  successful edit.

## [0.1.0-beta.24] - 2026-07-07

### Changed — YOLO is workspace-autonomous for normal development

- **YOLO now permits ordinary development operations inside the active
  workspace** without prompting: creating directories and files, editing files,
  running package-manager commands (`npm`/`pnpm`/`yarn`, including `install`),
  running builds and tests, and running safe non-destructive project commands.
  Autonomy is **workspace-scoped**, not machine-wide.
- **Hard safety boundaries are unchanged and still enforced in YOLO.** Morrow
  still refuses to delete home/system directories, read or exfiltrate
  credentials, modify anything outside the workspace, escalate privilege, run
  destructive global commands (`format`/`shutdown`/`rm -rf`), rewrite or
  force-push Git history, or transmit data over the network. This is
  workspace-scoped autonomy with protections — **not** unrestricted system
  access.

### Added — reliable file/directory creation tools

- `create_file` (plain path + content) and `create_directory` tools give the
  agent a dependable, cross-platform way to scaffold a project. They flow
  through the same approval, change-set, backup, and undo pipeline as patches,
  so `/changes` and `/diff` reflect created files and creation is reversible.
  New-file creation via `propose_patch` (`--- /dev/null` hunks) is also now
  supported.

### Fixed — Windows command handling and workspace paths

- **Windows-safe command handling.** Bare `mkdir`/`md` (Windows shell built-ins,
  not executables) no longer fail opaquely; they are declined with a pointer to
  `create_directory`. A narrow, strictly-validated `powershell New-Item` form for
  creating a workspace file/directory is permitted; general shell invocation
  stays denied. Guidance now steers the agent away from `&&` chaining and
  interactive scaffolders.
- **Workspace path normalization.** Containment checks are case-insensitive on
  Windows and computed via `path.relative`, fixing false
  "outside the configured workspace" errors — including for **OneDrive**-based
  project paths where `realpath` can differ in drive-letter case.
- **Long tool summaries no longer crash a run.** Approval summaries longer than
  the 240-character schema limit are truncated before validation instead of
  throwing.
- **Repeated denied-command recovery is improved.** Denials return actionable
  messages naming the allowed equivalent, and `install`/`build`/`test` commands
  get a longer execution timeout so ordinary `npm install` / `npm run build` no
  longer time out.

### Verified

- **Consumer Todo-app acceptance passed.** From an empty directory, Morrow
  autonomously created a React + Vite + TypeScript Todo app (localStorage,
  light/dark, add/edit/delete/complete, responsive CSS, no backend, no UI
  library), ran `npm install` and `npm run build` (both exit 0), with all files
  contained in the workspace and `/changes`/`/diff` matching the created files.
- **Morrow remains CLI-only.** No browser is opened, no dashboard/localhost is
  advertised, and no web application assets are bundled or required.

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
