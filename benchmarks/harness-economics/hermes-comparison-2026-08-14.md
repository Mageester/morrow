# Morrow vs. Hermes — fixed per-request overhead comparison

Date: 2026-08-14
Evidence class: offline, no live provider call, $0.00 spend.

## Method

This is not a paired live task run (no API credentials were used and no
superiority claim about task success is made). It compares each product's
own official, offline measurement of the fixed cost every request pays
before the user's actual message is considered:

- Morrow: `benchmarks/harness-economics/deterministic.ts`, which runs the
  real `executeAgentChatTask` execution path against an in-process fixture
  provider and Morrow's own `measureProviderRequest` token counter
  (`services/orchestrator/src/execution/context-budget.ts:196`).
- Hermes: its own built-in `hermes prompt-size --json` diagnostic
  ("Report the fixed prompt budget for a fresh session ... Runs offline (no
  API call)"), Hermes Agent v0.18.2 (2026.7.7.2), installed locally.

Hermes reports byte/char counts, not a token count. Token figures below are
estimated at 4 bytes/token (a standard rough English/JSON heuristic) and are
explicitly marked as estimates. Morrow's figures are exact counts from its
own tokenizer-aligned request measurement, not an estimate.

Hermes' default CLI toolset (30 tools) is a broader personal-assistant
surface than Morrow's coding-agent catalog — it includes image generation,
text-to-speech, video analysis, Spotify, and Home Assistant integrations that
Morrow does not have at all. That is a real product-scope difference, not a
harness inefficiency, and is called out rather than hidden.

## Raw evidence

Hermes (`hermes prompt-size --json`, platform=cli, model=big-pickle):

| Component | Bytes | Est. tokens (÷4) |
| --- | ---: | ---: |
| Tool schemas (30 tools) | 51,229 | ~12,807 |
| System prompt (identity/guidance) | 38,186 | ~9,547 |
| **Fixed floor before any user message** | **89,415** | **~22,354** |

Morrow (`deterministic.ts`, corrected run, exact token counts):

| Scenario | Classification (after this pass's fix) | Total request tokens |
| --- | --- | ---: |
| simple-answer (ambiguous prompt, ≤1 call) | full_agent (no keyword match, conservative fallback) | 12,945 |
| duplicate-read-dedup (search-classified, 3 calls) | read-only-workspace | 18,507 total / ~6,169 avg per call |
| failed-tool-recovery (read-classified, 3 calls) | read-only-workspace | 18,290 total / ~6,097 avg per call |
| multi-file-edit / new-file-creation / mutation-verification (create/edit-classified) | coding | 39,017–39,132 (unchanged — see limitation below) |

## Result

Even in Morrow's *worst case* (an ambiguous prompt that conservatively keeps
the complete tool catalog), its full per-request envelope — protocol
overhead, system instructions, and tool schemas combined — is ~12.9k tokens,
about 42% smaller than Hermes' tool-schema estimate alone (~12.8k tokens),
before Hermes' ~9.5k-token system prompt is even added. Hermes' estimated
fixed floor (~22.4k tokens) is roughly 1.7x Morrow's full unscoped envelope,
and roughly 3.6x Morrow's new capability-scoped read-only average (~6.1k
tokens/call).

## Limitations (stated plainly)

- Byte→token conversion for Hermes is an estimate, not an exact count; the
  two products may use different tokenizers for their target models.
- This is fixed-overhead-only. It says nothing about task success rate,
  wall-clock time, or live provider cost, and is not a substitute for a
  paired live task benchmark.
- Hermes' 30-tool surface includes non-coding assistant capabilities Morrow
  doesn't implement; a stricter apples-to-apples comparison would disable
  Hermes' non-coding toolsets first.
- A live, paired black-box task set (same prompts, same success criteria,
  real provider calls on both sides) remains the rigorous next step and was
  out of scope for this offline pass.
