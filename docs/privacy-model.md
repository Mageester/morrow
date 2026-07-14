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

### Custom

- Per-project and per-agent rules
- Domain allowlists
- Model restrictions
- Retention controls
- Explicit exceptions

## Required safeguards

- No silent telemetry
- No secret values in prompts or logs
- No cross-project memory retrieval
- No external provider fallback without disclosure
- No plugin or skill access beyond declared capabilities
- Complete deletion for user-requested local data removal
- Provider continuation fields needed for protocol correctness are locally
  access-restricted with task state, excluded from public events, logs,
  summaries, full-text search, exports, and API responses, and never presented
  as model reasoning.

## Mission continuity retention

Structured checkpoints contain concise decisions and execution facts, never
hidden chain-of-thought. Full raw conversation, tool, and event records remain
authoritative and are not destroyed by provider compaction. The provider only
receives a bounded projection selected for that request; screen clearing has no
retention effect. Deleting a task cascades its execution segments, provider
turns, checkpoints, private continuation rows, and canonical answer.
