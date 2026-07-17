import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFoundationFixture, verifyFixtureUnchanged } from "../src/acceptance/fixture.js";
import { REQUIRED_FOUNDATION_CHECKS, classifyFoundationRun, writeAcceptanceReports } from "../src/acceptance/report.js";
import { AcceptanceStore } from "../src/acceptance/storage.js";
import type { AcceptanceCheck, AcceptanceRunState } from "../src/acceptance/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "morrow-acceptance-fixture-"));
  roots.push(value);
  return value;
}

function state(runId: string, checks: Record<string, AcceptanceCheck> = {}): AcceptanceRunState {
  return {
    schemaVersion: 1,
    runId,
    scenarioId: "foundation-smoke-v1",
    lifecycle: "running",
    disposition: "NOT RUN",
    startedAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:01:00.000Z",
    completedAt: null,
    activeStep: null,
    completedSteps: [],
    recoveryCount: 0,
    fixture: null,
    product: null,
    source: null, provenance: null,
    checks,
    artifacts: [],
    message: null,
  };
}

describe("foundation fixture", () => {
  it(
    "creates a clean real Git repository with a recorded immutable starting SHA",
    { timeout: 20_000 },
    () => {
      const runRoot = root();
      const fixture = createFoundationFixture(runRoot);
      expect(fixture.path).toBe(join(runRoot, "fixture"));
      expect(fixture.startingSha).toMatch(/^[0-9a-f]{40}$/);
      expect(fixture.startingStatus).toBe("");
      expect(readFileSync(join(fixture.path, "evidence.txt"), "utf8")).toContain("foundation fixture");
      expect(verifyFixtureUnchanged(fixture)).toEqual({
        head: fixture.startingSha,
        status: "",
        unchanged: true,
      });
    },
  );

  it("detects fixture modifications without resetting or deleting them", { timeout: 20_000 }, () => {
    const runRoot = root();
    const fixture = createFoundationFixture(runRoot);
    appendFileSync(join(fixture.path, "evidence.txt"), "changed\n");
    const result = verifyFixtureUnchanged(fixture);
    expect(result.head).toBe(fixture.startingSha);
    expect(result.status).toContain("evidence.txt");
    expect(result.unchanged).toBe(false);
  });
});

describe("truthful acceptance reports", () => {
  it("classifies only complete passed checks as PASS", () => {
    expect(classifyFoundationRun(state("run-20260716-00000001"))).toBe("NOT RUN");
    const inconclusive = state("run-20260716-00000002", {
      isolation: { status: "passed", summary: "contained", evidenceIds: [] },
    });
    expect(classifyFoundationRun(inconclusive)).toBe("INCONCLUSIVE");
    const failed = state("run-20260716-00000003", Object.fromEntries(REQUIRED_FOUNDATION_CHECKS.map((key) => [key, { status: key === "product_exit" ? "failed" : "passed", summary: key, evidenceIds: [] }])));
    expect(classifyFoundationRun(failed)).toBe("FAIL");
    const passed = state("run-20260716-00000004", Object.fromEntries(REQUIRED_FOUNDATION_CHECKS.map((key) => [key, { status: "passed", summary: key, evidenceIds: [] }])));
    expect(classifyFoundationRun(passed)).toBe("PASS");
    expect(classifyFoundationRun({ ...passed, disposition: "BLOCKED" })).toBe("BLOCKED");
  });

  it("writes JSON and Markdown without secrets or absolute local paths", () => {
    const acceptanceRoot = root();
    const store = new AcceptanceStore(acceptanceRoot, { secrets: ["fixture-canary-secret"] });
    const run = state("run-20260716-00000005", Object.fromEntries(REQUIRED_FOUNDATION_CHECKS.map((key) => [key, { status: "passed", summary: `${key} fixture-canary-secret`, evidenceIds: [] }])));
    store.create(run);
    const localPath = join(store.runRoot(run.runId), "fixture", "private-user-folder");
    store.appendEvidence(run.runId, {
      step: "fixture",
      kind: "git",
      status: "passed",
      summary: `Fixture at ${localPath}; API_KEY=raw-secret-value`,
      details: { localPath, canary: "fixture-canary-secret" },
    });
    const evidence = store.readEvidence(run.runId);
    const paths = writeAcceptanceReports(store, { ...run, disposition: "PASS", completedAt: "2026-07-16T12:02:00.000Z" }, evidence);
    expect(existsSync(paths.json)).toBe(true);
    expect(existsSync(paths.markdown)).toBe(true);
    const json = readFileSync(paths.json, "utf8");
    const markdown = readFileSync(paths.markdown, "utf8");
    for (const output of [json, markdown]) {
      expect(output).toContain("PASS");
      expect(output).toContain("<run-root>");
      expect(output).not.toContain(acceptanceRoot);
      expect(output).not.toContain("fixture-canary-secret");
      expect(output).not.toContain("raw-secret-value");
    }
    const report = JSON.parse(json);
    expect(report.fixture).toBeNull();
    expect(report.evidence).toHaveLength(1);
  });
});
