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
then exercises the packaged write-capable agent, production browser boundary,
automatic Cortex services, model catalog, and production durable mission
controller. PASS requires all of the following:

- reproduce two fixture defects, recover from malformed tool arguments and a
  failing command, patch exactly three expected files, pass the tests, and
  inspect the final Git diff;
- render and interact with a responsive Morrow company site in a real browser,
  inspect the DOM and console, and attach valid vision evidence at desktop,
  tablet, and mobile viewports;
- capture an evidence-backed memory in Mission A and recall it automatically in
  Mission B, then promote a repeated safe workflow from candidate to validated
  skill and apply it automatically in Mission C;
- compare packaged model list/detail output before and after a service restart,
  with limits either sourced positive integers or explicitly unknown;
- complete 96 productive work units across context rollovers, checkpoints, a
  database close/reopen, and recoverable provider/tool failures without a
  deadline, fake sleep, or user continuation; and
- drive five deterministic controller faults: premature completion, context
  rollover, provider failure, legitimate no-progress investigation, and an
  abrupt controller restart, while retaining one mission ID, unique durable
  operation keys, expected recovery decisions, and Guardian-gated completion.

The deterministic browser provider and coding provider are local, scripted, and
unmetered, but they cross the real agent/tool/persistence boundaries. They do
not replace the separate release gate that runs a capable external model from
the packaged product on a fresh coding fixture.

## Package proof

After building the portable package:

```powershell
node scripts/package-release.mjs 0.1.0-beta.31 --skip-build
pnpm smoke:acceptance-foundation
pnpm smoke:acceptance-durable
```

The package smoke copies the portable product to a temporary install root,
invokes its bundled launcher/runtime, verifies the reports and leak scan, stops
the packaged service, removes the disposable install, and retains redacted
reports/ledgers plus the deterministic browser screenshots and generated test
fixtures needed for visual diagnosis under
`.artifacts/acceptance-foundation/<run-id>` or
`.artifacts/acceptance-durable-autonomy/<run-id>`. These fixtures contain only
scenario-authored synthetic data; the smoke child receives no provider keys.
Responsive PNGs are copied to short run-level artifact paths, and the smoke
revalidates their PNG signatures and SHA-256 values after retaining them so
Windows path-length behavior cannot make nominal evidence inaccessible.

On packaged Windows builds, browser acceptance uses the installed Microsoft
Edge channel unless an explicit Playwright browser selection is configured.
This keeps the consumer package self-contained without downloading an undeclared
browser at runtime.

## Security boundary

The child process receives a minimal environment with provider credentials
removed, a private `MORROW_HOME`, loopback-only service state, and
`MOCK_PROVIDER=true`. Git and product processes use fixed executable/argument
arrays with `shell: false`. No remote, push, deployment, purchase, or credential
mutation is part of the scenario.

Fault injection occurs only inside the packaged acceptance runner at the
controller's dependency boundary. It does not add an environment-controlled
fault or bypass path to the production orchestrator API.
