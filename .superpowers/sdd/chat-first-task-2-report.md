# Chat-first Task 2 report — OpenRouter provider backend

## Status

DONE_WITH_CONCERNS

Implementation, documentation, migration, focused tests, full tests, checks,
builds, leak scans, Windows ACL smoke, and a focused commit are complete. No
push was performed. Independent security review and a live-key OpenRouter check
remain release gates because this change touches credentials and external model
traffic.

## Root-cause and interface findings

- OpenRouter already shared the provider registry and OpenAI-compatible adapter,
  but key presence was reported as configured before authentication.
- Configure mutated the live environment and plaintext compatibility file before
  any provider validation, so a rejected replacement could displace a known-good
  credential.
- Model discovery discarded OpenRouter author, modalities, supported parameters,
  pricing, free/paid state, per-model availability, and freshness.
- Discovery health was keyed only by provider/auth mode. Without a one-way
  credential identity, a changed key could inherit a fresh success produced by a
  different credential.
- Discovery had a fetch time but no bounded expiry or durable last-success time;
  failed refreshes replaced useful catalogue state.
- The OpenAI-compatible stream parser ignored OpenRouter's structured mid-stream
  errors and silently accepted an interrupted stream.
- The Windows secrets path explicitly relied on POSIX chmod, which does not
  establish a Windows owner boundary.

The implementation retains the existing registry, credential file, discovery
repository, server routes, and OpenAI-compatible adapter. It does not create a
parallel provider system.

## Files changed

- Contracts: `packages/contracts/src/index.ts`,
  `packages/contracts/test/contracts.test.ts`.
- Provider/runtime: `services/orchestrator/src/provider/connectivity.ts`,
  `openai-compatible.ts`, `registry.ts`, `secrets.ts`.
- Catalogue/persistence: `services/orchestrator/src/repositories/provider-model-discovery.ts`,
  `services/orchestrator/src/routing/models.ts`,
  `services/orchestrator/src/database.ts`, `services/orchestrator/src/server.ts`.
- Tests: provider connectivity/configure/discovery/stream/server/routing/vision
  suites plus database and migration assertions.
- Documentation: `docs/providers.md`, `docs/privacy-model.md`.

Controller-owned `.superpowers/sdd/task-2-brief.md`, the old tracked
`task-2-report.md`, and generated `output/` were not staged or committed.

## Behavior delivered

- OpenRouter uses `https://openrouter.ai/api/v1`, Bearer authentication, official
  OpenAI-compatible chat streaming, and the existing registry.
- Candidate OpenRouter configuration is authenticated before persistence or live
  promotion. Failed replacement validation leaves both disk and process state on
  the last known-good value and returns only a normalized error.
- Provider configured/available truth requires a successful authenticated model
  request bound to the exact credential's SHA-256 identity. The key itself is
  never persisted in SQLite.
- Live catalogue normalization includes ID/name, provider author, input/output
  modalities, context/output limits, tool and reasoning signals, pricing in USD
  per million tokens, free/paid state, availability, and fetch time. Duplicate
  and malformed records are bounded and rejected without a handwritten source
  list becoming authoritative.
- Successful discovery uses a 15-minute TTL; failures use a one-minute retry TTL,
  retain the last successful catalogue, and mark current provider health
  unavailable. Explicit `POST /api/providers/:id/models/refresh` bypasses the
  startup TTL.
- A selected model that disappears remains selected and is surfaced unavailable;
  Morrow does not silently switch to another model.
- OpenRouter SSE processing comments are ignored. Structured stream errors,
  fragmented text/tool arguments, `[DONE]`, cancellation, malformed trailing
  chunks, interruptions, HTTP/provider errors, and duplicate model boundaries
  are covered.
- Credential writes are atomic. Windows uses current-user plus LocalSystem ACLs
  via fixed-argument `whoami.exe`/`icacls.exe` calls and fails closed if the ACL
  cannot be applied; Unix-like platforms use mode `0600`. Existing `secrets.env`
  loading remains compatible. Rollback behavior is documented.

## Migration

- Migration 38, `provider_model_discovery_freshness`, adds:
  - `expires_at`
  - `last_success_at`
  - `credential_identity`
- Existing successful rows receive `last_success_at=fetched_at`; legacy rows have
  an expired default and must be revalidated before OpenRouter is connected.

## TDD evidence

Every production slice began with an observed focused failure:

- Contract test rejected author/modalities/reasoning/pricing/cost/availability/fetch time.
- Connectivity tests failed rich normalization, deduplication, and exact-key redaction.
- Repository/database tests failed missing TTL, last-success, and migration columns.
- Streaming tests failed structured OpenRouter errors and interrupted streams.
- Configure/server tests failed authenticate-before-persist, replacement retention,
  truthful status, manual refresh, stale selection, and Windows ACL protection.
- Routing test failed live metadata override for a known bundled model.
- Credential-identity regression proved a changed key inherited prior cached health,
  then passed after one-way identity binding.

## Verification

- `pnpm.cmd --filter @morrow/contracts test`
  - PASS: 5 files, 40 tests.
- `pnpm.cmd --filter @morrow/orchestrator exec vitest run --maxWorkers=1`
  - PASS: 125 files, 1,184 tests; 278.17 seconds.
- Focused regression command covering migration, vision, connectivity, configure,
  discovery, streams, server routes, database, and routing:
  - PASS: 9 files, 108 tests.
- Post-audit credential-identity/configure/routing regression:
  - PASS: 5 files, 60 tests.
- `pnpm.cmd --filter @morrow/contracts check`
  - PASS.
- `pnpm.cmd --filter @morrow/orchestrator check`
  - PASS.
- `pnpm.cmd --filter @morrow/contracts build`
  - PASS.
- `pnpm.cmd --filter @morrow/orchestrator build`
  - PASS.
- Windows-local ACL smoke using a temporary synthetic secrets file:
  - PASS: `securePermissions=true`, `credentialProtection=windows-user-acl`;
    temporary directory removed.
- Visual inspection of generated Connections screenshot:
  - PASS for current scope: OpenRouter and all remote providers display
    `Not connected`; no credential value is visible. No frontend files changed.

One interrupted full-suite wrapper lost its output pipe. Its worker exited, the
orphaned parent command line was verified as this worktree's Vitest process, and
only that PID was terminated. The complete suite was then rerun successfully as
reported above. The unrelated running orchestrator process was not touched.

## Security and redaction evidence

- `git diff --check`: PASS.
- Live environment credential-value scan against the exact Task 2 diff: PASS,
  zero matches; values were never printed.
- Private-key/cloud-token pattern scan against the diff: PASS, zero matches.
- API and connectivity tests assert candidate/known-good keys are absent from
  responses and normalized failures.
- Discovery database stores only model metadata, health/freshness, and a one-way
  SHA-256 credential identity; it never stores provider key values.
- No secret values appear in logs, SSE chunks, browser payloads, screenshots,
  report content, or the commit.

## Self-review

- Confirmed the implementation reuses the existing provider registry,
  credential mapping, model discovery repository, and stream adapter.
- Confirmed OpenRouter discovery, validation, and chat are pinned to the official
  HTTPS API and candidate credentials do not mutate process state before
  authentication.
- Confirmed Windows helpers use fixed executable/argument arrays with no shell.
- Confirmed temporary credential files are deleted on ACL/write failure and live
  environment promotion occurs only after the protected atomic replacement.
- Confirmed a failed refresh preserves catalogue data but cannot claim connected
  health, and cached health cannot transfer between keys.
- Confirmed the selected-model fallback does not silently alter user intent.
- Confirmed controller artifacts and generated screenshots remain outside the
  commit.

## Commit

- `f7c320c` — `feat(orchestrator): add verified OpenRouter backend`

## Concerns / release gates

- This security-sensitive change still requires review by an agent/person other
  than the author before merge; the author did not approve or merge it.
- Automated tests use synthetic credentials and HTTP mocks. A real OpenRouter key
  was intentionally not available or used, so one redacted live account
  catalogue/chat check remains a release gate.
- The Windows credential file is ACL-protected plaintext for compatibility, not
  DPAPI-encrypted. The enforced user ACL passed a real Windows smoke; documentation
  states this boundary and its rollback behavior without claiming encryption.

## Security review fixes

The independent review of `1430cc3..f7c320c` returned **Needs fixes**. Commit
`1577a0f` (`fix(orchestrator): secure OpenRouter authentication`) addresses every
critical and important item without pushing the branch:

- Authenticated model discovery now uses the exact official
  `GET https://openrouter.ai/api/v1/models/user` endpoint and rejects a successful
  HTTP response whose body does not contain a model-data array.
- OpenRouter validation and chat are hard-pinned to
  `https://openrouter.ai/api/v1`; `OPENROUTER_BASE_URL` is ignored and API
  configuration rejects any endpoint override before a candidate key can be sent.
- Refresh and configure operations bind their async validation result to a
  credential snapshot. A concurrent live-key replacement yields a normalized
  conflict/cancellation result and cannot persist catalogue health for the old key.
- Expired OpenRouter discovery remains visible for recovery and selection context,
  but provider status becomes unavailable until authenticated discovery succeeds.
- Pricing classification covers reported token, request, image, web-search,
  internal-reasoning, and cache-read/write dimensions. Incomplete, malformed, or
  unknown pricing is classified as `unknown`, never optimistically free.
- Provider documentation now records that OpenRouter custom endpoints are not
  supported.

### Review-fix TDD and verification evidence

- RED before production changes: 4 files, 8 failed and 62 passed tests. Failures
  covered the authenticated user catalogue path and schema, endpoint pinning,
  in-flight credential replacement, expired-provider truth, and comprehensive
  pricing classification.
- Focused GREEN after production changes:
  `pnpm.cmd --filter @morrow/orchestrator exec vitest run test/provider-connectivity.test.ts test/provider-configure.test.ts test/server-providers.test.ts test/routing.test.ts --maxWorkers=1`
  — PASS: 4 files, 70 tests.
- Targeted contracts/orchestrator verification — PASS: contracts 5 files / 40
  tests; orchestrator 9 files / 115 tests.
- `pnpm.cmd --filter @morrow/contracts check` — PASS.
- `pnpm.cmd --filter @morrow/orchestrator check` — PASS after correcting two
  test-only mock signatures; affected regression rerun PASS: 2 files / 35 tests.
- `pnpm.cmd --filter @morrow/contracts build` — PASS.
- `pnpm.cmd --filter @morrow/orchestrator build` — PASS.
- `git diff --check 1430cc3` and staged `git diff --cached --check` — PASS.
- Exact cumulative Task 2 diff scan — PASS: no private-key/cloud-token patterns
  and no live credential values; values were not printed.
- Index audit before commit — PASS: only the nine reviewed source, test, and
  documentation files were staged. The brief, report, review diff, and generated
  `output/` remained untracked.

### Remaining concerns after review fixes

- The fixes require an independent re-review before merge because the author did
  not approve or merge this security-sensitive change.
- Automated verification still uses synthetic credentials and HTTP mocks. The
  redacted live-account catalogue/chat gate remains outstanding.
- OpenRouter SSE error framing remains bounded by the existing parser behavior;
  the review noted it as a minor concern rather than a blocking finding.

## Second security re-review fixes

The re-review of `1430cc3..1577a0f` found no critical issues and two important
gaps. Commit `6c78f8b` (`fix(orchestrator): close OpenRouter review gaps`)
addresses both without pushing the branch:

- OpenRouter provider status preserves `vision: true` but now reports
  `customEndpoint: false`, matching the enforced official-endpoint boundary.
- Empty and whitespace-only provider pricing strings are invalid instead of
  being coerced to zero, so affected models are classified `unknown`, not
  optimistically `free`.
- The provider documentation now names the authenticated
  `GET /api/v1/models/user` catalogue endpoint.

### Second re-review TDD and verification evidence

- RED before production changes: 2 files, 2 failed and 32 passed tests. The
  failures showed `customEndpoint: true` and blank/whitespace pricing classified
  as `free`.
- An initial one-line capability edit matched the earlier Anthropic descriptor;
  the focused test remained red, the diff exposed the mismatch, Anthropic was
  restored, and the OpenRouter descriptor was changed using explicit provider-id
  context.
- Focused GREEN:
  `pnpm.cmd --filter @morrow/orchestrator exec vitest run test/provider-connectivity.test.ts test/routing.test.ts --maxWorkers=1`
  — PASS: 2 files, 34 tests.
- Covering provider connectivity/status/registry run:
  `pnpm.cmd --filter @morrow/orchestrator exec vitest run test/provider-connectivity.test.ts test/server-providers.test.ts test/routing.test.ts --maxWorkers=1`
  — PASS: 3 files, 48 tests.
- `pnpm.cmd --filter @morrow/orchestrator check` — PASS.
- `pnpm.cmd --filter @morrow/orchestrator build` — PASS.
- Diff and staged whitespace audits — PASS.
- Exact `1577a0f` review-fix diff scan — PASS: no private-key/cloud-token
  patterns and no live credential values; values were not printed.
- Index audit before commit — PASS: only the five reviewed production, test, and
  documentation files were staged. Review artifacts, report, brief, and generated
  `output/` remained untracked.

### Remaining concern after second re-review

- OpenRouter SSE framing remains tracked as the non-blocking minor concern. The
  independent live-account verification and final author-independent approval
  gates also remain outstanding.
