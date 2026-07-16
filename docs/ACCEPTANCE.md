# Morrow Acceptance

Morrow's acceptance foundation tests the packaged product rather than calling
only internal modules. It is deliberately separate from ordinary unit tests.

## Commands

```powershell
morrow acceptance run
morrow acceptance run --scenario durable-autonomy-v1
morrow acceptance resume <run-id>
morrow acceptance report <run-id>
```

Each run persists atomic state, an append-only evidence ledger, `report.json`,
and `report.md` under `MORROW_HOME/acceptance/runs/<run-id>`. Reports use only
PASS, FAIL, BLOCKED, NOT RUN, or INCONCLUSIVE. Only PASS satisfies the smoke.

The foundation scenario creates a disposable Git repository, records its clean
starting SHA, launches the compiled Morrow CLI and real local orchestrator with
the deterministic mock provider, reads a bounded fixture file through Morrow's
normal workspace tool, then inspects the persisted task through `morrow audit`.
Successful disposable workspaces are removed after their reports are durable;
failed/inconclusive workspaces are retained for diagnosis.

The versioned `durable-autonomy-v1` scenario retains the foundation proof and
then drives the production durable mission controller and SQLite operation
ledger through five deterministic injected faults: premature completion,
context rollover, provider failure, legitimate no-progress investigation, and
an abrupt controller restart. PASS additionally requires one stable mission ID
per continuation, unique durable operation keys, the expected recovery ledger,
Guardian rejection before validation where applicable, and terminal
Guardian-gated completion.

Both deterministic scenarios are local and unmetered. They do not replace the
separate real-model coding, browser/vision, Cortex memory, automatic skill
creation, or long-run release gates.

## Package proof

After building the portable package:

```powershell
node scripts/package-release.mjs 0.1.0-beta.30 --skip-build
pnpm smoke:acceptance-foundation
pnpm smoke:acceptance-durable
```

The package smoke copies the portable product to a temporary install root,
invokes its bundled launcher/runtime, verifies the reports and leak scan, stops
the packaged service, removes the disposable install, and retains only redacted
evidence under `.artifacts/acceptance-foundation/<run-id>` or
`.artifacts/acceptance-durable-autonomy/<run-id>`.

## Security boundary

The child process receives a minimal environment with provider credentials
removed, a private `MORROW_HOME`, loopback-only service state, and
`MOCK_PROVIDER=true`. Git and product processes use fixed executable/argument
arrays with `shell: false`. No remote, push, deployment, purchase, or credential
mutation is part of the scenario.

Fault injection occurs only inside the packaged acceptance runner at the
controller's dependency boundary. It does not add an environment-controlled
fault or bypass path to the production orchestrator API.
