import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAcceptanceChildEnvironment, classifyAcceptanceFailure, resumeAcceptance, runAcceptance, validateAcceptanceRunPaths, type AcceptanceInvocation } from "../src/acceptance/runner.js";
import { AcceptanceStore } from "../src/acceptance/storage.js";

const roots: string[] = [];
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "morrow-acceptance-runner-"));
  roots.push(value);
  return value;
}

const TEST_PACKAGE_COMMIT = "a".repeat(40);

function successfulInvoker(calls: string[][]): AcceptanceInvocation {
  return async (args) => {
    calls.push(args);
    if (args[0] === "provenance") return {
      exitCode: 0,
      stdout: JSON.stringify({
        packaged: true,
        provenance: {
          schemaVersion: 1, version: "0.1.0-test", sourceCommit: TEST_PACKAGE_COMMIT, dirty: false,
          buildTimestamp: "2026-07-16T00:00:00.000Z", schemaCatalogVersion: 1, manifestHash: "f".repeat(64),
        },
      }),
      stderr: "",
    };
    if (args[0] === "init") return { exitCode: 0, stdout: JSON.stringify({ id: "project-1" }), stderr: "" };
    if (args[0] === "ask") return { exitCode: 0, stdout: JSON.stringify({ status: "completed", task: { id: "task-1", status: "completed" }, evidence: [{ path: "evidence.txt" }], toolCalls: [{ tool: "read_file", status: "completed" }] }), stderr: "" };
    if (args[0] === "audit") return { exitCode: 0, stdout: JSON.stringify({ task: { id: "task-1", status: "completed" }, events: [{ type: "task.completed" }], evidence: [{ path: "evidence.txt" }], toolCalls: [{ toolName: "read_file", status: "completed" }] }), stderr: "" };
    if (args[0] === "stop") return { exitCode: 0, stdout: "", stderr: "" };
    throw new Error(`Unexpected invocation: ${args.join(" ")}`);
  };
}

describe("acceptance child environment", () => {
  it("keeps runtime necessities and strips credentials plus packaged no-autostart", () => {
    const env = buildAcceptanceChildEnvironment({
      Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", USERPROFILE: "C:\\Users\\person",
      MORROW_PACKAGED: "1", MORROW_SKILLS_DIR: "C:\\Morrow\\skills", MORROW_NO_AUTOSTART: "1",
      OPENAI_API_KEY: "sk-must-not-leak", ANTHROPIC_API_KEY: "must-not-leak", RANDOM_SECRET: "must-not-leak",
    }, "C:\\isolated-home", 45123);
    expect(env).toMatchObject({
      Path: "C:\\Windows", SystemRoot: "C:\\Windows", TEMP: "C:\\Temp", USERPROFILE: "C:\\Users\\person",
      MORROW_HOME: "C:\\isolated-home", MORROW_PACKAGED: "1", MORROW_SKILLS_DIR: "C:\\Morrow\\skills",
      MOCK_PROVIDER: "true", PORT: "45123",
    });
    expect(env.MORROW_NO_AUTOSTART).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.RANDOM_SECRET).toBeUndefined();
  });

  it("distinguishes unavailable executables from observed product failures", () => {
    expect(classifyAcceptanceFailure(Object.assign(new Error("missing runtime"), { code: "ENOENT" }))).toBe("BLOCKED");
    expect(classifyAcceptanceFailure(new Error("product returned incorrect evidence"))).toBe("FAIL");
  });
});

describe("foundation acceptance runner", () => {
  it("rejects tampered persisted fixture and product paths before resume or cleanup", () => {
    const acceptanceRoot = root();
    const store = new AcceptanceStore(acceptanceRoot);
    const runRoot = store.runRoot("run-20260716-10000009");
    const base = {
      schemaVersion: 1 as const, runId: "run-20260716-10000009", scenarioId: "foundation-smoke-v1" as const,
      lifecycle: "running" as const, disposition: "NOT RUN" as const, startedAt: "t", updatedAt: "t", completedAt: null,
      activeStep: null, completedSteps: [], recoveryCount: 0, source: null, provenance: null, checks: {}, artifacts: [], message: null,
    };
    expect(() => validateAcceptanceRunPaths(runRoot, {
      ...base,
      fixture: { path: join(runRoot, "..", "outside-fixture"), startingSha: "a".repeat(40), startingStatus: "" },
      product: { home: join(runRoot, "product-home"), entrypoint: "morrow", packaged: true, version: "v", taskId: null, exitCode: null },
    })).toThrow(/outside/i);
    expect(() => validateAcceptanceRunPaths(runRoot, {
      ...base,
      fixture: { path: join(runRoot, "fixture"), startingSha: "a".repeat(40), startingStatus: "" },
      product: { home: join(runRoot, "..", "outside-home"), entrypoint: "morrow", packaged: true, version: "v", taskId: null, exitCode: null },
    })).toThrow(/outside/i);
  });

  it("persists step boundaries, invokes consumer commands, and produces a PASS report", { timeout: 20_000 }, async () => {
    const acceptanceRoot = root();
    const calls: string[][] = [];
    const result = await runAcceptance({
      acceptanceRoot, runId: "run-20260716-10000001", executable: "node", entrypoint: "compiled-morrow.mjs",
      packaged: true, version: "0.1.0-test", sourceCwd: process.cwd(), port: 45124, invoke: successfulInvoker(calls),
      intendedSourceCommit: TEST_PACKAGE_COMMIT,
    });
    expect(result.state.disposition).toBe("PASS");
    expect(result.state.lifecycle).toBe("completed");
    expect(calls.map((args) => args[0])).toEqual(["provenance", "init", "ask", "audit", "stop"]);
    expect(calls[2]).toContain("Read evidence.txt and report the foundation marker.");
    expect(calls[3]).toEqual(["audit", "show", "task-1", "--json", "--no-color", "--quiet"]);
    const report = JSON.parse(readFileSync(result.reportJson, "utf8"));
    expect(report.disposition).toBe("PASS");
    expect(report.fixture.startingSha).toMatch(/^[0-9a-f]{40}$/);
    expect(report.product).toMatchObject({ packaged: true, taskId: "task-1", exitCode: 0 });
    expect(report.evidence.some((entry: { step: string }) => entry.step === "product-persistence")).toBe(true);
    expect(existsSync(join(acceptanceRoot, result.state.runId, "fixture"))).toBe(false);
    expect(existsSync(join(acceptanceRoot, result.state.runId, "product-home"))).toBe(false);
  });

  it("resumes an interrupted product step once and terminal resume only regenerates reports", { timeout: 20_000 }, async () => {
    const acceptanceRoot = root();
    const calls: string[][] = [];
    let interrupted = true;
    const invoke: AcceptanceInvocation = async (args, options) => {
      if (interrupted && args[0] === "ask") {
        interrupted = false;
        throw new Error("simulated process interruption");
      }
      return successfulInvoker(calls)(args, options);
    };
    await expect(runAcceptance({
      acceptanceRoot, runId: "run-20260716-10000002", executable: "node", entrypoint: "compiled-morrow.mjs",
      packaged: true, version: "0.1.0-test", sourceCwd: process.cwd(), port: 45125, invoke, simulateAbruptInterruption: true,
      intendedSourceCommit: TEST_PACKAGE_COMMIT,
    })).rejects.toThrow(/simulated process interruption/);
    const store = new AcceptanceStore(acceptanceRoot);
    expect(store.load("run-20260716-10000002")).toMatchObject({ lifecycle: "running", activeStep: "product" });

    const resumed = await resumeAcceptance("run-20260716-10000002", {
      acceptanceRoot, executable: "node", entrypoint: "compiled-morrow.mjs", packaged: true,
      version: "0.1.0-test", sourceCwd: process.cwd(), port: 45125, invoke: successfulInvoker(calls),
      intendedSourceCommit: TEST_PACKAGE_COMMIT,
    });
    expect(resumed.state.disposition).toBe("PASS");
    expect(resumed.state.recoveryCount).toBe(1);
    const callCount = calls.length;
    const terminal = await resumeAcceptance("run-20260716-10000002", {
      acceptanceRoot, executable: "node", entrypoint: "compiled-morrow.mjs", packaged: true,
      version: "0.1.0-test", sourceCwd: process.cwd(), port: 45125,
      intendedSourceCommit: TEST_PACKAGE_COMMIT,
      invoke: async () => { throw new Error("terminal resume replayed product work"); },
    });
    expect(terminal.state.disposition).toBe("PASS");
    expect(calls).toHaveLength(callCount);
  });
});

describe("package provenance gate", () => {
  it("rejects a package whose embedded commit does not match the intended source commit", async () => {
    const acceptanceRoot = root();
    const calls: string[][] = [];
    const invoke = successfulInvoker(calls);
    const result = await runAcceptance({
      acceptanceRoot, runId: "run-20260716-10000010", executable: "node", entrypoint: "compiled-morrow.mjs",
      packaged: true, version: "0.1.0-test", sourceCwd: process.cwd(), port: 45126, invoke,
      // A different commit than the one the mocked "provenance" command reports:
      // this models a stale, un-rebuilt package.
      intendedSourceCommit: "b".repeat(40),
    });
    expect(result.state.disposition).not.toBe("PASS");
    expect(result.state.checks.package_provenance?.status).toBe("failed");
    expect(result.state.message).toMatch(/stale package/i);
    // The stale package must never reach product invocation.
    expect(calls.map((args) => args[0])).not.toContain("init");
    expect(calls.map((args) => args[0])).not.toContain("ask");
  });

  it("rejects a package built from a dirty worktree unless explicitly permitted", async () => {
    const acceptanceRoot = root();
    const calls: string[][] = [];
    const dirtyInvoke: AcceptanceInvocation = async (args) => {
      calls.push(args);
      if (args[0] === "provenance") return {
        exitCode: 0,
        stdout: JSON.stringify({
          packaged: true,
          provenance: {
            schemaVersion: 1, version: "0.1.0-test", sourceCommit: TEST_PACKAGE_COMMIT, dirty: true,
            buildTimestamp: "2026-07-16T00:00:00.000Z", schemaCatalogVersion: 1, manifestHash: "c".repeat(64),
          },
        }),
        stderr: "",
      };
      throw new Error(`Unexpected invocation: ${args.join(" ")}`);
    };
    const result = await runAcceptance({
      acceptanceRoot, runId: "run-20260716-10000011", executable: "node", entrypoint: "compiled-morrow.mjs",
      packaged: true, version: "0.1.0-test", sourceCwd: process.cwd(), port: 45127, invoke: dirtyInvoke,
      intendedSourceCommit: TEST_PACKAGE_COMMIT,
    });
    expect(result.state.disposition).not.toBe("PASS");
    expect(result.state.checks.package_provenance?.status).toBe("failed");
    expect(result.state.message).toMatch(/dirty/i);
  });

  it("passes and records the verified hash when the rebuilt package's commit matches", async () => {
    const acceptanceRoot = root();
    const calls: string[][] = [];
    const result = await runAcceptance({
      acceptanceRoot, runId: "run-20260716-10000012", executable: "node", entrypoint: "compiled-morrow.mjs",
      packaged: true, version: "0.1.0-test", sourceCwd: process.cwd(), port: 45128, invoke: successfulInvoker(calls),
      intendedSourceCommit: TEST_PACKAGE_COMMIT,
    });
    expect(result.state.disposition).toBe("PASS");
    expect(result.state.provenance).toMatchObject({
      packaged: true, sourceCommit: TEST_PACKAGE_COMMIT, dirty: false, matchesIntendedCommit: true,
    });
    const report = JSON.parse(readFileSync(result.reportJson, "utf8"));
    expect(report.provenance.manifestHash).toBe("f".repeat(64));
    expect(report.checks.package_provenance.status).toBe("passed");
  });
});
