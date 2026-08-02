# Handoff — make Morrow a wheel level better

Branch: `claude/morrow-mass-bug-scan-9jutuw`, 44 commits ahead of `origin/main`
(`e054498`). Released as `v0.1.0-beta.37`.

**This branch is not merged to main.** Everything below assumes it lands first;
until it does, `main` still carries the purple UI, the beta.36 orchestrator, and
all four defects fixed in `4ad8639`.

## The strategic call this handoff encodes

Morrow's problem is not missing features. It is that the surface it already has
(30 providers, missions, presets, 5 modes, a UI rewrite) is larger than the part
it has proven correct. Every release for ~37 betas has been "N root causes
fixed" — a product still finding foundational bugs, not refining a stable base.

So: **freeze new surface for one cycle.** Spend it making one sentence
undeniably true — *give Morrow a real task and it finishes correctly, every
time* — and turn each bug class into a guard so it cannot come back. "30
providers" is plumbing, not a pitch. Reliability is the pitch.

Ordered by leverage. Do not reorder — 2 unblocks 1's durability, and 3 is
meaningless before 1.

---

## 1. Turn today's bug classes into structural guards

Four defects shipped and went unnoticed (`4ad8639`). Only ONE is now guarded.
The rest were fixed as instances, so the class is still open.

Precedent to copy: `services/orchestrator/test/reasoning-capability-consistency.test.ts`.
It doesn't test a model — it asserts that *for every built-in model*, every
reasoning option the picker would offer is one the adapter's protocol can
actually carry, and it fails coverage if a new provider appears without being
declared. That is the shape every guard below should take.

### 1a. Adapter parity — CONFIRMED STILL BROKEN

`finishReason` occurrences per adapter, measured on this branch:

| Adapter | finishReason | Notes |
|---|---|---|
| `anthropic.ts` | 5 | fixed in `4ad8639` |
| `openai-compatible.ts` | 1 | already had it |
| `gemini.ts` | **0** | still silent |
| `codex.ts` | **0** | still silent |

I fixed the instance, not the class. Gemini and Codex still cannot report
truncation, so `mission/completion.ts`'s review-retry (fires only on
`finishReason === "length"`) is dead on those routes exactly as it was on
Anthropic.

**Do:** a table-driven conformance suite every adapter must pass — feeds each a
canned truncation/stop/tool_use/error stream and asserts the normalized
`ProviderChunk` sequence. Adding a new adapter without registering it fails the
suite.

**Done when:** all four adapters pass identical conformance cases, and deleting
`finishReason` from any adapter turns a test red.

### 1b. Provider-minted identity uniqueness

`gemini.ts` is the only adapter that mints its own tool-call ids (Gemini's wire
format carries none). The per-turn ordinal `gemini-tool-0` collided in the
globally-keyed `message_tool_calls` table, and because the conflicting upsert
refreshes only status/result — never tool name or arguments — **every Gemini
conversation after the first recorded zero tool calls.** Fixed in `4ad8639`
with a per-stream nonce; nothing prevents the next adapter repeating it.

**Do:** assert in the conformance suite that N streams produce N×M distinct
tool-call ids. Consider making `upsertToolCall` reject a write whose `task_id`
doesn't match the existing row rather than silently updating it — that would
have turned this into a loud failure instead of silent data loss.

### 1c. Coupled limits

Two independent instances of the same class, both live:

- Anthropic `thinking` + `temperature` + `max_tokens` (fixed `4ad8639`)
- output budget + request timeout (fixed `9330496`) — raising tokens alone
  converted an empty response into a timeout, which is exactly what happened
  between run 1 and run 2 of the ocean-sim proof

**Do:** one place that validates a wire request's limits are mutually
consistent before it leaves, rather than each adapter remembering.

### 1d. Cross-branch symbol collisions

The `consumer-polish`/`main` merge produced ONE overloaded `normalizeToolArguments`
from two unrelated functions that happened to share a name — silently, with no
conflict marker. Caught only because `tsc` complained. A rename would have
hidden it entirely.

**Do:** treat this as a merge-discipline problem (item 2), not a lint rule.

---

## 2. Kill the branch divergence

`consumer-polish` and `main` diverged **2026-07-25 → 2026-07-31**, reaching 88
and 70 commits, both editing orchestrator internals, reconciled only on
2026-08-01. That divergence directly produced 1d, and produced the beta.36 note
*"already fixed once (beta.34) and silently lost in a later merge."*

Also: `AGENTS.md` says "do not let the same agent author, approve, and merge a
security-sensitive change." The observed pattern is rotating AI agents shipping
in parallel with no integration step. The rule exists; nothing enforces it.

**Do:**
- Merge this branch to `main` now. Do not start item 3 with two live lines.
- One integration branch. Any branch >1 week or touching
  `services/orchestrator/src/{execution,provider,web}` rebases onto it daily.
- Delete or explicitly archive the ~70 stale remote branches; several are
  months old and it is not currently possible to tell which are live.
- CI check: fail a PR whose merge-base with the integration branch is older
  than N days.

---

## 3. One flagship workflow, proven against real models

The suite is 2659 tests and **mock-only**. It proves the harness is
self-consistent; it proves nothing about behavior against a real model. Every
defect in item 1 passed a green suite.

Evidence this matters — the first real model pointed at Morrow
(OpenCode Zen / `deepseek-v4-flash-free`) hit a wall the suite could never see:

| Run | Result |
|---|---|
| 1 | 3 retries, `outputTokens` == 4096 reserve every time, zero visible content → `interrupted` |
| 2 | budget raised alone → `provider stream timed out` |
| 3 | budget + timeout coupled → wrote a rendering, zero-console-error WebGL2 page |

Measured directly: **15,565 reasoning tokens before the first visible token**,
18,900 total, 146s. A static 4096 cap could never have worked, and no mock
would have told us.

**Do:** pick ONE workflow — "build a small working app from a prompt" — and
make it boringly reliable across 2–3 real frontier models. Run it repeatedly,
record pass/fail with the failure reason, and treat the pass rate as the
release gate. `sustained-autonomy.ts` is the right harness shape; it needs a
real-provider mode and a results log.

**Known open failure to start from:** the ocean-sim run wrote a correct file,
then wandered onto `read_process_output` until the stall detector interrupted
it at 3 turns. Morrow behaved correctly; the task still ended `interrupted`
rather than `completed`. Two candidate fixes, in order:
1. Try `deepseek-v4-pro` on the same key — is this just a weak free model?
2. If it reproduces on a strong model, tighten the finish criteria so a
   verified artifact closes the task instead of inviting more turns.

**Done when:** the flagship workflow passes ≥9/10 consecutive runs on two
different real providers, with the log committed as evidence.

---

## 4. Distribution — only after 1–3

Windows-only, **unsigned** (SmartScreen warns), Linux via source build, macOS
"planned". An unsigned binary is the worst possible ask of the
security-conscious user a privacy-first pitch attracts, and macOS absence
excludes most of the target developer audience.

Deliberately last: signing and porting a product that doesn't yet finish tasks
reliably just distributes the unreliability wider.

---

## What NOT to do this cycle

- No new providers. 30 is already more than is proven.
- No new modes/surfaces. Memory stays "SOON".
- Don't start the persistent-agents / scheduling / MCP roadmap. Those are the
  differentiation bet, and they are worth nothing on an unreliable base.

## State on arrival

- `pnpm check` (10 packages), `pnpm test` (14 packages, **2659 pass**, 11
  skipped, 0 fail), `pnpm build --force`, 42/42 repository guards — all green
- Release pipeline verified working end to end (run `30718797344`)
- Live provider config used for the proof: `OPENCODE_ZEN_API_KEY` +
  `OPENCODE_ZEN_MODEL=deepseek-v4-flash-free`. **That key was pasted in chat and
  should be rotated.**

## Commits on this branch

| Commit | What |
|---|---|
| `4ad8639` | Three provider defects: Claude reasoning selection 400'd on every level; Gemini tool-call ids collided globally; Anthropic never reported `stop_reason`. Plus the Anthropic thinking/temperature/max_tokens coupling |
| `8dbed23` | Merge of the clay Chat/Build UI with the beta.36 reliability line; migrations, `TaskEvent` enum, and tool normalization unioned, not picked |
| `34fb0ec` | Interleaved transcript — narration folded per turn and ordered with tool steps; reads/searches made visible |
| `9330496` | Empty-response recovery raises output ceiling AND request deadline together |
| `6ddee7c` | Release prep for 0.1.0-beta.37 |
