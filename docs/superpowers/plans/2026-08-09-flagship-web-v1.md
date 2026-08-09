# Flagship Web v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently scored `flagship-web-v1` real-provider acceptance using hidden harness-owned test and browser verification.

**Architecture:** Score one supported scenario per `evaluateFlagshipGate` call and let the CLI report all supported scenarios. Preserve the existing build wrapper while adding a focused web scenario that reuses the real agent and mission-verification boundaries.

**Tech Stack:** TypeScript ESM, Vitest, SQLite, Playwright, pnpm, Node.js 22.

## Global Constraints

- Preserve `flagship-build-v1`; do not replace or weaken it.
- Do not run a real provider or append live evidence this session.
- The harness-owned checker is created outside the model-visible workspace after agent execution.
- Use the real mission verification defaults for shell execution and service startup, and the real Playwright browser controller.
- Run flagship scenarios serially; they share ports, SQLite state, and temporary workspaces.
- Never weaken an assertion, extend a sleep, raise a timeout, or skip a test to obtain green.
- Do not inspect or modify the protected prototype UI paths listed in `agent_docs/project_structure.md`.
- Fix behavior at the boundary that owns it and enumerate all implementations before claiming the class covered.

---

### Task 1: Scenario-aware flagship gate

**Files:**
- Modify: `services/orchestrator/src/acceptance/flagship-gate.ts`
- Modify: `services/orchestrator/scripts/flagship-gate.ts`
- Modify: `services/orchestrator/test/flagship-build.test.ts`

**Interfaces:**
- Produces: `FlagshipScenarioId`, `FLAGSHIP_SCENARIO_IDS`, and `FlagshipGateOptions.scenarioId`.
- Preserves: `evaluateFlagshipGate(runs)` scoring `flagship-build-v1` by default.

- [ ] **Step 1: Write the failing scenario-isolation test**

Add a run helper override for `scenarioId`, then assert that twenty qualifying `flagship-web-v1` runs pass when evaluated with `{ scenarioId: "flagship-web-v1" }`, do not pass the default build gate, and are counted as `otherScenarios` only by the default gate. Also mix failing build runs with passing web runs and assert the web gate remains qualified.

- [ ] **Step 2: Verify the red failure**

Run:

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/flagship-build.test.ts
```

Expected: the new test fails because the gate hardcodes `flagship-build-v1`.

- [ ] **Step 3: Implement the minimal gate API**

Define:

```ts
export const FLAGSHIP_SCENARIO_IDS = ["flagship-build-v1", "flagship-web-v1"] as const;
export type FlagshipScenarioId = typeof FLAGSHIP_SCENARIO_IDS[number];

export interface FlagshipGateOptions {
  minRuns?: number;
  minPasses?: number;
  minProviders?: number;
  scenarioId?: FlagshipScenarioId;
}
```

Filter using `options.scenarioId ?? "flagship-build-v1"`. Include the selected `scenarioId` in `FlagshipGateResult` and its summary. Keep mock and harness-error semantics unchanged. Update the CLI to evaluate and print each `FLAGSHIP_SCENARIO_IDS` member and make `--require` fail when any selected gate is unproven.

- [ ] **Step 4: Verify green and regression behavior**

Run the focused test again. Confirm all prior gate assertions still pass and the new test proves cross-scenario isolation.

### Task 2: Hidden web verifier and scenario runner

**Files:**
- Create: `services/orchestrator/src/acceptance/flagship-web.ts`
- Modify: `services/orchestrator/src/acceptance/flagship-build.ts`
- Modify: `services/orchestrator/test/flagship-build.test.ts` or create `services/orchestrator/test/flagship-web.test.ts`

**Interfaces:**
- Consumes: `FlagshipScenarioId`, `runVerification`, `playwrightController`, and the existing provider-agent run lifecycle.
- Produces: `FLAGSHIP_WEB_SCENARIO_ID`, `FLAGSHIP_WEB_PROMPT`, `verifyFlagshipWebArtifact`, and `runFlagshipWeb`.
- Preserves: `runFlagshipBuild` and existing run-record fields; generalize `scenarioId` to `FlagshipScenarioId` without changing JSONL compatibility.

- [ ] **Step 1: Write failing fixture tests**

Create a scripted provider fixture that writes at least `package.json`, `index.html`, a stylesheet, browser JavaScript, and a Node development server. Add assertions that a correct fixture passes, a missing required file fails as `artifact_missing`, and an incorrect app with an agent-authored passing test still fails the hidden checker.

The negative fixture must be behaviorally wrong, not syntactically invalid, so deleting the hidden checker would make the test fail to catch the defect.

- [ ] **Step 2: Verify the red failure**

Run the focused web test. Expected: module/export or assertion failure because `flagship-web-v1` is not implemented.

- [ ] **Step 3: Implement the prompt and shared lifecycle seam**

Add a public contract requiring a multi-file frontend, a loopback development-server script, and a small observable interaction. Extract only the minimal existing setup/execution/measurement lifecycle needed by both scenario wrappers. Do not move verification policy out of the scenario modules.

- [ ] **Step 4: Implement the hidden test strategy**

After agent execution, write the checker into `<root>/verify`, never `<root>/workspace`. Invoke it through:

```ts
await runVerification(
  { kind: "test", command: hiddenTestCommand, expectExitCode: 0 },
  { workspacePath: workspace },
);
```

The checker must derive expectations independently from the generated app and fail on the negative fixture even when the workspace's own test command exits zero.

- [ ] **Step 5: Implement the browser strategy**

Invoke:

```ts
await runVerification(
  {
    kind: "browser",
    command: startCommand,
    url: loopbackUrl,
    expectStatus: 200,
  },
  {
    workspacePath: workspace,
    browser: () => playwrightController({
      headless: true,
      allowPrivateNetwork: true,
      allowedDomains: ["localhost", "127.0.0.1"],
    }),
  },
);
```

Use a deterministic scenario-owned port allocation that cannot collide with a concurrently running scenario, or prove the existing harness's serial execution guarantees a fixed loopback port. Do not solve collisions by retry sleeps or longer timeouts.

- [ ] **Step 6: Classify results without laundering failures**

Require the hidden test and browser outcomes to be `passed`. Map failed/inconclusive verifier outcomes to a non-empty `failureDetail`; retain the existing zero-output `harness_error` rule and `task_not_completed` rule. Compute the artifact digest over the required multi-file contents in stable path order.

- [ ] **Step 7: Verify green**

Run the focused web tests. Confirm the correct fixture passes and every negative fixture fails for its intended reason.

### Task 3: Explicit live-runner scenario selection

**Files:**
- Modify: `services/orchestrator/test/live/flagship-build.test.ts`
- Modify: relevant deterministic live-isolation test if selection logic is extracted.

**Interfaces:**
- Consumes: `FLAGSHIP_SCENARIO_IDS`, `runFlagshipBuild`, and `runFlagshipWeb`.
- Produces: one-scenario-per-process selection through `MORROW_FLAGSHIP_SCENARIO`, defaulting to `flagship-build-v1`.

- [ ] **Step 1: Write a deterministic selection test**

Extract a pure scenario-selection helper if required. Assert the default selects build v1, `flagship-web-v1` selects the web runner, and an unsupported value throws before provider configuration or evidence writes.

- [ ] **Step 2: Verify red**

Run the focused isolation/selection test and observe the missing selector failure.

- [ ] **Step 3: Implement serial selection**

Update the live runner to invoke exactly one selected scenario and evaluate that scenario's gate. Preserve `MORROW_LIVE_FLAGSHIP=1` as mandatory consent. Do not run the live test.

- [ ] **Step 4: Verify deterministic isolation**

Run the focused test and confirm no provider call or evidence append occurs without explicit opt-in.

### Task 4: Boundary enumeration and verification

**Files:**
- Modify tests only if an uncovered behavioral defect is first reproduced red.
- Update durable documentation only with verified final facts.

**Interfaces:**
- Consumes all completed changes.
- Produces independent verification evidence and an exact list of boundary implementations inspected.

- [ ] **Step 1: Enumerate implementations**

Use symbol and call-site searches to list every implementation of command execution, service startup, browser creation, and Git changed-file verification used by mission evidence. Confirm which implementations the new scenario exercises and report any uncovered implementation as a limitation rather than declaring the class fixed.

- [ ] **Step 2: Run focused and broader gates**

Run sequentially:

```powershell
pnpm --filter @morrow/orchestrator exec vitest run test/flagship-build.test.ts test/flagship-web.test.ts test/flagship-harness-error-classification.test.ts test/live-provider-isolation.test.ts
pnpm --filter @morrow/orchestrator test
pnpm --filter @morrow/orchestrator check
pnpm --filter @morrow/orchestrator build
pnpm check
git diff --check
```

Omit a nonexistent focused test path rather than creating a placeholder. Do not run `pnpm flagship:run`.

- [ ] **Step 3: Review privacy and rollback**

Confirm only loopback browser access is enabled, no credential path is touched, default tests remain non-live, append-only evidence is unchanged, and rollback preserves `flagship-build-v1`.

