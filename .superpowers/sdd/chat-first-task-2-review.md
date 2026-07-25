# Chat-first Task 2 independent review

Range: `1430cc3..6c78f8b`

## Round 1 — Needs fixes

- **Critical:** `GET /models` was public and could not authenticate candidate keys. Fixed by using exact pinned `GET https://openrouter.ai/api/v1/models/user` and requiring its account catalogue schema.
- **Critical:** mutable OpenRouter base URL could send an existing stored Bearer key to an attacker-controlled host. Fixed by hard-pinning validation and chat traffic to the official HTTPS endpoint and rejecting overrides.
- **Important:** in-flight refresh could bind old results to a new credential identity. Fixed with one environment/identity snapshot and conflict discard.
- **Important:** expired discovery still advertised availability. Fixed by retaining stale catalogue context while reporting unavailable until authenticated refresh succeeds.
- **Important:** non-token charges could be misclassified as free. Fixed with comprehensive, unknown-safe pricing normalization.

## Round 2 — Needs fixes

- **Important:** capability metadata still advertised custom endpoints after the runtime was hard-pinned. Fixed with `customEndpoint: false` and a provider-status regression.
- **Important:** blank/whitespace pricing strings converted to zero and could be labeled free. Fixed by rejecting blank numeric strings and testing `unknown` classification.
- Documentation corrected from public `/models` to authenticated `/models/user`.

## Final verdict — Approved

- Spec compliance: **approved**.
- Task quality: **approved**.
- Critical findings: **0 open**.
- Important findings: **0 open**.
- Minor: the OpenAI-compatible parser remains line-oriented and does not fully frame unusual multi-line SSE `data:` events. Track for later hardening; reviewer judged it bounded and non-blocking for Task 2.
- External release gate: sanitized real-key OpenRouter catalogue/chat verification remains Task 14 work.
