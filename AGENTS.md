# AI Agent Working Agreement

This file governs AI coding agents working in the Morrow repository.

## Mission

Build Morrow as a direct, privacy-focused alternative to Hermes Agent. Morrow must preserve practical agent capabilities while providing a cleaner experience, deeper customization, better reliability, persistent agent teams, understandable privacy, and evidence-backed superiority.

Morrow is an AI agent application. Do not reframe it as an operating system, enterprise control plane, generic dashboard, or unrelated SaaS platform.

## Before changing code

1. Read `README.md` and the relevant files in `docs/`.
2. Identify the issue or acceptance criteria being addressed.
3. Inspect existing interfaces before introducing a new abstraction.
4. State assumptions in the pull request when requirements are incomplete.
5. Prefer the smallest coherent change that advances a milestone.

## Required behavior

- Work on a dedicated branch.
- Keep commits focused and use Conventional Commit messages.
- Add or update tests for behavior changes.
- Run all available checks before reporting completion.
- Include evidence: commands run, tests passed, screenshots where relevant, and known limitations.
- Update architecture records when changing a major boundary or invariant.
- Preserve local-first behavior and provider choice.
- Keep the default experience simple while exposing advanced controls progressively.

## Integration discipline

`main` is the single integration branch. Everything reconciles onto it, and
nothing else is allowed to become a second long-lived line.

- Rebase or merge `main` into your branch daily once it is more than a week
  behind, and always before requesting a merge. CI enforces this
  (`scripts/check-branch-freshness.mjs`): a pull request whose merge-base is
  more than seven days of integration history old fails.
- Anything touching `services/orchestrator/src/{execution,provider,web}` is
  held to that window strictly. Those are the files two parallel lines both
  edit, and the merge that unified them produced defects with no conflict
  marker to warn anyone.
- Delete a branch once it merges. `node scripts/branch-inventory.mjs`
  regenerates `docs/branch-inventory.md`, which separates merged branches from
  abandoned ones so the backlog can be cleared deliberately.
- Two agents must not work parallel long-lived branches over the same
  subsystem. If that is unavoidable, land the first before starting the second.

This is not a style preference. `morrow/consumer-polish` and `main` diverged
for a week at 88 and 70 commits, and the reconciliation silently merged two
unrelated functions that happened to share a name (caught only because `tsc`
complained — a rename would have hidden it) and dropped a fix that had already
shipped once in beta.34.

## Prohibited behavior

- Do not commit secrets, API keys, tokens, credentials, private messages, or personal data.
- Do not bypass permissions or approval boundaries for convenience.
- Do not add telemetry, analytics, external inference, or hosted dependencies silently.
- Do not claim a capability is complete without a test or reproducible demonstration.
- Do not copy code from Hermes or another project without verifying its license and preserving required attribution.
- Do not let the same agent author, approve, and merge a security-sensitive change.
- Do not merge directly to `main`.
- Do not introduce broad frameworks or integrations before the current vertical slice is stable.

## Security-sensitive areas

Changes touching any of the following require explicit security review:

- Tool permissions and approvals
- Terminal, filesystem, browser, or computer control
- Secrets and credentials
- Memory storage or retrieval
- Model-provider requests and external data flow
- Scheduled or unattended execution
- Authentication and remote access
- Plugin, skill, MCP, or extension loading

## Definition of done

A change is complete only when:

- Acceptance criteria are satisfied.
- Relevant tests pass.
- Failure behavior has been considered.
- User-visible behavior is documented.
- Privacy and security impact is recorded.
- The pull request includes evidence and rollback notes.
