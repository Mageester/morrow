# Benchmark Plan

Morrow's advantage must be demonstrated through repeatable tests.

## Benchmark groups

### Capability parity

- Repository inspection and modification
- Browser research with source collection
- File creation and transformation
- Long-running task execution
- Scheduled work
- Messaging delivery
- Memory recall and correction
- Skills, plugins, and MCP use
- Local and remote model switching

### Reliability

- Provider rate limit during a task
- Model timeout
- Tool failure
- Browser crash
- Application restart
- Machine restart
- Partial file write
- Agent deadlock or repeated action

### Privacy and security

- Local-only mode produces zero external requests
- Project memory does not cross boundaries
- Secrets are absent from prompts, logs, and memory
- Unattended jobs cannot broaden permissions
- Browser tools cannot access blocked private-network addresses
- Extensions cannot use undeclared capabilities

### User experience

- Time from installation to first successful task
- Time to understand what an agent is currently doing
- Time to correct an inaccurate memory
- Number of approval interruptions per successful task
- Recovery from a failed task without terminal use
- Customization discoverability

## Initial targets

These are development targets, not current product claims.

| Metric | Target |
|---|---:|
| Core comparison tasks completed successfully | At least 20% above baseline |
| Human interventions per completed long task | At least 30% below baseline |
| Task recovery after application restart | 95% or higher |
| Privileged actions with visible provenance | 100% |
| Local-only external requests | 0 |
| File-changing tasks with rollback point | 100% |
| Substantial tasks with verification evidence | 100% |
| Median setup to first successful task | Under 5 minutes |

## Evidence format

Each benchmark record must include:

- Test identifier
- Product and version
- Model and provider
- Hardware and operating system
- Input prompt and fixtures
- Configuration and permissions
- Wall-clock time and cost
- Intervention count
- Final outcome
- Logs or video where appropriate
- Known limitations

## Agentic harness release gate

The cross-cutting deterministic gate is
`services/orchestrator/test/agentic-harness-acceptance.test.ts`, with the
browser-specific silent-stream and projection proof in
`apps/web/e2e/agentic-harness-acceptance.spec.ts`. The gate covers these
scenarios without live providers or network access: silent SSE completion,
two-request exact cost, unknown cost, local-only freshness refusal, controlled
cloud source provenance, approved memory and forget, skill quarantine for
undeclared network access, and a privacy-preserving optimization proposal.

Every recorded result must preserve the following fields, with `null` or
`unknown` when a measurement is unavailable rather than a guessed value:

- exact usage source, pricing snapshot version and retrieval time, fixed-point
  cost amount, cost accuracy, provider/model, and request count;
- wall-clock time, provider attempts, retries, compactions, duplicate
  observations, tool-schema input tokens, and intervention count;
- configured privacy mode, network/tool permissions, source IDs and retrieval
  timestamps when research is used, memory scope/approval state, skill safety
  and replay results, improvement version, and verification outcome.

The deterministic fixture is evidence of contract and persistence behavior, not
of model quality. Provider invoice accuracy is unavailable until a real billing
integration reports an invoice-backed amount. External-provider reliability,
live-browser behavior, and network research quality remain deferred and require
separate, explicitly funded runs with redacted evidence.
