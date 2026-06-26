# Contributing to Morrow

Morrow is in private early access beta. Contributions should be deliberate, reviewable, and tied to a documented product goal.

## Development flow

1. Create or select an issue.
2. Create a branch using one of these prefixes:
   - `feat/`
   - `fix/`
   - `docs/`
   - `refactor/`
   - `test/`
   - `security/`
3. Make focused commits using Conventional Commits.
4. Run repository checks.
5. Open a pull request using the template.
6. Obtain independent review before merge.

## Commit examples

```text
feat(orchestrator): persist task checkpoints
fix(memory): prevent cross-project retrieval
security(runtime): deny undeclared network access
docs(architecture): record provider routing boundary
```

## Pull request expectations

Every pull request should explain:

- The problem
- The chosen solution
- What was deliberately not included
- Test evidence
- Privacy and security impact
- Rollback approach

## Architecture decisions

Create an ADR in `docs/decisions/` for changes that affect:

- Service boundaries
- Storage engines
- Protocols
- Trust boundaries
- Model-routing strategy
- Extension architecture
- Compatibility commitments

Use the next sequential number and follow the existing ADR format.
