# Privacy Model

Privacy is a user-visible product behavior, not only a backend policy.

## User expectations

For every model request or tool action, Morrow should be able to explain:

- Which model or service is involved
- Whether it is local or remote
- What conversation content is included
- Which files and memories are included
- Which credentials are used without exposing their values
- Which network destinations are permitted
- What will be retained afterward

## Data categories

- Conversation data
- Personal memory
- Project memory
- Agent memory
- Files and repository content
- Credentials and secret handles
- Tool outputs
- Usage and cost records
- Execution history

Each category requires an explicit scope and retention rule.

## Privacy modes

### Local only

- Local storage
- Local inference
- No external model providers
- No external tools or telemetry
- Network-deny tests must pass

### Controlled cloud

- User-approved providers
- Request-by-request context disclosure
- External destinations recorded
- Provider fallback cannot silently change privacy behavior

### Public model metadata refresh

Morrow refreshes the public models.dev catalog only when an operator explicitly
requests a model-metadata refresh. This request sends no Morrow credentials,
conversation content, project paths, memory, or provider keys; normal network
metadata such as the client IP reaches models.dev. The normalized response is
cached locally and a last-known-good cache is retained on refresh failure.
Provider account availability remains a separate authenticated provider request.
Redirects are rejected, so catalog metadata cannot select a second network
destination. Private Local startup never triggers this request.

### Custom

- Per-project and per-agent rules
- Domain allowlists
- Model restrictions
- Retention controls
- Explicit exceptions

### Browser/web tool access is not a fourth mode

Whether an agent may use browser or web-search tools is a per-agent tool
permission (`AgentToolPermission`, allow/deny on the specific tool name), not
a separate privacy mode. It composes with any of the three modes above —
Local only still runs with web tools denied by default, since it forbids
external network access outright. See
[docs/decisions/0012-assistant-memory-and-teams.md](decisions/0012-assistant-memory-and-teams.md).

## Required safeguards

- No silent telemetry
- No secret values in prompts or logs
- Provider credential candidates remain server-only and are authenticated before
  persistence or promotion; a failed OpenRouter replacement cannot overwrite the
  last known-good credential.
- Provider credentials use an atomic owner boundary: current-user plus
  LocalSystem ACLs on Windows and mode `0600` on Unix-like systems. Failure to
  establish the platform boundary aborts the write.
- No cross-project memory retrieval
- No external provider fallback without disclosure
- No plugin or skill access beyond declared capabilities
- Automatic memory stores concise normalized conclusions and evidence references,
  never raw chain-of-thought; secret-like and prompt-poisoned candidates are
  rejected before admission.
- Automatically learned skills are project-scoped under local Morrow data, need
  two distinct successful mission observations, and cannot request network access
  or secrets. Invalid or modified bundles are quarantined before reuse.
- Complete deletion for user-requested local data removal
- Provider continuation fields needed for protocol correctness are locally
  access-restricted with task state, excluded from public events, logs,
  summaries, full-text search, exports, and API responses, and never presented
as model reasoning.
- Activity views show only redacted execution facts: phase, tool name, target,
  status, timing, and bounded result metadata. They never expose raw provider
  reasoning, tool arguments, or tool output.

Automatic memory retrieval increments a local usage counter so influence remains
auditable. Retrieval is limited to the current project/conversation scope and
excludes expired, stale, invalidated, retired, disabled, and candidate records.

## Mission continuity retention

Structured checkpoints contain concise decisions and execution facts, never
hidden chain-of-thought. Full raw conversation, tool, and event records remain
authoritative and are not destroyed by provider compaction. The provider only
receives a bounded projection selected for that request; screen clearing has no
retention effect. Deleting a task cascades its execution segments, provider
turns, checkpoints, private continuation rows, and canonical answer.

## Agentic harness release boundary

Tasks 1-8 add inspectable records around the existing task boundary. The
release-gate test in `services/orchestrator/test/agentic-harness-acceptance.test.ts`
proves these records deterministically with an in-memory database; it does not
use a live provider, an external website, telemetry, or a provider billing API.

- The task/event ledger remains authoritative when an SSE connection is silent.
  The web client may reconcile from the durable task aggregate, but a stream
  message is never treated as the only copy of an answer.
- Cost lines store provider-reported usage, a frozen pricing snapshot, and
  fixed-point micro-USD amounts. Missing usage or authoritative pricing keeps
  cost `unknown`. Morrow does not claim a provider invoice total until a
  billing integration exists.
- A current/latest request is a research requirement. Local-only mode stops at
  the policy boundary and makes no research request. Controlled-cloud research
  records URL, retrieval time, publication metadata when known, citations, and
  task provenance; fetched content remains untrusted and cannot grant tools.
- Memory extraction creates a proposed candidate only. Approval selects the
  final scope and retention, retrieval enforces that scope, and forget removes
  the record from future retrieval. Project memory never crosses projects;
  `user_global` is the explicit, opt-in exception.
- A learned skill is a draft until safety validation, deterministic replay, and
  explicit user approval succeed. Undeclared tools, network domains, secrets,
  destructive operations, dynamic loading, and permission widening fail closed.
- An improvement is a proposal evaluated in shadow fixtures. Promotion is a
  user action after the candidate improves the declared metric without privacy,
  reliability, or verification regression. Model text cannot activate a skill,
  widen a tool profile, or change policy.

Browser-safe projections contain bounded execution facts and provenance labels,
not credentials, raw tool arguments, raw tool output, raw provider reasoning,
source snapshots, or secret-like memory content. The deterministic Playwright
proof covers the local packaged surface and mock runtime only. Live browser
behavior, external-provider behavior, and provider-invoice accuracy remain
deferred release boundaries and must not be described as proven by this gate.
