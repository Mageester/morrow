# Changelog

All notable changes to Morrow will be documented here.

The format follows Keep a Changelog, and releases will use Semantic Versioning once the first public version is established.

## [Unreleased]

## [0.7.0] - 2026-08-25

Morrow can run a live server and let you reach it. Background jobs — dev
servers, watchers — were already supervised durably; now they are visible,
their address is read from what they printed, and one asked to stay up
survives the task that started it. The conversation also reads in the order
the run happened rather than as a summary above a wall of text.

### Added

- Background jobs are visible and controllable from the web app. A dev server
  or watcher the agent started with `run_command background:true` now appears
  above the composer while it runs, with the address it is listening on as a
  link, its own stdout/stderr, and a Stop button. The supervisor behind this
  already existed; nothing in the browser had ever admitted it did.
- Morrow reports where a background process is listening, parsed from the
  process's own startup output rather than by scanning ports — so the address
  is attributable to the line that announced it, and Morrow never claims a
  server it did not start. Wildcard binds (`0.0.0.0`, `::`) are normalized to
  loopback so the link is openable, and flagged as rewritten so the surface can
  say the link differs from the log.
- `read_process_output` returns those endpoints too, so the agent no longer has
  to infer a URL from a log slice when it polls a server it just started.
- `/ps` gained an Address column and `/ps logs <id> [stdout|stderr]`. It could
  start and stop a dev server long before it could show you why one failed to
  come up.
- A background job can be asked to outlive the task that started it. Until now
  a finishing task force-stopped everything it had started, so "start the dev
  server and leave it running" was refused rather than served — the server died
  the moment the agent stopped. `run_command` gains `keepAlive`, and only those
  jobs are exempt from cleanup; anything the agent started to check its own work
  is still stopped. Kept-alive jobs are labelled "stays up" in the dock, so one
  that outlives its task is visible rather than abandoned.

### Changed

- A conversation now reads in the order the run happened. An assistant turn is
  rendered as the sequence it actually was — what Morrow said, the tool calls
  that followed it, what it said next — instead of a summary box listing every
  tool of the task above one block of text. This applies to the web chat and to
  the interactive terminal, which previously pooled a whole task's tool calls
  into a single block after all of its prose.
- The web chat renders the assistant's intermediate narration, which the
  durable projection had always recorded and no surface had ever shown. It also
  stops rendering `message.content` beside that narration: while a task streams
  that field is a whole-task accumulator of every turn's text, so the transcript
  was printing the run twice — once in order, once as one growing blob.
- Morrow's words in the web chat sit flat on the page rather than in a bubble;
  yours still sit in one. One bubble per turn made sense when a turn was one
  block, and read as a column of disconnected cards once it became a sequence.
- The per-turn totals ("Completed · 41s · 9 tools") moved from above the answer
  to a receipt line under it, and are no longer drawn while a turn is running —
  the live status line above the composer already answers that.

## [0.6.0] - 2026-08-25

Morrow can use skills other people wrote. Installing one is treated as granting
a capability rather than copying a file, so you see where it came from and what
it asks for before it lands. This release also cuts what a task costs to run:
Anthropic routes stopped re-paying full price for the same conversation on
every turn.

### Added

- `morrow skills install <source>` installs a skill from GitHub
  (`owner/repo`, `owner/repo@v1.2`, or a link copied from the address bar), a
  local folder, or a `.tar.gz`. A source holding several skills lists them
  rather than guessing, found at any depth — `skills/<name>/SKILL.md` is the
  common layout. `morrow skills remove <id>` removes one Morrow installed;
  bundled skills are refused, since an upgrade would put them back.
- The Skills page installs one too, showing provenance, requested permissions,
  and which metadata Morrow had to invent because the bundle shipped none.
- Morrow can install a skill mid-task with `install_skill`, behind a one-shot
  approval that names the real source and permissions. The task-level
  auto-approve flag does not reach it: "trust this project" must never become
  "install whatever you like from the internet".
- A plain `SKILL.md` folder — the common ecosystem shape — is normalized into a
  manifest, permissions and a checksum on the way in, and the plan says which of
  those Morrow wrote rather than read.

### Changed

- Project selection now has an OS folder picker, active-project history/new-chat
  actions, and an honest provider “Needs a model” readiness state.
- Local-only privacy is enforced at routing and tool boundaries; interrupted
  agent work has a project-scoped resume endpoint; Activity / Inspect can
  download a redacted support bundle.
- Compact mobile composers keep provider/context capability status reachable;
  Teams is present in primary navigation; doctor reports optional PTY support.
- Missions and New chat are now first-class destinations in the desktop rail
  and five-slot mobile dock; mobile setup routes New chat to project selection
  until a project is ready.
- Bundled high-risk red-team skills are withheld from the default executable
  catalog until an explicit security-review workflow exists.

- Anthropic requests now carry `cache_control` breakpoints on the stable
  tools+system prefix and the end of the conversation. Morrow already priced
  cache reads end to end but never asked for the cache, so every turn re-read
  the system prompt, every tool schema and the whole transcript at full price.
- The teammate rail stops polling a hidden tab once no run could still finish.
  Visible tabs are unchanged.
- The prepared-statement cache is now least-recently-used and sized above the
  statement population it has to hold, instead of thrashing on ordinary traffic
  and evicting its hottest entries first.

### Fixed

- Anthropic usage accounting: `input_tokens` counts only the uncached portion,
  while everything downstream treats prompt tokens as the whole input. Left
  unchanged it would have under-reported both context size and cost the moment
  caching started hitting.
- All four provider adapters subscribed to the caller's abort signal on every
  request and never unsubscribed. That signal lives as long as the task, so a
  long run leaked a listener per provider call, each pinning an AbortController.
  Same leak in the MCP tool bridge and pool.
- The teammate roster read and sorted every conversation and every agent task in
  the project on each poll — every three seconds, per open tab — to keep one row
  per teammate. Covering indexes and one indexed seek per teammate: 10.7ms per
  poll becomes 0.01ms on 20k conversations.
- Browser output is sanitized ~6x faster on the clean text that makes up nearly
  all of it; the guard was recompiling twelve regexes and walking the text twice
  for every console line a page emits.
- Three source files carried raw NUL bytes, which made grep and ripgrep treat
  them as binary and skip them in repo-wide searches.

## [0.5.1] - 2026-08-24

A packaging fix. 0.5.0's bundle was assembled from the orchestrator's
dependencies alone, so the terminal never started; 0.5.1 is 0.5.0 with a
package that contains what the CLI actually needs.

### Fixed

- The released package shipped without `react` and `ink`, so every terminal
  surface — `morrow onboard`, the shell, the launchpad — failed immediately
  with "Cannot find package 'react'". The compiled CLI is placed under
  `orchestrator/` and resolves from that one flat `node_modules`, which was
  installed from the orchestrator's dependencies only. Once the terminal was
  rebuilt on Ink, `ink` and `react` were declared by `@morrow/cli` and by
  nobody else, and silently stopped being packaged. The packaged dependency
  set is now the union of both manifests, so it stays correct as either
  package's dependencies move.
- The build gate that was supposed to catch exactly this only ran `morrow
  --help`, which never imports an Ink module — a bundle with no terminal UI
  passed it cleanly. The gate now imports the Ink entry points directly under
  the bundled runtime, and packaging fails if they cannot resolve.
- `tar -tzf` read the archive listing through `execFileSync`'s 1 MB default
  buffer. A release archive lists ~16,000 entries, so the listing grew with
  every added dependency and the packaging step began failing with `ENOBUFS`
  once the bundle was complete.

## [0.5.0] - 2026-08-24

Morrow runs where you are, and its teammates are reachable from the chat you
actually use. This release also stops a reasoning-heavy model from turning a
whole task into one unbroken block of thinking, ships native POSIX packages,
and replaces first run with a launchpad.

### Added

- `morrow web` (aliases `gui`, `ui`) opens the local web interface, `morrow
  status` prints its URL, and `morrow --help` lists it directly under `morrow`.
  A fully tested web app shipped in 0.4.0 and the CLI never named it once, so
  the only way to find it was to read the orchestrator's static-app route.
  `morrow web --json` emits `{ url }` without starting the service; every other
  form starts it first, because a URL handed over while the service is down is
  a connection error with extra steps.
- First run is an Ink launchpad instead of a wall of prompts, sharing the
  wordmark the rest of the shell uses.
- Native POSIX release prebuilts, and live install provenance is gated rather
  than asserted.
- Comprehensive external model metadata (models.dev) as a first-class
  capability source. Morrow no longer needs a developer to hand-teach it every
  model: connecting a provider and refreshing metadata now yields real context
  windows, output ceilings, modalities, vision, tool calling, structured
  output, temperature support, reasoning support and — where the source
  actually enumerates them — the exact reasoning depths a model accepts.
  Ingestion covers every provider Morrow can route to rather than six.
- Gateway model resolution: an id such as `anthropic/…` reached through
  OpenRouter, Vercel or TokenRouter resolves the underlying model's facts while
  the gateway's own adapter keeps ownership of the request format. A vendor's
  wire dialect, reasoning off-switch and sampling support never cross that hop.
- `interleaved` reasoning is represented as a capability, and reasoning now
  distinguishes all six states a route can be in, including "reasons, controls
  unknown" — which is what stops a level list being invented for a route that
  merely advertises an effort field.

### Changed

- Morrow runs wherever you are. The current directory is now the workspace: a
  directory with no registered project is adopted as its own project (and
  initialized as a Git repository, so change tracking, checkpoints and rollback
  keep working) instead of silently resuming whatever project was configured
  last. Opening a terminal in a scratch folder and asking Morrow to install or
  try something no longer operates on an unrelated checkout.
- `morrow init` no longer requires a Git repository, and directories are no
  longer judged by name — `Downloads`, `Desktop` and `Documents` are ordinary
  workspaces. Only a drive root and `$HOME` itself are still refused as too
  broad. `morrow init --here` registers exactly the given directory instead of
  snapping to the enclosing repository root.
- Startup and per-request overhead are measurably lower, with the deterministic
  evidence recorded in `docs/performance-report-2026-08-23.md`.
- One less full token count per turn. `projectProviderRequest` measured the
  request to decide whether compaction was needed and then, when it was not,
  measured the identical request again inside admission — so the common path
  counted the whole history twice. On the benchmark's 361-message context the
  projection drops from 5.95 ms to 4.02 ms per turn.
- Build mode is told to say what it is doing as it works. Nothing previously
  asked for a line of ordinary text between tool calls, so a model that
  narrates inside its reasoning ran an entire task without reporting a single
  thing it had done.
- Generated artifacts and superseded beta documentation are out of the working
  tree (still in Git history), four orphaned modules are deleted, and the
  GitHub Actions in CI are on current majors.
- Capability precedence is explicit end to end: adapter-native > deployment >
  live provider discovery > operator route configuration > Morrow-verified
  corrections > external catalog > bundled seed > unknown. The bundled catalogs
  are now Morrow's *corrections and offline seed* rather than its only
  knowledge, and the flat model catalog and the exact-route resolver share one
  merge policy, asserted by a conformance test.

### Fixed

- Thinking no longer grows without bound. Reasoning settled only on the first
  token of an answer, so every turn that ended in a tool call — which is most
  of an agentic run — left its thinking in the live buffer for the next turn to
  append to. A reasoning-heavy model that emits no text between tool calls
  produced one block that grew for the whole task, never collapsed, and never
  attached to the turn that produced it. A turn's thinking now settles when the
  turn does, and a tool call ends "thinking" exactly as the first token of an
  answer does.
  Reasoning is streamed to a separate view and is never the answer, so a turn
  that only thinks and calls tools reports nothing at all. The instruction to
  say what you are doing between tool calls used to live inside the Build-mode
  block; Ask and Plan read for minutes at a stretch and were just as free to go
  dark, so it now ships for every mode.
- Every bundled skill is loadable. Of 55 skill directories, 18 did not work:
  fifteen had no `manifest.json` or `permissions.json` and were skipped by
  discovery in silence, and three carried a checksum that no longer matched
  their `SKILL.md`, so they could be listed but never enabled. The two skill
  registries also disagreed — the CLI required a manifest entrypoint the
  orchestrator has always treated as optional, so instruction-only skills
  verified for the agent while being invisible to `morrow skills list`. A skill
  is the workflow in its `SKILL.md`, an entrypoint is optional, and all 55 now
  verify under both registries.
- Morrow no longer runs `git init` inside an existing checkout. Adopting the
  current directory as a workspace tested freshness with `existsSync(".git")`,
  which only recognises a repository *root*, so any subdirectory of a checkout
  looked brand new and was given its own nested repository plus a starter
  `.gitignore`. A nested repository shadows the real one for every Git command
  beneath it, destroying exactly the change tracking the setup exists to
  provide. Freshness is now "not inside any work tree".
- Morrow can talk to the teammates you create. `ask_teammate` was exposed only
  to a run assigned a named agent profile, and refused outright otherwise, so
  the main Morrow chat never received the tool and was never told the project's
  teammates existed. It is now available to the orchestrator itself whenever
  the project has at least one eligible standalone teammate. Morrow holds no
  standing trust grant, so each request still stops for a fresh one-shot
  approval.
- `morrow onboard` and the project picker no longer die with "Detected
  unsettled top-level await". Ink's teardown calls `stdin.unref()`, which
  `resume()` does not undo; readers now re-ref stdin before reading.
- The terminal is restored when the shell exits abnormally. `startShell` enters
  the alternate buffer and left it only on an ordinary stop, so a crash or a
  signal left the invoking shell with no scrollback and a mouse wheel that sent
  arrow keys.
- Fix mode stays approval-gated.
- Mobile layout and contrast invariants are restored in the web interface.
- Release publication is bound to main and to the version tag.
- YOLO asked for approval. A mode whose entire purpose is running unattended
  stopped on every shell command, and since an agent runs most of its work
  through `bash -c`, that meant a prompt for nearly every step — in one real
  session, 9 of 9 approvals raised during a YOLO run were shells. YOLO now runs
  every command it is given without asking, and says so plainly on entry
  instead of describing a narrower policy than it has. The categorical block
  list (privilege escalation, host shutdown, disk wipes, workspace escape,
  force push, history rewrites) is unchanged: those are refused in every mode
  and were never prompts being skipped.
- Public metadata refresh could not succeed at all: the response cap was 4 MiB
  against a 4.1 MiB document, and a strict ingestion schema discarded an entire
  provider over one unusual row — `anthropic`, `openai`, `groq`, `xai`,
  `mistral` and `nvidia` all yielded nothing.
- A cached metadata snapshot could stop Morrow starting. Upstream publishes
  both `claude-haiku-4-5` and the dated id Morrow declares it an alias of, and
  the resulting ambiguous identity threw inside server construction. Such a
  snapshot now folds correctly, and any snapshot Morrow cannot install falls
  back to bundled metadata instead of failing the boot.

## [0.4.0] - 2026-08-22

Teammates stop asking permission for every step. A delegation used to pause for
a fresh decision on every hop, which is right for a first handoff and is why a
roster of specialists could never behave like a team. This release adds the
durable record of a decision you make once, hardens the authority model that
record leans on, and makes the composer's floating panels visible again.

### Added

- Standing teammate trust grants: a named teammate can hand work to another
  without a prompt per hop. A grant binds the target's profile fingerprint,
  carries its own delegation-depth and fan-out ceilings measured over the
  durable task chain, is revocable, and is granted per pair from that
  teammate's own Coordination settings. Every way a grant can fail to apply
  falls back to asking rather than to proceeding.
- Recent runs: what the scheduled routines did unattended, with failures and
  approval waits surfaced instead of hidden behind a per-schedule drill-down.
- A build gate that fails on an orchestrator route no client can reach, so
  capability can no longer ship without a way in.
- An isolated orchestrator and web stack for local verification, so a
  verification run cannot reach the developer's own database.

### Fixed

- Skill-access routes are scoped by project; an agent id from another project
  no longer resolves.
- Delegated memory writes are intersected separately from reads, so a read-only
  team policy cannot promote readable memory into writable memory on a child.
- Delegation preserves an unrestricted tool policy instead of narrowing it to
  an accidental singleton allow-list, and the sole-allow invariant is enforced
  at the repository boundary.
- Team delegation children are bound to the approved profile hash, profile
  drift resolves to one consistent interrupted state, spawns are idempotent,
  orphaned children are cleaned up, and the team concurrency limit is enforced.
- Teammates with live delegations or running tasks can no longer be deleted.
- Every floating panel in the composer — model picker, Thinking, settings, and
  capability status — is visible again. They were being clipped out of
  existence by the chip bar's scroll container.
- Portaling those panels cost them their own width cap and every stylesheet
  rule scoped through the composer; both are restored, and a panel whose
  trigger is hidden at a breakpoint now closes instead of stranding itself in
  the corner.
- The capability status control has an accessible name describing what it does
  rather than only the route it is showing.

### Limitations

- Migrations 63 and 64 are a one-way door: once a database is opened by this
  release, an earlier build cannot open it again, because the orchestrator
  refuses a schema newer than itself. Upgrade rather than downgrade.
- Group conversations remain reachable only through the API. The orchestrator
  enforces participants and membership, but nothing in the interface creates
  one yet.
- Six end-to-end tests fail in this release. All six failed in 0.3.0 as well;
  none is a regression, and none is a credential leak. The accessibility
  failure on Home is real and unfixed.

## [0.3.0] - 2026-08-21

AI teammates become a usable local-first team: named specialists can share
bounded work, remember their own durable context, run scheduled routines, and
show their work as evidence in one conversation.

### Added

- Secure teammate collaboration through the explicit `ask_teammate` tool,
  including legacy teammate compatibility, child identity, bounded policy, and
  durable handoff state.
- Shared teammate conversations with roster membership, participant controls,
  handoff rows, evidence references, and live status updates.
- Private teammate memory with explicit ownership and project isolation.
- Routine recording by demonstration, editable routine definitions, schedules,
  pause/resume/manual-run controls, run history, and configurable notification
  policy.
- A beginner walkthrough for creating a teammate, asking for help, and
  recording a routine: `docs/guides/blank-state-teammates-walkthrough.md`.

### Fixed

- Teammate prompts now include the assigned specialist's identity and purpose,
  instead of presenting every specialist as a generic assistant.
- Teammate creation and participant removal work across the legacy and current
  API shapes, including bodyless removal requests.
- Durable teammate memory, handoffs, routine schedules, and notification
  outbox state survive restart without exposing provider text or private
  reasoning in conversation projections.

### Changed

- The web app is organized around a teammate roster and human-readable
  conversation evidence, with responsive layouts through 390px mobile.
- Routine execution re-prompts from recorded observations rather than replaying
  historical tool calls; every run remains bounded by the saved teammate
  policy.

### Limitations

- Teammates remain local-first and provider-neutral; external provider access is
  still opt-in and uses the configured provider credentials.
- Write and terminal tools remain gated by their existing approval and trusted
  workspace boundaries; this release does not silently broaden permissions.
- Public installation is not complete until the release workflow publishes
  verified Windows artifacts and the separate website deployment is performed.

## [0.2.0] - 2026-08-19

The rebuilt shell was fast and quiet. Too quiet: it went blank between
submitting a message and the first token, showed a green tick beside a running
turn's tool count, and said nothing at all when a task failed. A provider error
left the last successful tool's checkmark on screen and handed back the prompt,
so a failure was indistinguishable from an answer that never came.

### Added

- A live activity line (`terminal/ink/activity-line.tsx`): present from submit
  to settle, carrying a spinner, the tool in flight in the present tense,
  elapsed time, the tokens the provider actually reported, and `esc to
  interrupt` — which has always worked and was never advertised.
- A plan the model writes. The `write_plan` tool takes the whole list on every
  call, so marking a step running or done needs no incremental events and the
  terminal cannot drift out of step with the runtime. It publishes
  `plan.published`, kept separate from the internal `plan.created` scaffold, and
  renders in `terminal/ink/plan-view.tsx` windowed around the running step.
- `terminal/ink/outcome.tsx`: every ending that is not an answer — failed,
  stalled, budget-reached, cancelled, interrupted — with the reason the runtime
  gave and the commands worth trying next. Cancelling stays quiet.
- Ctrl+X hands the draft to `$EDITOR` (`terminal/external-editor.ts`), honouring
  `MORROW_EDITOR`, `VISUAL` and `EDITOR`. Quitting the editor leaves the draft
  untouched.
- Ctrl+P opens the conversation for reading (`terminal/ink/transcript-overlay.tsx`):
  scroll, `/` to search, `n`/`N` to step matches, `g`/`G` for the ends. It is an
  overlay rather than a scroll of the live transcript, because settled turns
  live in Ink's `<Static>` and that is what keeps a long session as cheap to
  render as an empty one.
- `/find` searches this conversation and reports the turns that match; `/copy`
  puts the last answer on the clipboard.

### Fixed

- The shell claimed a running turn was finished. The collapsed work summary
  chose its mark from whether a tool was mid-flight, and between calls — every
  second the model spends generating — none is, so it fell through to a tick and
  read "completed 11 tools" on a turn that was still going.
- Nothing rendered between hitting enter and the first token, because the work
  summary was gated on having tools and the live turn on having text. A slow
  provider was indistinguishable from a shell that had ignored the keystroke.
- A failed task printed nothing. `task.failed` set `lastError` in the reducer
  and no component in the shell ever read it; the plain-line surface had been
  printing `Task failed: …` the whole time.
- The progress warning contradicted the line above it, announcing that nothing
  observable was happening directly beneath a report of the elapsed time and the
  tool in flight. It now dims that line instead of arguing with it.
- Tool rows said the verb twice. `run_command` arrives with
  `purpose: "Run pnpm test"`, so composing verb and target produced "Ran Run
  pnpm test". Both tenses now come from one table.
- The model's reasoning wrapped at an exact column, cutting every wrapped line
  mid-word — the one view in the shell that did not wrap like the rest of it.

### Changed

- `docs/HERMES_PARITY_MATRIX.md` section 1 is re-verified against the current
  tree. Every row cited `commands.ts`, `completion.ts`, `input-state.ts`,
  `runtime.ts`, `app-view.ts`, `session.ts` or `paint.ts` as evidence, and all
  seven were deleted in 0.1.1 — so every `VERIFIED` was resting on files that no
  longer exist. Statuses are now set against pi v0.84.2 and the local Hermes
  checkout, and the gaps that remain are named as gaps.

## [0.1.1] - 2026-08-18

The terminal shell is rebuilt. The CLI advertised seventy-one slash commands
and implemented eight; arrow keys, Home/End and history did nothing; a
multiline paste destroyed the line; pressing `/` printed a hundred and twenty
rows over the composer. Underneath were three separate command implementations
that disagreed about which commands existed.

### Added

- A real composer (`terminal/ink/editor.ts`) as a pure state machine:
  grapheme-aware cursor motion, word boundaries, multiline navigation with a
  remembered goal column, history recall, an Emacs kill ring, and paste capture
  that holds a tall block behind a token and sends it verbatim.
- One command registry (`terminal/commands/`). Handlers return a structured
  `Report` and never paint, so the same command serves the interactive shell and
  the plain-line fallback.
- Live reasoning. Providers already captured chain-of-thought but Morrow
  deliberately never stores it, so it now travels on an ephemeral in-memory
  channel (`execution/live-bus.ts`) that exists only while a client is attached.
  It renders above the answer it produced and expands with Ctrl+R. It is not
  replayable and never appears in `/output` or `/export`.
- `docs/TERMINAL.md`: keyboard reference, command reference, and the
  architecture behind them.

### Fixed

- Approvals never appeared. The runtime emits `approvalId`; the shell read
  `id`, so every approval was discarded, the answering keystroke went into the
  composer, and the task waited forever for a decision nobody could see.
- Batched input never sent. A terminal delivers a fast-typed run as one string
  with the carriage return inside it, and the whole line was inserted as text.
- Several keypresses arriving in one React tick all read the same stale
  snapshot, so holding an arrow key moved the caret exactly one column.
- The model picker hid 165 of 168 reachable models: it required a `current` or
  `preview` lifecycle, and every model discovered from a live provider account
  is recorded as `custom`. Availability now decides visibility; lifecycle only
  decides order.
- Tool rows read "completed" because the runtime sends that as the summary.
  They now say what happened: "Read package.json", "Ran pnpm test".
- Startup adopted an already-finished task and reported it stalled; progress
  warnings outlived the task they described; `/clear` left everything on screen;
  `/status` kept naming the conversation you started in after `/resume`.

### Changed

- Startup is 452ms, from 1917ms. `service/lifecycle.ts` and `config/paths.ts`
  reached the orchestrator barrel at module scope, pulling the agent runtime
  into every invocation, and `main.ts` eagerly imported all twenty-five command
  modules.
- The slash-command surface is 44 commands, from 71. Eleven only printed "run
  `morrow X` in your terminal"; fifteen views are consolidated under `/cortex`
  and `/mission`.

### Removed

- The legacy frame renderer, deleted rather than kept behind an env var:
  `session.ts`, `app-view.ts`, `input-state.ts`, `runtime.ts`, `paint.ts`,
  `startup-view.ts`, `activity-view.ts`, `commands.ts`, `command-groups.ts`,
  `completion.ts`, `palette.ts`, `mascot.ts`, and the duplicate `handleSlash`
  in `chat.ts` — about 12,500 lines.

## [0.1.0] - 2026-08-17

First non-prerelease. Morrow leaves beta with the conversation, not the event
log, as the thing you look at.

### Added - the chat reads as a conversation

- **Execution telemetry left the transcript.** Normal chat rendered the full
  activity projection, so an ordinary turn became a wall of `Thinking`,
  `Route selected`, `Context budget calculated` and `Provider failure
  classified` rows with the answer somewhere inside it. A chat-side projection
  now classifies each event as narration, work, an exceptional transition, or
  routine bookkeeping, and the reading column shows only the first three. On a
  real conversation that removed 26 rows from the transcript. Nothing was
  deleted: every event stays in Activity / Inspect and in durable storage.
- **An assistant turn is one unit** — a compact work summary, any exceptional
  transition, then the answer. Repeated read-only operations collapse into one
  row (`Files read · 9`); failures and in-flight steps always keep their own.
- **Activity is one opt-in drawer.** The permanently docked live-work rail
  duplicated what the turn summaries already said, and is gone. The drawer
  narrows the conversation on a wide screen and becomes a sheet below that.
- **A polished failure surface.** A failed turn recorded its reason as a raw
  trailing `[Error: …]` on the message. It is now split from the prose,
  classified as a provider, tool, permission, network or runtime failure, and
  shown verbatim behind Details, with Retry where the turn supports it.
- **One live status line** above the composer, reporting the real lifecycle
  phase and appearing the moment Send is pressed rather than when the provider
  replies.
- **Conversations name themselves** from their opening message, so the sidebar
  stops reading as a column of identical entries.

### Fixed

- A running turn's elapsed time was derived from event timestamps, so the
  counter visibly froze for the whole stretch the model spent thinking — the
  part a reader most wants counted. It now runs against the wall clock.
- Autoscroll watched the document, which never scrolls, instead of the
  conversation's own scroll container. Following, disengaging on upward scroll,
  and Jump to latest now work against the element that actually moves.
- `.morrow-sr-only` had no CSS rule anywhere, so labels intended only for
  screen readers were rendering as visible page text across the composers and
  mission surfaces.
- Tools without a hand-written verb all rendered as `Used tool`, making
  distinct actions look like one repeated step. They are now named after the
  tool that ran.

### Changed

- The composer is one row. Thinking depth, workspace trust and the mode
  consequence moved into two popovers; every control is still present and still
  in tab order.


### Added - the chat remembers what it already did

- **A follow-up turn no longer starts from nothing.** Earlier turns in a
  conversation were replayed to the model as plain user/assistant text, so every
  file read, search, command, and patch from those turns was dropped. The model
  had no way to know it had already looked at a file, and re-explored the project
  once per turn, forever. Each turn now carries a bounded digest of the work the
  conversation has already done, rebuilt from the durable tool-call log.
  Measured on the same 6-turn session: 19 tool calls and 4 wasted discovery
  calls before, 10 tool calls and none after.
- **Remembering stays cheap.** The digest is capped at ~2.4 KB over a sliding
  12-turn window, ordered so changes and command outcomes survive truncation
  ahead of exploration. A 26-turn session holds it under 900 characters.
- **A command that already failed is not re-run blind.** Command outcomes carry
  their exit code across turns, so "try that again" can act on what happened
  instead of repeating it.
- **`morrow acceptance run --scenario durable-autonomy-v1` gained a
  long-session gate.** It drives 26 real chat turns through the production
  dispatch and execution path and fails if any turn re-discovers what the
  conversation already established, re-runs a known-failing command, or lets
  carried memory grow unbounded.

### Fixed - a documented check that could not pass

- **`pnpm --filter @morrow/orchestrator smoke:agent-alpha` failed on an
  untouched tree.** It asserted HTTP 200 where the conversation route answers
  201 Created, and reported the failure without a status or body to act on.
  All four orchestrator smokes now pass.

### Fixed - editing a file counts as delivering it

- **A patch-only turn no longer reports finished work as interrupted.** The
  completion contract collected delivered artifacts from a write tool's `path`
  argument, but `propose_patch` names its files only inside the unified diff. So
  editing an existing file — the most common thing an agent does — produced zero
  observed artifacts and blocked with `missing_durable_artifact`, after the patch
  had already applied successfully. Delivered paths are now read from the diff
  headers too, with a `/dev/null` target correctly delivering nothing.

## [0.1.0-beta.47] - 2026-08-15

### Added - NVIDIA NIM and TokenRouter providers

- Added **NVIDIA NIM** as an OpenAI-compatible inference provider, defaulting to
  NVIDIA's hosted endpoint (`https://integrate.api.nvidia.com/v1`) and
  configured with `NVIDIA_API_KEY`. A self-hosted NIM container is reachable by
  pointing `NVIDIA_NIM_BASE_URL` at it. Only the provider-specific
  `NVIDIA_API_KEY` is accepted: `NGC_API_KEY` is an NGC *registry* credential
  used for pulling containers, so honouring it would mark a hosted network
  provider as configured for users who only authenticated a container pull.
- Added **TokenRouter** as an OpenAI-compatible gateway
  (`https://api.tokenrouter.com/v1`), configured with `TOKENROUTER_API_KEY`.
- Both entries follow the catalog's existing honesty constraints: no hardcoded
  model ids (models come from each endpoint's own `/models` response via live
  discovery) and no invented auth. NVIDIA's model list is served without
  authentication, so a connectivity test against it reports the endpoint as
  reachable while stating plainly that the credential itself was not verified,
  rather than implying an invalid key is good.

## [0.1.0-beta.46] - 2026-08-14

### Added - premium terminal mission experience

- Refined the CLI terminal presentation toward a calmer, more premium feel:
  mission-deck rendering, live-work presentation, and app-view composition are
  quieter by default with completed work receding and the active mission kept in
  focus.
- Expanded terminal rendering coverage (new mission-deck suite; 535 terminal
  tests green) so the presentation stays stable across state transitions.

### Fixed - bounded harness convergence

- Replaced unbounded same-target rewrite churn with a durable convergence guard
  that distinguishes exact repeats, operation identity, legitimate edits, new
  artifacts, verification, diagnostics, and application milestones.
- Pauses a stalled task with a visible `loop-stalled` warning and resumable
  checkpoint instead of consuming dozens of provider turns.
- Made `create_file` an explicit atomic whole-file write for existing and new
  regular files, with hash-fenced backups, undo evidence, idempotent replay, and
  no automatic `target_exists` create-to-edit switch.
- Bounded provider fallback attempts and preserved tool-only turns as valid
  responses while retaining explicit incomplete behavior for empty responses.

### Security and privacy impact

- Workspace containment, denied-name checks, approval boundaries, provider
  choice, local persistence, cancellation, browser policy, and process cleanup
  remain enforced. The change adds no telemetry, hosted inference, or new
  external data flow.

### Rollback

- Reinstall `v0.1.0-beta.45` to restore the preceding release. Existing
  projects, conversations, provider configuration, local task records, and
  workspace backups remain data-preserving and schema-compatible.

## [0.1.0-beta.45] - 2026-08-14

### Fixed - chat control recovery

- Approval cards now occupy their own action shelf above the composer, so the
  decision controls remain visible and clickable while a task is waiting.
- The chat composer is now a single calm writing surface: its focus treatment
  no longer creates a second textarea outline, routing reflows before controls
  collide in narrow live-work layouts, and thinking controls recede into a
  quieter utility row.

### Security and privacy impact

- This release changes only chat layout, visual presentation, and truthful
  trusted-workspace copy. It does not expand the approval policy, tools,
  provider requests, credentials, telemetry, or external data flow.

### Rollback

- Reinstall `v0.1.0-beta.44` to restore the prior chat presentation. Projects,
  conversations, provider configuration, and local data remain compatible and
  are not deleted.

## [0.1.0-beta.44] - 2026-08-13

### Changed - premium UI completion

- Home now has a real searchable provider/model picker instead of a static
  route label or native-looking dropdown. The chosen route carries into the
  conversation it creates, and connected providers remain clearly identified.
- Projects, History, Memory, Skills, Connections, and Settings now use the
  same editorial hierarchy, restrained copper accents, compact controls, and
  progressively disclosed detail as onboarding and the conversation surface.
- The conversation composer has a clearer primary action row and a dedicated
  reasoning row. Show thinking now has a larger labelled target on desktop and
  mobile, while the composer remains reachable during long-running work.
- Contrast, keyboard focus, reduced-motion behavior, mobile layouts, console
  health, and horizontal overflow were re-verified across the primary routes.

### Fixed - long build autonomy

- Successful file writes are now projected back to the model as inert durable
  history. Morrow no longer exposes its internal `_morrowAppliedWrite` marker
  as an executable-looking tool call that weaker models can copy without file
  content.
- Short continuation prompts such as "start building" inherit the immediately
  preceding substantive brief, preserving the requested artifact type,
  constraints, browser tools, and completion contract instead of silently
  downgrading the task to read-only work.
- Invented marker-only writes are counted across filenames and hashes. After a
  bounded correction window Morrow interrupts cleanly rather than letting a
  model burn dozens of calls by changing the fake target on every attempt.

### Security and privacy impact

- The harness fix changes provider-facing execution history and malformed-write
  recovery. It does not add a provider, automatic cross-provider handoff,
  network request, telemetry path, permission, or credential flow.
- Completed write bodies remain in the local workspace and durable local task
  records; provider history receives only a bounded statement that the write
  completed. Failed writes retain their original arguments solely for the next
  bounded repair attempt.

### Rollback

- Reinstall `v0.1.0-beta.43` to restore the previous interface and execution
  projection. Projects, conversations, provider configuration, and local data
  remain schema-compatible and are not deleted.

## [0.1.0-beta.43] - 2026-08-13

### Changed - full product visual refresh

- The complete local application now carries the same warm, editorial visual
  language as onboarding: an authored navigation rail, integrated workspace
  and runtime context, ambient copper geometry, refined materials, and
  restrained route-entry motion in light and dark themes.
- Home is now a readiness journey with actionable project and provider states,
  a focused working hero, and calmer recent-work continuity. Fresh installs no
  longer present a disabled primary action as the way forward.
- Conversations now read as a focused working document with a viewport-bound
  transcript, distinct user and Morrow hierarchy, an inspectable activity
  surface, and a premium command field that stays available on short screens.
- Projects, History, Memory, Skills, Connections, Teams, Missions, Pairing, and
  Settings now share one product system instead of separate dashboard-like
  treatments. Dense configuration remains progressively disclosed.
- Mobile navigation, short desktop viewports, reduced-motion behavior, semantic
  route regions, labelled composer forms, focus visibility, and theme contrast
  were hardened as part of rendered browser QA.

### Security and privacy impact

- This release changes presentation and semantic structure only. It adds no
  telemetry, hosted dependency, provider request, credential flow, permission,
  tool capability, or new external data path.
- Existing privacy-preference wording remains explicit that the saved value is
  not runtime routing enforcement. Local workspace and runtime state are shown
  more clearly without exposing credential values.

### Rollback

- Reinstall `v0.1.0-beta.42` to restore the previous product interface and keep
  the premium onboarding. Existing projects, conversations, memory, skills,
  settings, and assistant-profile data remain compatible and are not deleted.

## [0.1.0-beta.42] - 2026-08-12

### Added - premium visual onboarding

- New installs now open into a five-scene, full-screen onboarding journey for
  privacy, personalization, real setup readiness, and launch. The experience
  uses a purpose-made smoked-glass continuity visual, restrained motion, and
  responsive desktop and mobile layouts while preserving a direct skip path.
- Progress resumes from the durable local onboarding state. Provider and
  project readiness come from the existing product APIs, and setup links yield
  to their real destinations before resuming on Home.
- The onboarding dialog traps keyboard focus, exposes clear error recovery,
  and disables decorative movement when reduced motion is requested.

### Added - Morrow learns through ordinary work

- Ordinary agent conversations now capture explicit durable preferences and
  project facts automatically. Temporary chatter, likely secrets, and prompt
  instructions are rejected before persistence; duplicate statements
  consolidate and later corrections supersede the earlier fact.
- Personal memory follows the user across local projects while project,
  conversation, agent, and team memory remains isolated. The Memory page now
  exposes automatic-learning opt-out, provenance, editing, pin/forget/restore,
  permanent deletion, and local export.
- Repeated successful project validation workflows become private learned
  skills after two independently verified uses. A newer verified workflow
  supersedes the older bundle with version and rollback history instead of
  leaving two active conflicting procedures.
- Skills is now a first-class product destination. It shows installed and
  learned procedures, evidence, safety requirements, versions, use counts, and
  improvement history with calm progressive disclosure.
- `Ctrl/Cmd K` opens local global search across conversations, messages, tasks,
  memory, and product destinations. Search spans the user's local projects but
  does not contact an external service.

### Changed

- The primary navigation is now Home, Projects, Skills, Memory, History,
  Connections, and Settings. Missions and Teams remain available to product
  workflows without dominating the default surface; the empty Library
  placeholder and route were removed.
- Chats is presented as History, emphasizing durable continuity rather than a
  transient message list.

### Security and privacy impact

- Onboarding introduces no telemetry or new external service. Its progress and
  assistant-profile choices use the existing local API and remain in Morrow's
  local data boundary.
- Automatic user-memory extraction is deterministic and runs locally. It has no
  model or network call, requires explicit durable language, rejects
  secret-like content and instruction-shaped payloads, and can be disabled with
  a server-enforced setting.
- Only `user_global` memory crosses projects. All other scopes retain their
  project boundary, and the full personal-memory vault is exposed only for
  local inspection and control.
- Automatically learned skills remain workspace-scoped, network-free,
  secret-free, checksum-verified, and evidence-gated before activation.

### Rollback

- Reinstall `v0.1.0-beta.41` to remove the visual onboarding. Existing local
  onboarding and assistant-profile data remains compatible and is not deleted.
- Turn off **Learn useful memory automatically** on the Memory page to stop new
  preference capture. Existing entries remain inspectable and removable.
- Reverting this change restores the prior navigation and skill lifecycle; the
  additive memory rows remain valid SQLite data and do not require migration.

## [0.1.0-beta.41] - 2026-08-12

### Added

- A premium command workspace with persistent reasoning controls and clearer
  visibility into active execution.
- Scoped assistant teams, delegation safeguards, handoff context, and
  security-tested project boundaries.
- Deterministic harness-efficiency evidence and reduced provider/tool-loop
  overhead without weakening completion checks.

### Security and privacy impact

- Team memory, delegation, and assistant context remain project-scoped, while
  provider and tool execution continue to honor explicit permission policy.

## [0.1.0-beta.40] - 2026-08-09

### Added - trusted workspace agents can finish real builds without being babysat

- **Build mode now starts in Trusted workspace by default.** Ordinary structured
  file, directory, browser, package, script, and non-destructive Git actions run
  without an approval stop. A user can still turn Trusted workspace off in the
  chat bar for the older supervised behavior, and that explicit choice persists.
- **Large outputs have a resumable delivery path.** `append_file` writes chunks
  atomically, checks the expected byte offset before every append, records undo
  metadata, and safely accepts files larger than a single model tool call.
  `read_file` pages large files instead of truncating them at 100 KB. Complete
  file replacement no longer rejects legitimate empty content, scratch files,
  or a model's third coherent rewrite.
- **The chat bar has an opt-in Reasoning toggle.** When enabled, each assistant
  response can show reasoning text explicitly supplied by its model provider.
  The browser makes no reasoning request while the toggle is off, and the
  preference remains available while a task is running.
- **Long builds get realistic execution time.** The normal command timeout is
  five minutes and recognized install, build, and test commands can run for up
  to thirty minutes instead of being killed while still making progress.

### Security and privacy impact

- Trusted workspace freedom is bounded to the selected project workspace.
  Privilege escalation, destructive host deletion, force-push/history rewrite,
  credential-bearing or opaque shell payloads, publishing/deployment, purchases,
  and destructive browser interactions still require approval or remain denied.
- The reasoning endpoint returns only a strict provider-supplied text projection.
  It re-applies secret redaction, sends `Cache-Control: no-store`, verifies task
  ownership, skips malformed legacy rows, and never exposes opaque continuation
  state to the browser. It does not manufacture or reveal hidden reasoning that
  the provider did not supply.

### Rollback

- Turn off **Trusted workspace** in the chat bar to restore supervised approvals
  for ordinary actions. Turn off **Reasoning** to stop reasoning requests and
  hide the panel. Reinstall `v0.1.0-beta.39` to roll back the complete release;
  Morrow's installer preserves user data across that replacement.

### Fixed - the beta.39 stdin/CI fix had reached one caller, not the boundary

beta.39 fixed "a command that reads stdin or checks CI can hang the task" in the
agent's tool executor. Three other places in the product still spawned processes
their own way, and none of them inherited it. The class was never fixed; one of
its four callers was.

- **Mission verification commands** ran through a private `spawn(shell, ...)` in
  `mission/evidence-runner.ts` with an open stdin and the orchestrator's whole
  environment — so no `CI`, so watch mode. A `pnpm test` gate consumed its full
  120s timeout and scored `inconclusive`: a mission that had done the work and
  could not prove it. Its timeout then called `child.kill()`, which killed the
  `cmd.exe` wrapper and left the real test process alive holding its ports and
  file locks, breaking the *next* run too. The same file's `git status` diff gate
  had no timeout at all and could wait forever.
- **Background processes** — every dev server Morrow starts — were spawned by
  `ProcessSupervisor` in pipe mode with stdin left open. A server that asks
  anything at startup ("Port 3000 is in use, use another?") waits on an answer
  that cannot arrive, never becomes reachable, and every later health check and
  browser gate reports a working app as broken.
- **Mission checkpointing**'s three `git` calls were synchronous, unbounded, and
  interactive-capable. `spawnSync` blocks the whole event loop, so one stalled
  `git` took every mission, task, and HTTP request in the process with it.

There is now one shell-command boundary, `runShellCommandSafe`, alongside the
existing `runProcessSafe`, and mission verification uses it. Both share one
environment policy, one stdin policy, one process-tree kill, and one settle
path. Two further defects surfaced while proving it: a force-killed tree that
never emitted `close` left the caller pending forever (now bounded by a grace
window), and Node's Windows argument escaping (`\"`) is not the convention
`cmd.exe` parses, so any verification command containing a quoted argument
reached the shell mangled (now passed verbatim).

### Changed - the flagship gate is scored under the budget production uses

`runFlagshipBuild` passed `maxTurns: 24`. A Build Auto on `best-quality` gets
`maxToolIterations: 8`. The gate was measuring a configuration no user can
select; it now takes the budget from the preset, like production does.
### Changed - reliability cycle: bug classes became structural guards

- **Every provider adapter now normalizes the same situations identically, and
  is proven to.** `provider-conformance.test.ts` feeds each adapter canned
  stop / truncation / tool-use / error streams in that adapter's own wire
  format and asserts one shared normalized chunk sequence. Gemini and Codex
  could not report `finishReason` at all, so mission review's truncation retry
  — which fires only on `finishReason === "length"` — was dead on both routes,
  exactly as it had been on Anthropic before beta.37. Both now report it.
  An adapter that is not registered in the table fails the suite rather than
  shipping unchecked.
- **A colliding tool-call id is now a loud failure instead of silent data
  loss.** `message_tool_calls` is keyed globally on the id and its conflicting
  upsert refreshes only lifecycle fields, which made a genuine collision
  indistinguishable from a normal status update — how a per-turn ordinal id in
  the Gemini adapter caused every Gemini conversation after the first to record
  zero tool calls. The store now refuses a write that lands on another task's
  row, and the conformance suite asserts that a minted id differs on every
  stream.
- **One boundary reconciles a request's limits against each other.**
  `provider/limits.ts` owns the couplings that were previously re-derived per
  adapter: extended thinking versus `temperature` and `max_tokens`, and the
  output ceiling versus the request deadline. Raising a token allowance without
  its deadline converts an empty response into a stream timeout; that is now
  arithmetic in one place rather than something each adapter has to remember.
- **Branch divergence is bounded by CI.** A pull request whose merge-base with
  `main` is more than seven days of integration history old now fails
  (`scripts/check-branch-freshness.mjs`). Staleness is measured against
  integration history, not wall-clock time, so a quiet week does not fail every
  open branch. `pnpm branches:inventory` regenerates
  `docs/branch-inventory.md`, which separates the repository's 74 remote
  branches into merged (35), stale (7), aging (24), and active (8).

### Added - the flagship workflow, and the evidence for it

- A single scored workflow — build a small working app from a prompt — that
  runs against real providers (`pnpm flagship:run`) rather than mocks. The app
  is verified against a behavioral contract the harness wrote and the agent
  never sees, so a model cannot pass by writing agreeable tests. Every run,
  pass or fail, is appended to `docs/evidence/flagship-runs.jsonl` with a
  classified failure reason.
- A release gate over that log (`pnpm flagship:gate`): proven means two
  different real providers each passing at least 9 of their most recent 10
  runs. Mock runs never count. It currently reports **unproven**, printed on
  every CI build, because no real-provider runs have been recorded yet.
- ADR 0010 records the decision to freeze new surface for one cycle and turn
  each bug class into a guard.

## [0.1.0-beta.39] - 2026-08-03

### Fixed - a command that checks for CI or reads stdin could hang the task

Reported live: a build ran a test command in a temp project and the task just
stopped. Every command the agent runs goes through one shared executor, and it
had two related gaps. `CI` was silently dropped from the spawned environment
even when set — the executor's allowlist never carried it. And the child
process's stdin was left as Node's default open, unconsumed pipe rather than
closed. A CLI that checks `process.env.CI`, or reads stdin, to decide whether to
run once or wait for interactive input — a bare `jest`/`vitest` invocation, an
`npm test` wired to a runner with watch mode on by default, an install prompt —
saw neither of the two standard non-interactive signals and blocked until the
command's timeout.

Reproduced directly before fixing: a probe that waits on stdin absent `CI` ran
5177ms and was killed by its own 5-second timeout, having printed only that it
was waiting for input. After the fix: 64ms, clean exit, CI path taken.

`CI=true` is now forced into every spawned environment unconditionally, since
Morrow's execution is never interactive regardless of what the caller's own
environment has set. Stdin is now explicitly closed rather than left open, so a
tool that reads stdin directly instead of checking `CI` still gets immediate
EOF.

## [0.1.0-beta.38] - 2026-08-03

### Fixed - runaway loops, checkpoint bloat, and a 30x context cut

This release targets one complaint: Morrow was slow, sometimes looped, and took
a long time to do simple things. The causes were measured from a real packaged
install whose database had reached 259 MB, 206 MB of which was execution
checkpoints, with single tasks recording 300+ provider turns, 800+ tool calls,
270+ compactions, and the same read repeated up to 92 times before the first
file was written.

- **Non-progress is now bounded by an epoch model.** The old six-call sliding
  window could not see interleaved repeats. Only a durable artifact mutation
  starts a new epoch; observations, persisted evidence, and context compaction
  explicitly do not count as progress, which was the loophole that let a task
  feel productive while delivering nothing. One identical observation may run at
  most three times per epoch, and a delivery task with no mutation gets
  action-only recovery at turn 6 and a hard stop or replan at turn 12.
- **Checkpoints are capped at 128 KB** with deterministic truncation and
  hash-tagged elision, instead of copying cumulative raw tool arguments and
  results. Secrets are redacted from checkpoint diagnostics.
- **OpenCode Zen had no catalog entry**, so it fell back to the conservative
  32k context ceiling while serving a 200k model — a 30x cut that forced
  near-constant compaction. It is now declared with its real limit.
- **Model ids are case-insensitive identities.** An id typed in a different case
  resolved as an unknown model with no context window, no pricing, no reasoning
  contract, and a different route fingerprint, so provider continuation was
  never reused. The id sent to the provider is still verbatim.
- **Legacy artifact pagination could not terminate.** Legacy rows carry a
  pre-redaction byte count while reads are redacted; the last page of an
  artifact containing a secret reported more data remaining and handed back an
  offset that returned nothing, so a compliant model paginated forever.
- **SSE and checkpoint writes no longer rescan full task history** on every
  poll.

### Fixed - completion and recovery correctness

- **A mission can no longer go terminal independently of its runtime and worker
  task.** Crash and restart recovery, lease fencing, atomic takeover of stale
  claims, and exactly-once close-out verification.
- **Explicit constraints are enforced at runtime**, not just phrased in a
  prompt. "Backend only", "no database", "no new dependencies", and
  "only edit these files" are checked at planning, tool-execution, and
  completion boundaries, with durable, explicitly authorized waivers.
- **Idempotent retries are no longer rejected.** Operation completion compared
  the redacted persisted result against the caller's raw retry input, so a
  retry whose payload contained a secret looked like a conflicting result.
- **Billing failures are no longer scored as model failures.** A provider that
  refuses before generating (observed as HTTP 402) produced no artifact and was
  recorded as though the model had failed to build the app; ten such runs then
  filled a provider's entire release-gate window.

### Changed

- Read-only and provider-continuation boundaries are guarded as classes across
  the whole tool catalog and every provider protocol.
- Flagship provider eligibility is declared per provider with a stated reason
  for each exclusion, and a guard asserts the table covers the provider registry.

### Still unproven

The flagship release gate still reports **unproven**. It requires two real
providers each passing 9 of their most recent 10 runs, and those runs have not
been completed — the first live canary was blocked by an unfunded provider
account. Everything above is verified by unit and conformance tests, not by a
real-model run. Reliability is improved and measured; it is not yet proven.

## [0.1.0-beta.37] - 2026-08-01

### Added - unified clay UI, interleaved transcript

- Brought the clay-accent Chat/Build web UI (organized conversations, first-run
  setup checklist, context-window meter) together with beta.36's autonomous
  `morrow build` reliability work into one line. Both had diverged for over
  two months and independently touched the orchestrator; migrations, the
  `TaskEvent` schema, and tool-argument normalization were unioned rather than
  picked from one side, so neither line's fixes were lost.
- The conversation transcript now renders as one chronological stream instead
  of a block of tool calls above a block of text: assistant narration is
  folded into a `narration` step per turn and interleaved with the tool steps
  at the point they actually ran, matching Claude Code/Codex-style execution
  logs. Reads and searches are visible steps too, not hidden as noise, so a
  file edit's evidence is inspectable alongside the edit itself.

### Fixed - a reasoning-heavy route could never finish a real build

- A reasoning model bills its hidden chain-of-thought against the same output
  allowance as its visible answer, so a heavy reasoner could spend its entire
  budget thinking and return nothing — every retry reissued the same
  exhausted allowance and failed identically. Verified live against
  OpenCode Zen's deepseek-v4-flash-free, which spent over 15,000 reasoning
  tokens before its first visible token on a single-file task. Each
  empty-response retry now raises the output ceiling and, coupled with it,
  the request deadline — raising tokens alone just traded an empty response
  for a timeout. Proven end to end: the same route went on to write a
  complete, rendering, zero-console-error WebGL2 page.

### Fixed - reliability scan of chat, reasoning, and tool calling

- Selecting a reasoning level on a Claude route failed outright. The model
  registry declared effort control (Low/Medium/High) for `claude-opus-4-8` and
  `claude-sonnet-5`, so `/reasoning` and the `/model` picker's reasoning tab
  listed those levels — but Anthropic routes speak `anthropic-messages`, which
  has no `reasoning_effort` field, so every selection came back
  `400 REASONING_UNSUPPORTED` at send time and no request was ever issued. Both
  models are the top preference of the `best-quality` and `coding` presets.
  They now declare `fixed`, matching `claude-fable-5`, and a new structural
  guard fails if any built-in model ever again advertises a reasoning option
  that its provider's protocol cannot carry.
- Gemini tool calls vanished from the durable transcript. The adapter minted
  tool-call ids from a per-stream ordinal (`gemini-tool-0`), but the transcript
  table keys on that id globally, so the first tool call of every turn — and of
  every other Gemini task — collided with an existing row. The colliding write
  updates only status and result, never the tool name or arguments, so a
  second-turn call was recorded as the first turn's tool with the second turn's
  result, and every Gemini conversation after the first showed an empty tool
  transcript entirely. Each stream now mints a unique id.
- Anthropic never reported why a response ended. `stop_reason` was read off the
  wire for usage accounting but discarded, so `finishReason` was always absent
  on Anthropic. A reasoning model that spent its whole output budget thinking
  and returned no visible answer was indistinguishable from one with nothing to
  say: mission review's truncation retry (which fires only on
  `finishReason === "length"`) could never trigger, and the review diagnostic
  reported "empty response" instead of "response truncated". All Anthropic stop
  reasons are now normalized and reported.
- Enabling Anthropic extended thinking would have been rejected on the wire.
  The API refuses a request that pairs `thinking` with a sampling temperature,
  or whose `max_tokens` does not exceed `budget_tokens` — and the preset
  supplies both without any knowledge of the reasoning mode. The adapter now
  reconciles them where the wire body is built.

## [0.1.0-beta.36] - 2026-07-31

### Fixed - autonomous `morrow build` reliability, and mission closure

- Nine root causes behind unreliable autonomous `morrow build` runs, each with
  regression tests: packaged `morrow build` + `--in` workspace scoping now
  creates and scopes the directory it names; `read_artifact` is authorized
  through the read-only boundary; a route the user pinned no longer falls back
  silently; tool arguments are normalized at exactly one boundary; change
  tracking stays on meaningful source; recovery strategy fingerprints reflect
  real strategy changes, not just a new task id; the launcher no longer adopts
  another install's service on a shared port; machine-wide process kills are
  denied; and requirements the user actually stated in the objective are now
  authoritative criteria instead of being reducible to two generic ones. See
  `docs/decisions/0008-autonomous-build-reliability-boundaries.md`.
- A mission that exhausted automatic recovery previously parked at `blocked`
  with zero evidence and no grade, forever — Guardian, evidence recording, and
  grading all lived behind a path that required an active worker task to reach
  `completed`, which never happened once recovery gave up. The mission now
  runs its verification gates once, records evidence against the criteria they
  prove, and grades honestly before reaching its terminal state.
- Service commands (`npm start` and equivalents) were graded by exit code, and
  a working server does not exit — the check could only ever run out its
  timeout. Service criteria now start the command, discover the URL it
  announces, probe it, and always stop it. Browser criteria render at 1280x800
  and 375x812 and fail on a blank page or a console error. See
  `docs/decisions/0009-mission-closure-and-service-gates.md`, which also
  documents a second, separate give-up path found during live proof that
  remains open.

### Fixed - provider credentials could fail to save entirely, again

- `applyWindowsCredentialAcl` invoked `whoami.exe` and `icacls.exe` by bare
  name, letting PATH decide which binary ran. Git for Windows ships a Unix
  `whoami` and places it ahead of System32, so the SID lookup failed and
  saving any provider key threw "Unable to apply the current-user Windows
  ACL" outright. This was already fixed once (beta.34) and silently lost in a
  later merge; both tools now resolve against `%SystemRoot%` again.
- OpenRouter's pinned-endpoint rejection (`OPENROUTER_ENDPOINT_PINNED`) could
  never actually fire: the generic "this provider has no configurable
  endpoint" check ran first and always won, since OpenRouter has no
  `baseUrlEnv` precisely because its endpoint is pinned. The specific,
  informative message now takes priority.
## [0.1.0-beta.35] - 2026-07-29

Consumer pass over the first hour of using Morrow: the things that made a
working install look broken.

### Fixed - chat could not send at all on a gateway provider

Routing resolved a provider's model from its configured default only.
Discovery-only gateways (OpenCode Zen, and any provider no preset curates)
have no built-in default, and connecting one through the web UI never set
one — so a provider reporting 60 live models routed to nothing. Every send
failed with "opencode-zen is configured but no model is selected. Run
`morrow providers configure ...`", which is not an instruction a web user can
act on. Routing now falls back to the first model the provider advertises.

### Fixed - account pairing could not work outside a packaged install

Redeeming a pairing code and polling entitlement both required
`MORROW_HOSTED_API_URL`, and only the packaged Windows launcher set it. In a
source checkout or desktop run, a valid code from morrowapp.getaxiom.ca came
back as "This install is not configured to reach a hosted Morrow account" —
indistinguishable, to the user, from a bad code. The hosted API URL now has a
real default; the environment variable still overrides it for self-hosters.
This adds no outbound traffic to an unpaired install: the poller returns the
unpaired snapshot before any request when no device token is stored.

### Fixed - the pairing screen was unreachable, and rejected valid codes

`/pair` had no navigation entry, and its only link lived in a banner that
renders nothing when pairing status is "unknown" — the state every paired
install reports whenever the account service is briefly unreachable.
Connections now carries a permanent Morrow account section. The code field
also advertised "XXX-XXX" for a six-character code that has no separator and
passed input through unchanged, so a lowercase or dash-typed code returned
the same error as a wrong one. Codes are now normalised on both sides.

### Fixed - the agent asked what to do instead of doing it

The chat system prompt was written for Build mode and sent verbatim in Ask
mode, instructing a read-only turn to "run test/verification commands using
run_command, and modify files using the file tools" while it held none of
those tools. Asked to list a project's files and summarise its package.json,
it made no tool calls and replied "I need a bit more information... What
would you like to do first?", offering to do the things it had just been
asked. The prompt is now assembled per mode, and both modes are told to act
on a clear request, state assumptions rather than open with a menu, and
complete every part of a multi-part ask.

### Fixed - the model picker buried every usable model

The catalogue rendered in catalogue order, interleaving models from providers
the user has never connected, each one a fully enabled button whose selection
surfaced only as a failed send later. Available models now sort first,
unavailable ones collapse behind a disclosure, and they are disabled with the
reason shown inline. Preset and provider failure messages no longer prescribe
CLI invocations, since they render in the web UI.

### Added - first-run setup on Home

The web app had no onboarding surface: a fresh install landed on an empty
Home with a disabled "New chat" button, and an install with a project but no
connected model got no guidance at all. Home now leads with a checklist of
the real first-run steps, each reading live status from the same endpoints
its destination page uses, retiring itself once the required steps pass.

### Added - context-window usage in the composer

A compact ring showing how much of the route's context window the last turn
used, drawn from figures the orchestrator already computes. It renders
nothing rather than guessing: a provider that reported no usage, or a model
advertising no context window, produces no meter instead of a reassuring 0%.
A count Morrow derived rather than received is labelled estimated.

## [0.1.0-beta.34] - 2026-07-25

### Fixed - provider credentials could fail to save entirely

`applyWindowsCredentialAcl` invoked `whoami.exe` and `icacls.exe` by bare name,
letting PATH choose the binary. Git for Windows ships a Unix `whoami` and places
it ahead of System32, so the SID lookup failed and saving any provider key threw
"Unable to apply the current-user Windows ACL". On an affected machine no API
key could be stored at all. Both tools now resolve against `%SystemRoot%`.

This was also the cause of 17 of the 20 orchestrator test failures previously
carried as pre-existing; the suite now runs 1268 passing.

### Fixed - agent failures that gave no usable reason

- A request containing an image with no vision-capable route reported a context
  size error, so the remedy it implied could never work. It now names the real
  cause and the routes tried.
- The context admission failure named neither route nor size. Because
  compaction has already reduced the request to system, checkpoint, and the most
  recent group, the remaining cause is a single oversized message. The error now
  reports measured tokens against the verified limit per route.
- Reading a workspace file enforced an allowlist of "supported" extensions, so
  ordinary source files were rejected outright: a project containing `.prisma`,
  `.vue`, `.svelte`, `.kt`, or `.tf` could not be read. It is now a denylist of
  binary formats. Workspace containment, credential-name checks, and null-byte
  detection are unchanged.
- A `create_file` call missing `path` was answered with "fix the arguments",
  and the model regenerated the whole file body each time. The correction now
  names the missing argument and says to reuse the content already produced.
- The tool-argument retry limit was advisory: exceeding it only changed the
  instruction text, so a model that ignored it kept going, reaching six attempts
  against a limit of two. Exhaustion now interrupts the task.

### Changed - clay accent, and two composer modes instead of four

The accent moves off indigo to Claude clay: `#d97757` in dark, and `#bb5836` in
light, where the accent carries white text and true clay measures 3.1:1 against
white — below the 4.5:1 the accessibility gate requires.

The composer offered Ask, Plan, Build, and Build Auto, where Build and Build
Auto were the same mode differing only by auto-approval. It now offers Chat and
Build, with approval as its own switch shown only once Morrow can change
something, and a line stating what the current selection will do. The wire
contract is unchanged.

## [0.1.0-beta.33] - 2026-07-25

### Added - the web app can use every provider, and ships in the package

- The web Connections page is now a browsable catalog of all 30 providers,
  grouped by kind and searchable, with subscription-sign-in and free-tier
  badges and a direct link to each provider's key page. It could previously
  configure exactly one provider (OpenRouter) — its API client asserted
  `z.literal("openrouter")` — leaving 29 unreachable from the browser.
- Local servers get a base-URL field and an explicitly optional key.
- The release package bundles the built web app, so `install.ps1` installs the
  CLI, the local service, and the web UI together.

### Fixed - every provider now gets OpenRouter's protections

- Credentials are verified against the provider before being stored, for every
  provider rather than OpenRouter alone. A mistyped key is rejected and the
  working one preserved; previously every other provider stored an invalid key
  and reported "connected". Verified live against Groq, Mistral, Cerebras, xAI,
  and Together.
- Where an endpoint serves its model list without authentication (OpenCode
  Zen), a wrong key cannot honestly be rejected. The credential is saved and
  reported as unverified — `credentialVerified: false` — instead of a bare
  "connected".
- Model discovery runs on save for every provider, so a freshly connected
  provider has selectable models immediately instead of after a manual refresh.
- Local servers can still be configured before they are started; only a
  reachable-but-rejecting endpoint blocks the save.
- Setting a default model or context limit no longer requires a network check,
  so those are savable on an unconnected provider or offline.

### Fixed - the installed web UI was invisible

- The packaged launcher reported only the JSON API root, so a new user read
  "Morrow is ready at http://127.0.0.1:4317", opened it, and got a page of raw
  JSON. The web UI bundled into the same package was never mentioned by
  `start`, `status`, or `help`, and `morrow open` — which already launched it —
  was undiscoverable. All three now show the web app address, and only when a
  web bundle is really present.

### Fixed - release notes described the wrong release

- The release workflow carried its body as a hardcoded string describing
  beta.30, so every release published after beta.30 shipped beta.30's notes.
  The body is now generated from this CHANGELOG's section for the version being
  released, and publication fails if that section is missing.

### Fixed - long-standing test and UI defects

- The six orchestrator test failures recorded as accepted baseline noise were
  both fixture schema drift: a hand-written CREATE TABLE that had fallen behind
  the migrations, and a migration test seeding a pinned-schema database with
  current repositories. The whole monorepo is now green.
- Unknown web addresses rendered an empty shell with no heading and no way
  back; there is now a not-found page.
- The first-run home page reported a missing project while offering no way to
  create one, and never surfaced the missing-provider prompt.

### Added - 30 model providers, guided setup, and one-command project builds

- A data-driven provider catalog adds 22 OpenAI-compatible providers on top of
  the existing 7: OpenCode Zen, Vercel AI Gateway, GitHub Models, xAI, Mistral,
  Moonshot, Z.ai, DashScope, Perplexity, Cohere, Groq, Cerebras, Together,
  Fireworks, DeepInfra, Nebius, Novita, Hyperbolic, SambaNova, and the LM
  Studio, llama.cpp, vLLM, and Jan local servers. The registry, secrets writer,
  and connectivity checker all derive from one table, and a test keeps the four
  surfaces in sync.
- Catalog providers ship no hardcoded model ids. Models come from each
  endpoint's own `/models` response, so Morrow never claims a model exists that
  the endpoint would reject, and guided setup offers exactly the models a
  credential can reach.
- One guided setup flow now backs both `morrow onboard` and `morrow providers
  configure`: browse or search the catalog grouped by kind, sign in with a
  subscription where a real OAuth flow exists, otherwise open the provider's key
  page, then verify and pick a default model. `supportsOAuth` is reported by the
  server, so clients no longer keep a list that drifts from the flows that
  actually work. OpenCode Zen is presented as API-key only, which matches its
  official documentation.
- `morrow build "<what you want>"` creates a new project directory, registers
  it, and builds it end to end through the existing durable mission engine.
  It refuses a directory that already has contents and a workspace root too
  broad to scope autonomy to, so autonomous-by-default is safe here.

### Fixed - first-run setup reported valid API keys as invalid

- `morrow onboard` wrote the secrets file directly from the CLI process and then
  asked the already-running service to validate the key. The service had read
  its environment at startup and never re-read the file, so it validated a
  credential it did not have: a correct, freshly pasted key was reported as
  "Validation failed" to a brand-new user, who was then offered the chance to
  discard it. Credentials now persist through `configureProvider`, which
  hot-applies inside the service that performs the request, and a test asserts
  that ordering.

### Fixed - configured providers that could not be reached

- Presets name a curated `providerOrder`, and routing stopped there, so a user
  whose only configured provider was outside that list got "no configured
  provider" from every preset. Any other configured provider is now appended
  after the preset's own. A local-only preset filters appended providers too,
  so the fallback can never turn a local-only run into a hosted one — and
  local-only now works with LM Studio, llama.cpp, vLLM, and Jan, not Ollama
  alone.
- `preferredModel` returned null whenever a preset had no model preference for a
  provider, treating "no opinion" the same as "recommended models, none
  available". A preset only curates models for the providers it names.
- A routing failure caused by a provider with no model selected said nothing was
  configured, sending users to reconfigure a provider that already worked. It
  now names the provider and the exact command to fix it.

### Fixed - "verified" was claimed for credentials that were never checked

- The provider check is a `GET` on the endpoint's model list, and some
  providers serve that list without authentication. A deliberately invalid
  OpenCode Zen key was reported as verified, telling a user they were ready
  when their first real request would fail. The check now repeats the request
  with the credential removed; if it still succeeds, the endpoint does not
  enforce the key on that route, and the result says "reachable" instead of
  "verified" and explains why. Reported as `credentialVerified` on the provider
  test result.

### Fixed - credential and endpoint handling

- `github-models` no longer reads `GITHUB_TOKEN`. That variable is set in
  nearly every CI runner and dev shell for unrelated reasons, and honouring it
  marked a hosted network provider as configured — and made it eligible for
  routing — for users who never opted in. A test forbids any catalog provider
  from claiming a general-purpose environment variable.
- A key-protected local server (for example `vllm --api-key`) was unreachable
  because local providers dropped their API key. The key now reaches both the
  adapter and the connectivity probe.
- The CLI drove provider configuration from a hardcoded map of 5 ids, leaving
  most providers unconfigurable and omitting Gemini from onboarding entirely.
  It now reads the provider list from the server.
- Onboarding's mission step compared the selected index against hardcoded
  numbers, so reordering an option would silently change which branch ran.
  Options are identified by id.

### Release status - 0.1.0-beta.31 is conditionally ready

Deterministic and packaged acceptance gates (foundation, durable-autonomy,
sustained-autonomy) pass. The remaining certification gate — a completed,
funded, real-external-model Guardian mission run from the packaged product —
has not yet been run. See `docs/ACCEPTANCE.md#release-status-01.0-beta31`.
This release is not stable, final, or fully verified until that gate runs.

### Fixed - the packaged long-run acceptance gate was fabricating its own evidence

- Replaced the packaged `extended-run` scenario, which wrote its own progress,
  recovery, rollover, checkpoint, and Guardian records and then verified them,
  with a genuine `sustained-autonomy` scenario that drives the real
  `MissionControllerRunner`, `TaskRunner`, `executeAgentChatTask`, context
  accountant, recovery planner, startup reconciliation, and Guardian. The only
  scripted boundary is the external model turn. See
  `services/orchestrator/src/acceptance/sustained-autonomy.ts`.

## [0.1.0-beta.31] - 2026-07-16

### Added - durable autonomy and evidence gates

- Durable missions persist their preset, provider, model, and reasoning route;
  replacement workers retain that choice through context rollover and process
  recovery.
- Automatic Cortex memory captures evidence-backed mission learning and recalls
  it on later matching work. Repeated safe workflows can progress from candidate
  to checksum-validated, project-scoped skills and load automatically later.
- Controlled browser tasks can inspect DOM and console state, interact through
  semantic references, and attach verified screenshots to vision-capable model
  turns at desktop, tablet, and mobile viewports.
- The packaged durable acceptance scenario now proves a multi-file repair,
  malformed-tool and failed-command recovery, browser/vision validation,
  automatic memory/skills, model metadata consistency across restart, and five
  controller fault classes driven through the real mission controller.
- Progress is now evidence-backed in production. Agent turns derive progress
  from observed execution deltas — content-addressed artifact fingerprints,
  tool effects, verification outcomes, resolved failures, and checkpoints — and
  persist them to the durable mission ledger. Narration, response length, and
  repeated identical tool results no longer count. A stalled task escalates
  through a focused diagnosis and a controller-owned strategy change, and stops
  only on a precise blocker, replacing the previous three-strike interrupt.

### Fixed - bounded recovery and truthful release behavior

- Non-retryable provider authentication/payment failures no longer create an
  unbounded worker storm. Morrow switches only when the route was left open and
  a configured alternate exists; explicitly pinned providers/models block with
  the precise retry condition.
- `morrow yolo` now reliably selects write mode even when the saved default is
  read-only.
- Model `--all`/`--advanced` flags reach the model-list command after global
  parsing, so diagnostic catalogs are complete and list/detail output remains
  consistent across service restart.
- Packaged Windows browser sessions use installed Microsoft Edge when no browser
  is explicitly selected, avoiding an undeclared runtime download.
- Vision context accounting uses viewport-aware image estimates rather than
  counting base64 bytes as text, and repeated dynamic browser observations are
  preserved as fresh evidence.

## [0.1.0-beta.30] - 2026-07-16

### Added - model and reasoning routing

- **Interactive `/model` picker.** Choose a provider/model from a compact,
  live route picker instead of editing configuration by hand; live status and
  context reporting reflect the actual selection instead of a cached guess.
- **Normalized reasoning control.** Reasoning effort is a single, provider-
  normalized setting that is actually wired through to the outbound provider
  request, replacing the previous per-provider drift.
- **Adaptive-OS orchestrator architecture.** A canonical model-budget
  foundation and architecture map for adaptive orchestration replace ad hoc
  budget handling.

### Fixed - mission and terminal integrity

- Advanced missions continue across context-window limits instead of
  stalling silently.
- Read-only tasks that finish successfully no longer report as interrupted,
  and repeated narration no longer masquerades as a false completion.
- General missing-delivery protection closes gaps where `/output full` and
  related report paths could drop content.
- Terminal events use a single event-identity boundary, closing a recovery
  cross-flow bug.

### Fixed - openai-compatible provider and mission reliability

- **`--url` flag collision.** `morrow providers configure <id> --url <url>`
  no longer silently redirects the CLI's own service-target resolution to
  the provider's endpoint URL.
- **Custom `openai-compatible` models are now visible.** A configured custom
  model previously had zero entries in the built-in model registry and never
  appeared in `/api/models`; it now surfaces correctly.
- **`run_command` no longer crashes on malformed tool-call arguments.** A
  non-array `args` value from a model now produces a clean, retryable tool
  error instead of a raw `args.map is not a function` crash.
- **Mission success criteria no longer invent an impossible JS entry-point
  check.** The heuristic fallback used when no model-drafted criteria are
  available previously assumed every project has an `index.js`/`server.js`
  entry point, even static HTML/CSS projects with no JavaScript at all — an
  unwinnable criterion that could mark an otherwise-flawless mission as
  failed. It now checks the actual workspace before proposing that
  criterion, and omits it when no JS entry point exists.

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

- The beta.26 security diff review completed with 0 reportable findings. Its
  generated scan bundle was removed from the live tree after 0.4.0 repository
  cleanup and remains available in Git history.

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
