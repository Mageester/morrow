# ADR 0010: Reliability Before Surface — Guard the Class, Not the Instance

- **Status:** Accepted
- **Date:** 2026-08-02

## Context

Morrow's problem is not missing features. The surface it already has — 30
providers, missions, presets, five modes, a rewritten web UI — is larger than
the part it has proven correct. Roughly thirty-seven consecutive betas have
shipped under some version of the release note "N root causes fixed." That is
the signature of a product still finding foundational bugs, not one refining a
stable base.

Four provider defects shipped and went unnoticed until beta.37:

1. Claude reasoning selection returned 400 on every level, because the registry
   advertised a control the `anthropic-messages` protocol cannot carry.
2. Gemini tool-call ids collided in a globally-keyed table, so every Gemini
   conversation after the first recorded zero tool calls.
3. Anthropic never reported `stop_reason`, so mission review's truncation retry
   was dead on that route.
4. Enabling Anthropic extended thinking conflicted with the `temperature` and
   `max_tokens` the preset had already set.

Only the first was fixed as a class. `reasoning-capability-consistency.test.ts`
does not test a model — it asserts that for *every* built-in model, every option
the picker offers is one the adapter's protocol can actually carry, and it fails
coverage when a new provider appears undeclared. The other three were fixed as
instances, and the classes stayed open: `gemini.ts` and `codex.ts` still could
not report truncation at all, and nothing prevented the next adapter from
minting colliding ids or forgetting a limit coupling.

Two further facts frame the decision:

- A 2,659-test suite, entirely mock-only, was green through all four defects. It
  proves the harness is self-consistent. It says nothing about behavior against
  a real model.
- `morrow/consumer-polish` and `main` diverged for a week at 88 and 70 commits,
  both editing orchestrator internals. Reconciling them silently unified two
  unrelated functions that happened to share a name — with no conflict marker,
  caught only because `tsc` complained — and separately dropped a fix that had
  already shipped once in beta.34.

## Decision

**Freeze new surface for one cycle** and spend it making one sentence
undeniably true: *give Morrow a real task and it finishes correctly, every
time.* Specifically:

1. **Every bug class becomes a structural guard, in the shape of the reasoning
   consistency test.** A guard that names one model, one adapter, or one field
   is not a guard; it is a regression test for an instance. A guard must fail
   when a *new* participant enters the product without being declared.

   - `provider-conformance.test.ts` feeds every adapter canned
     stop/truncation/tool-use/error streams in that adapter's own wire format
     and asserts one identical normalized `ProviderChunk` sequence. An adapter
     that cannot report truncation fails the case its peers pass. An adapter
     that is not registered fails the coverage assertion.
   - Tool-call identity is asserted for all adapters by one rule with no
     per-adapter opt-in: an id either appears verbatim in the wire the adapter
     was fed, or the adapter minted it and it must differ on every stream.
   - `upsertToolCall` refuses a write landing on another task's row instead of
     silently updating it, so a colliding id is a loud failure rather than
     silent data loss.
   - `provider/limits.ts` is the single boundary where a request's limits are
     reconciled against each other. Adapters state what their protocol requires;
     they do not each re-derive the arithmetic.

2. **One integration branch, with a bounded divergence window.** `main` is it.
   A pull request whose merge-base is more than seven days of integration
   history old fails CI (`scripts/check-branch-freshness.mjs`). Staleness is
   measured against integration history rather than wall-clock time, so a quiet
   week does not fail every open branch.

3. **One flagship workflow, proven against real models, with the pass rate as
   the release gate.** "Build a small working app from a prompt", scored by a
   contract the harness wrote and the agent never sees, run repeatedly, with
   every run — pass or fail, with a classified failure reason — appended to
   `docs/evidence/flagship-runs.jsonl`. Proven means two different real
   providers each pass at least 9 of their most recent 10 runs.

4. **Distribution comes last.** Signing and porting a product that does not yet
   finish tasks reliably only distributes the unreliability wider.

Explicitly out of scope for this cycle: new providers, new modes or surfaces,
memory, and the persistent-agents / scheduling / MCP roadmap. Those are the
differentiation bet and are worth nothing on an unreliable base.

## Consequences

- Adding a provider adapter now costs more: it must be registered in the
  conformance table and pass every case, or explicitly excused with a stated
  reason. This is the intended cost. "30 providers" is plumbing, not a pitch.
- A limit coupling discovered in future is fixed once, in `provider/limits.ts`,
  rather than in each adapter that happens to remember it.
- Long-lived parallel branches become a CI failure rather than a merge-day
  surprise. Agents working in parallel on `services/orchestrator/src/{execution,
  provider,web}` must land sequentially.
- The release gate reads "unproven" until real-model runs exist. That is the
  honest verdict, and it is printed on every build rather than being silently
  true. It is reported, not enforced, until the first two providers clear the
  bar — enforcing an evidence requirement nobody has had the opportunity to
  satisfy would only block releases without improving anything.
- A mock run can never satisfy the gate. The mock suite has been green through
  every defect this ADR exists to prevent.
