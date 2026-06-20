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
