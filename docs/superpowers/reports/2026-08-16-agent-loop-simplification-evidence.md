# Agent loop simplification — verification and live evidence

Date: 2026-08-16
Branch: `codex/behavioral-loop-simplification`

## Inherited state

The working tree already contained the provider/context/stream migration and
most of the loop simplification. `agent.ts` had shrunk from 6,877 to 6,213
lines; `execution/progress-epoch.ts` and `execution/convergence-guard.ts` were
deleted; `execution/loop-detector.ts` had been rewritten from a sliding-window
stall detector into task-local exact-call counting whose only output is advisory.

The full orchestrator suite reproduced exactly the reported baseline:
**2,078 passing / 9 failing** across 8 files.

## Failure triage

| Test | Verdict |
| --- | --- |
| `agent-mission-progress` — evidence-backed progress observations | Real regression: nothing wrote the mission progress ledger any more |
| `sustained-autonomy` — `progressObservationCount > 0` | Same regression |
| `mission-failure-ingestion` — malformed patches reach the ledger | Real regression: nothing called the mission failure reporter any more |
| `mission-terminal-outcome-conformance` — repeated failures stay observations | Same regression |
| `free-execution-kernel` — expects a `loop_detected` signal | Stale: loop detection was intentionally deleted and replaced by advisories |
| `agent-beta26-regression` — expects `switchToCreateFile` / `attemptsForFile` | Stale: per-file diff-attempt counting and tool redirection are forced strategy switching |
| `agent-tool-argument-repair` — expects the `_morrowAppliedWrite` system record | Stale: the projection no longer invents a replay marker |
| `agent-tool-argument-repair` — placeholder targets across files | Stale fixture: the mock ran out of scripted turns; the old pass depended on deleted artifact-delivery termination |
| `tool-argument-normalization` — projection keeps arguments intact | Stale: oversized successful write bodies are now bounded to a digest record |

## Completed remediation

### Durable evidence-backed mission progress (observe-only)

`observeTurnProgress()` was restored in `execution/agent.ts` and is called once
per turn. It builds an `ExecutionProgressSnapshot` from workspace artifact
fingerprints, verification outcomes, unresolved failures, and durable checkpoint
ids, diffs it against the previous snapshot with the pure `assessProgress()`,
and appends the deltas to `mission_progress`.

It returns `void`. Nothing branches on it. `assessExhaustion()` — the function
that produced `change_strategy` / `block_precisely` verdicts — has **no**
production caller and must not gain one. `strategyFingerprint` is recorded as
`null`: the ledger no longer carries a strategy identity because nothing
supervises strategy.

### Durable mission tool-failure ledger (observe-only)

`createMissionToolFailureReporter` is constructed once per mission-linked task
and called at the tool terminal boundary: `reportFailure` on failure,
`reportSuccess` on success (which marks the matching bucket recovered). The
reporter's `exhausted` / `terminalEntryKind` return value is deliberately
discarded — it uses the `observe-only` escalation lane, so recording can never
revise, block, or replan the mission. Ledger write failures are swallowed into a
diagnostic event and never break execution.

## Provider/context/stream audit

Four confirmed defects were found and fixed at the existing seam, each with a
red test observed first.

1. **Canonical semantic identity was coupled to route identity.**
   `buildCanonicalProviderRequest` folded the route into `contentHash`, so a
   route switch was indistinguishable from a real context change. Split into
   `contentHash` (model-visible content only) and `requestHash` (content bound
   to one route). `measureProviderRequest` now reports both.

2. **Mutable data survived under the canonical projection.** Messages were
   shallow-copied before hashing and only the top-level object was frozen. The
   projection is now `structuredClone`d before hashing and deep-frozen, so a
   later caller mutation cannot drift it away from an already-recorded hash.

3. **Fragmented tool-call ids could change mid-stream.** A gateway re-sending a
   different id for the same wire index would split one call in two, or leave
   the executed id different from the id already streamed and persisted. An
   index's id is now pinned to the first provider-supplied id; a synthesized
   placeholder may be upgraded exactly once.

4. **Model output was accepted after a terminal finish marker.** A proxy
   concatenating a second response onto one stream could blend its text into the
   answer and get its tool calls executed. Text/tool chunks after a finish
   reason are now dropped, while trailing usage-only markers still merge. The
   OpenAI-compatible adapter was reordered so a record carrying both a content
   delta and `finish_reason` emits its content *before* the finish marker.

5. **Route/deployment restrictions lost to generic catalog metadata.**
   `route-config` (an operator statement about one exact route) ranked *below*
   `provider-catalog` (generic metadata keyed on a model name), so a smaller
   self-hosted deployment of a well-known model name would be handed requests it
   cannot accept. `route-config` now outranks `provider-catalog` and still ranks
   below `provider-reported` / `deployment` / `adapter-native`.

Checked and found already correct: unknown capability state never degrades to
false/unsupported/unlimited; duplicate finish markers; usage ordering and
trailing usage; partial/truncated streams; cancellation; `context_overflow`
classification (non-retryable, routed to bounded compaction); bounded provider
fallback that only retries before the first chunk, so no tool side effect can be
duplicated by a retry.

No provider or model family is branched on in generic execution code. The
remaining model names in `execution/agent.ts` are comments citing the live
evidence that motivated a generic mechanism.

## Deterministic results

Final state, after both the loop-simplification remediation and the tool
ergonomics pass:

| Gate | Result |
| --- | --- |
| `pnpm --filter @morrow/orchestrator check` | pass |
| `pnpm --filter @morrow/orchestrator exec vitest run` | **200 files, 2,120 passed / 5 skipped / 0 failed** |
| `pnpm check` | 10/10 tasks pass; repository validation passed |
| `pnpm test` | 14/14 tasks pass — orchestrator 2,120, cli 803, web 318, contracts 80, hosted-api 15, ui 14, hosted-contracts 10, dashboard 7, hermes-compat 4 |
| `pnpm build` | 9/9 tasks pass |
| `git diff --check` | clean |

(The intermediate figure quoted while triaging was 2,095 across 195 files,
before the ergonomics tests were added.)

## Live UI acceptance

Fixture repository `~/morrow-live-harness`: a committed `index.html` for
"Northwind Coffee" referencing `assets/site.css`, `assets/site.js`,
`assets/logo.svg`, `assets/favicon.svg`, plus nav links to `menu.html` and
`contact.html`. None of those exist. Exact unchanged task:

> Finish this website. Inspect what already exists, fix everything necessary,
> create any missing assets, verify the result actually works, and do not stop
> until the site is complete.

### Run 1 — TokenRouter `qwen/qwen3.8-max-free` (the previously failing route)

Task `59beca1f-307f-41f1-8b01-d177879b2077`. **Blocked upstream, not by Morrow.**

The route returned HTTP 503 `cache_only_cold` — "cache-only admission rejected a
cold or overloaded request" — before any content was streamed. Morrow classified
it as a retryable provider error, made 3 bounded same-route recovery attempts,
then persisted a truthful `task.failed`. No tool ran and the fixture workspace
was left byte-identical.

Direct probes of the same endpoint isolate the cause to the provider, not to
Morrow's request:

| Probe | Result |
| --- | --- |
| non-streaming, no tools | HTTP 200 |
| streaming, no tools | HTTP 200 |
| streaming + one minimal tool | HTTP 503 `cache_only_cold` |
| non-streaming + one minimal tool | HTTP 503 `cache_only_cold` |
| streaming + one minimal tool, 5 consecutive attempts | HTTP 503 every time |

Every request carrying `tools` is rejected, regardless of streaming, prompt
size, or history. An agent task requires tools, so this route cannot currently
run one. The failed run was preserved; no retry was hidden and no prompt was
changed.

### Run 2 — OpenCode Zen `qwen3.6-plus` (the other configured Qwen route)

Task `bfce52d8-748f-4a92-bf3d-8fdf4560f71c`. **Blocked upstream.** The provider
returned "No payment method" for its paid models. Morrow reported the account
error truthfully and stopped. No tool ran.

### Run 3 — DeepSeek `deepseek-v4-flash` (interrupted by operator error)

Task `8659c8c2-6e59-447c-958d-8e1abe62e8e6`. This run was **interrupted by me,
not by Morrow**: `pnpm build` regenerated `packages/contracts/dist/web.js`, the
`tsx watch` dev server restarted the orchestrator mid-flight
(`[tsx] change in ./../../packages/contracts/dist/web.js Restarting...` at
10:43:48), and Morrow recorded `task.interrupted { reason: "restart" }` plus
`task.recovery_required`. That is resumability working correctly. The run is
preserved. Subsequent runs used a non-watching orchestrator
(`pnpm --filter @morrow/orchestrator start`) so nothing could restart it again.

### Run 4 — DeepSeek `deepseek-v4-flash` — **completed**

Task `be8fbc82-55df-4158-84f5-c34c0662e849`. Same fixture, same unchanged task.

| Measure | Value |
| --- | --- |
| Terminal state | `task.completed` |
| Turns | 57 |
| Tool calls | 68 |
| Provider calls | 56 |
| Wall time | 4m 46s |
| Estimated cost | $0.0245 |
| **Interruptions** | **0** |
| **Progress/stagnation/loop/strategy warnings** | **0** |
| Repeat advisories | 1 (`exact_repeat_advisory`, `browser_console` ×3) |
| Bounded provider recoveries | 1 |
| Context compactions | 0 |

Observed shape — exactly the target sequence:

```
load_skill → inspect_workspace → read_file index.html → list_files → git_status → git_log
  → create_file assets/site.css → create_file assets/site.js
  → propose_patch ×3 FAIL (malformed diffs) → propose_patch OK
  → read_file → propose_patch ×2 FAIL → create_file assets/site.css (full rewrite)
  → create_file logo.svg, favicon.svg → create_file menu.html, contact.html
  → propose_patch index.html → create_file README.md
  → run_command (static server) → browser_open/viewport/click/type/select/console/screenshot
  → stop_process → browser_close → git_status → completed
```

The load-bearing observation: the model failed **six** `propose_patch` calls on
the same file and Morrow never intervened. It returned each failure as an
ordinary structured tool result carrying `currentFile.content`, and the model
**chose full-file `create_file` on its own** — the exact recovery the deleted
`switchToCreateFile` advisory used to force. This is the strongest evidence that
the per-file diff-attempt counter was unnecessary supervision.

Two hard-enforcement boundaries fired correctly and were returned to the model
as tool results rather than interruptions:

- `browser_click` → "Material external browser action is outside the approved
  session boundary" (browser session containment).
- `browser_open` initially failed because Playwright's Chromium is not installed
  in this environment; the model diagnosed it and recovered.

Independent post-run verification (a separate static server, not the agent's):

| Path | Status |
| --- | --- |
| `/`, `/index.html`, `/menu.html`, `/contact.html` | 200 |
| `/assets/site.css`, `/assets/site.js`, `/assets/logo.svg`, `/assets/favicon.svg` | 200 |

Every asset `index.html` references now exists and resolves. The site is
complete.

### Run 5 — NVIDIA NIM `z-ai/glm-5.2` — cancelled (route throttled)

Task `4ba1ae3d-562b-4934-bfea-fdb44b22dc82`. The route is rate limited: turn 1
completed two tool calls, then turn 2 hung on a single `provider.request_started`
for over 90 seconds with no bytes. Cancelled at the user's instruction.
Cancellation was clean — `task.cancelled { reason: "user_cancelled" }`, the
in-flight turn recorded as `aborted: true`, no partial write, no leaked process.

### Run 6 — OpenCode Zen `nemotron-3.5-lightning-free` — model-capability failure

Task `a5196a7c-d28f-40e0-a4da-4abe053ff735`. Same fixture, same unchanged task.

| Measure | Value |
| --- | --- |
| Terminal state | cancelled by operator after 3m 21s |
| Turns | 77 |
| Tool calls | 90 (42 × `inspect_workspace`, 13 × `list_files`, 11 × `read_file`) |
| Files produced | `assets/site.css` only |
| Context compactions | 48 |
| **Interruptions** | **0** |
| Repeat advisories | 18 (fired at 3, 4, 8, 12, … up to 40) |

The model made real progress at first — inspected, created `assets/`, wrote
`assets/site.css` — then fell into an `inspect_workspace` → `list_files` →
`read_file` cycle it never escaped. Its 32k context compacted on nearly every
turn, so it kept re-deriving the same state.

Morrow's behavior was correct throughout: every requested tool executed, the
advisory ladder fired (first a plain reminder, then reminders carrying the prior
durable result), and **nothing interrupted the mission**. Two hard boundaries
fired and were returned as ordinary tool results: workspace containment (11
rejections) and "Target is not a file".

This is a model-capability failure, not a harness failure. It is recorded here
unchanged rather than retried.

**It also produced the one genuinely new finding — see Known issues.**

## Generic harness defect found by the live runs

`inspectWorkspace` — which backs `inspect_workspace`, `list_files`,
`search_files`, and `search_text` — rejected any absolute `startPath` with
"Workspace path is outside configured workspace", **including the workspace's
own absolute path**. That message is factually wrong and gives the caller
nothing to correct, and Nemotron re-sent absolute paths eleven times because of
it. The read path already handled the same case correctly with "Absolute paths
are rejected".

Fixed at the existing seam with a red test first: the rejection is unchanged and
still hard, but now says *"Absolute paths are rejected; pass a path relative to
the workspace root (use "." for the root itself)"*, while a genuine escape
(`../escape`) still reports containment. This is provider-neutral tool feedback,
not model supervision.

## Known issues

0. **The `automaticSegmentLimit` finding below still stands**, though run 7
   makes it far less likely to bite: with compaction no longer firing every
   turn, a competent model finishes long before any segment bound would matter.

1. **An unattended task has no default bound when the caller sets no explicit
   budget.** `automaticSegmentLimit` is `null` unless `maxAutomaticSegments` is
   supplied, and the web dispatch path does not supply one. With the behavioral
   guards removed, run 6 showed a pathologically stuck model spinning for 77
   turns / 76 provider calls / 48 compactions with nothing to stop it but
   operator cancellation. The correct fix is an *explicit* default budget on the
   unattended dispatch path — the interrupt and its message
   (`segment_budget_exhausted`) already exist — **not** a new behavioral guard.
   Choosing the number is a product decision and is deliberately left open;
   DeepSeek's successful run used 57 turns and 0 compactions, so any default must
   clear that comfortably.

2. **TokenRouter `qwen/qwen3.8-max-free` cannot run agent tasks** while it
   returns 503 `cache_only_cold` for every request carrying `tools`. The
   originally-requested Qwen acceptance run is therefore still outstanding and
   should be repeated unchanged when that route recovers.

3. **Playwright Chromium is not installed in this environment**, so
   `browser_open` fails on first use and the model must work around it. Run 4
   recovered and completed real browser verification; a fresh environment should
   install the browser first.

4. **The 32,768 context fallback is very conservative** for routes that publish
   no context window (OpenCode Zen, TokenRouter). It is now survivable rather
   than crippling, but a route-reported or operator-configured window still
   produces materially better runs.

5. **Mission-linked telemetry was not exercised live.** All live runs were plain
   conversation tasks with no `missionId`, so the restored progress and failure
   ledgers were verified by the deterministic suite only.

## Tool ergonomics pass (second directive)

Run 6 showed the harness no longer interrupting — but the model still failing,
on tool ergonomics rather than supervision. Five questions were audited.

### 1. Can workspace-contained absolute paths be normalized safely? Yes.

Every filesystem tool blanket-rejected absolute paths *before* any containment
check ran, so `list_files /home/you/project` — the workspace's own root — was
refused. The containment check itself already resolves absolute paths correctly;
the blanket rule was refusing paths it would have accepted.

`normalizeWorkspacePath` (in `workspace/path-boundary.ts`) now performs a purely
lexical normalization at every seam: `validateSafeReadPath` (reads),
`inspectWorkspace` (list/search), `assertContainedRealPath` and
`validatePatchPaths` (writes and `run_command`'s cwd). Nothing about the
security boundary changed — each caller still runs its `realpathSync` +
`isWithinWorkspace` containment, denied-name, and symlink-escape checks on the
normalized result. The redundant `absolute_path` rejection in
`validateToolArguments` was removed because that validator has no workspace root
and therefore cannot tell a contained path from an escaping one.

### 2. Do tool errors say what was wrong and how to fix it? They do now.

`"Workspace path is outside configured workspace"` (for a path that was *inside*
it) became `"Path "/etc" is outside this task's workspace root (/home/you/project).
Pass a path relative to that root, or an absolute path inside it. Example:
"assets/site.css"."` — boundary named, valid spelling shown. Traversal reports
itself as traversal.

### 3. Are the search/list schemas unambiguous? They are now.

`search_files` and `search_text` had near-identical descriptions. They now say
explicitly that one matches **paths/names** and returns paths only, the other
searches **inside file contents**, and each points at the other. `list_files`
says it lists one directory and does not search. `create_file`, `append_file`,
and `create_directory` had **no parameter descriptions at all**; they do now.
`inspect_workspace` states it takes no arguments and that calling it again
returns the same picture.

### 4. Are mutations and failures visible in the next request? Yes — with one real gap found.

`tool-observation-visibility.test.ts` pins that a successful write appears once
as a success naming its target, and a rejection appears with the rule and a
valid example. But the flagship web scenario exposed a genuine defect: a
**background process id reaches the model only inside the one `run_command`
result that started it**, so compaction could drop the model's only handle to a
server it was still responsible for stopping. Live task-owned processes are now
carried in the durable checkpoint — the one message guaranteed to survive
compaction — keyed as `processId` to match the `stop_process` argument exactly.

### 5. Why did "Progress warning recorded" appear constantly?

Because `task.progress_warning` had become a mixed channel and the Activity
projection rendered *every* reason with that one alarming label. Most of those
events are observe-only telemetry that controls nothing. Now:
`execution_policy_observed` and `mission_ledger_write_failed` are not shown at
all; `exact_repeat_advisory` renders as *"Repeat noted for the model"* with what
actually happened; `empty_provider_response` renders as a provider retry; any
other reason still surfaces as "Recovery evaluated". No warning is silently
swallowed.

## The defect that was actually causing the loop

Fixing paths removed every rejection, but the rerun still looped — and the
budget events showed why. Tool schemas were charged **one token per byte**:

| | value |
| --- | ---: |
| Tool schema JSON | 11,012 bytes |
| Realistic tokens (~3.7 B/token) | ~2,976 |
| Tokens Morrow reserved | **12,664** (4.3×) |
| Compaction threshold on the 32,768 fallback route | 22,003 |

The schemas alone consumed more than half the threshold before any conversation
existed, so the route compacted **on every single turn** — the model never
retained its own prior observations and re-derived the same state forever. The
reserve meant to protect the context budget was silently destroying it.

`conservativeSchemaTokens` now assumes 3 bytes/token for Morrow-authored schema
JSON (the caller still adds the standard 15% margin, leaving ~40% headroom over
the true cost). The one-token-per-byte bound is retained for genuinely opaque
payloads — provider continuation blobs and image metadata — where it belongs.

### Run 7 — `nemotron-3.5-lightning-free`, same model, same unchanged prompt — **completed**

Task `42cb66dc-72db-444d-b98c-388970918dec`, fixture reset to the original two
files. Same model that previously ran 77 turns without finishing.

| Measure | Run 6 (before) | Run 7 (after) |
| --- | ---: | ---: |
| Terminal state | cancelled, looping | **completed** |
| Turns | 77 | 33 |
| Tool calls | 90 | 32 |
| Context compactions | 48 | **0** |
| Repeat advisories | 18 | **0** |
| Workspace-path rejections | 11 | **0** |
| Files produced | `assets/site.css` only | all 7 |
| Wall time | 3m 21s (no result) | 2m 3s |

Observed shape:

```
inspect_workspace → list_files → read_file index.html
  → list_files assets FAILS (ENOENT — it does not exist yet)
  → search_files → create_directory assets
  → create_file site.css, site.js, menu.html, contact.html, logo.svg, favicon.svg
  → propose_patch site.js
  → run_command node -e … FAILS (exit 1)
  → create_file server.js  ← self-corrected to a real server
  → run_command node server.js → read_process_output
  → browser_open → snapshot → click (stale ref, failed) → console → screenshot
  → browser_viewport ×2 + screenshots
  → stop_process → browser_close → completed
```

Three tool calls failed (a genuine ENOENT, a bad one-liner, a stale element
ref). The model recovered from each without any harness intervention. Zero
warnings, zero interruptions, zero advisories.

Independent post-run verification on a separate static server: `/`,
`/index.html`, `/menu.html`, `/contact.html`, `/assets/site.css`,
`/assets/site.js`, `/assets/logo.svg`, `/assets/favicon.svg` all return 200. No
server process was left running.

## Rollback

Every change is confined to the working tree on
`codex/behavioral-loop-simplification`. The remediation in this session touches
`services/orchestrator/src/execution/agent.ts` (telemetry restoration),
`execution/canonical-request.ts`, `execution/context-budget.ts`,
`provider/stream-normalizer.ts`, `provider/openai-compatible.ts`,
`provider/model-capabilities.ts`, and `workspace/inspector.ts`, plus the tests
named above. Reverting those files restores the inherited baseline without
touching the provider/context/stream migration.

