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
- The startup metadata refresh below may contact models.dev, but sends no
  credentials, conversation content, project paths, memory, or provider keys
- Network-deny tests for inference and tool execution must pass
- Remote provider selection is rejected before dispatch, and browser/MCP tools
  plus likely network shell commands are blocked at execution time

### Controlled cloud

- User-approved providers
- Request-by-request context disclosure
- External destinations recorded
- Provider fallback cannot silently change privacy behavior

### Public model metadata refresh

Morrow synchronously applies bundled or cached public metadata, then may refresh
the public models.dev catalog in the background during orchestrator startup.
This is an intentional public metadata request and may occur before a provider
or model is selected, including when the eventual session uses Private Local.
It sends no Morrow credentials, conversation content, project paths, memory, or
provider keys; normal network metadata such as the client IP reaches models.dev.
The normalized response is cached locally and a last-known-good cache is
retained on refresh failure. Provider account availability remains a separate
authenticated provider request. Redirects are rejected, so catalog metadata
cannot select a second network destination. Private Local still keeps inference,
credentials, task data, and external tools on the local side of its boundary.

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
- Secret-shaped workspace paths remain protected: `create_file`, `append_file`,
  patch application, and direct safe reads reject real `.env`, credential-store,
  and private-key conventions. Security tests that need such a path must have
  a harness or user provision a synthetic fixture in an isolated workspace
  before the worker starts. The worker may run a test against that fixture, but
  it must not create or modify the fixture through Morrow file tools, and real
  credentials must never be placed in it.
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
- Cross-turn chat working memory is *derived*, never separately stored. Each
  follow-up turn rebuilds a bounded digest from the conversation's existing
  redacted tool-call records, scoped to the same project, conversation, and
  worktree, and bounded by the post-compaction window. It carries paths, byte
  sizes, command lines with exit codes, result counts, and bounded error text —
  never file contents, and never browser URL credentials or query strings.
  Deleting or compacting the conversation removes the memory with it, and the
  digest cannot drift from the audit record.
- Complete deletion for user-requested local data removal
- Provider continuation fields needed for protocol correctness are locally
  access-restricted with task state, excluded from public events, logs,
  summaries, full-text search, exports, and API responses, and never presented
as model reasoning.
- Activity views show only redacted execution facts: phase, tool name, target,
  status, timing, and bounded result metadata. They never expose raw provider
  reasoning, tool arguments, or tool output.
- A user-triggered support bundle reuses that redacted activity projection and
  adds bounded task/provider/disclosure/verification summaries. It does not
  export raw events, tool arguments/results, prompts, secrets, or private
  reasoning.

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
