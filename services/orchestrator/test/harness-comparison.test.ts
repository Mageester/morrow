import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = resolve(process.cwd(), "../..");
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("harness comparison release seams", () => {
  it("writes a report successfully when --out is provided", () => {
    const input = mkdtempSync(join(tmpdir(), "morrow-report-input-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "morrow-report-output-"));
    temporaryRoots.push(input, outputRoot);
    const output = join(outputRoot, "report.md");
    const run = {
      harness: "morrow",
      taskId: "test-report",
      category: "build",
      model: "mock-model",
      passed: true,
      claimedSuccess: true,
      failureDetail: null,
      durationMs: 100,
      timedOut: false,
      inputTokens: 10,
      cachedInputTokens: null,
      outputTokens: 5,
      firstTurnInputTokens: 10,
      requestTokens: [[10, null]],
      measuredCostUsd: null,
      providerCalls: 1,
      toolCalls: 0,
      harnessError: null,
    };
    writeFileSync(join(input, "runs.jsonl"), `${JSON.stringify(run)}\n`);

    const stdout = execFileSync(
      "pnpm",
      ["--filter", "@morrow/orchestrator", "exec", "tsx", join(repositoryRoot, "benchmarks/harness-comparison/report.ts"), "--input", input, "--out", output],
      { cwd: repositoryRoot, encoding: "utf8" },
    );

    expect(existsSync(output)).toBe(true);
    expect(stdout).toContain("wrote");
    expect(stdout).toContain("1 run(s)");
  });

  it("removes the per-run database and home directories after a run", async () => {
    const taskId = `cleanup-${randomUUID()}`;
    const workspace = mkdtempSync(join(tmpdir(), "morrow-benchmark-workspace-"));
    temporaryRoots.push(workspace);
    writeFileSync(join(workspace, "evidence.txt"), "benchmark evidence\n");
    const runPrefix = `morrow-run-${taskId}-`;
    const homePrefix = `morrow-home-${taskId}-`;
    const previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";

    try {
      const adapterScript = join(workspace, "run-adapter.ts");
      writeFileSync(adapterScript, [
        `import { createMorrowAdapter } from ${JSON.stringify(join(repositoryRoot, "benchmarks/harness-comparison/morrow-adapter.ts"))};`,
        "void (async () => {",
        `  const result = await createMorrowAdapter({ providerId: "mock" }).run(${JSON.stringify({ taskId, category: "build", prompt: "Inspect evidence.txt and summarize it.", workspace, model: "mock-model", timeoutMs: 5_000 })});`,
        "  console.log(JSON.stringify({ harness: result.harness }));",
        "})();",
      ].join("\n"));
      const stdout = execFileSync(
        "pnpm",
        ["--filter", "@morrow/orchestrator", "exec", "tsx", adapterScript],
        { cwd: repositoryRoot, encoding: "utf8", env: { ...process.env, MOCK_PROVIDER: "true" } },
      );

      expect(stdout).toContain('"harness":"morrow"');
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith(runPrefix))).toEqual([]);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith(homePrefix))).toEqual([]);
    } finally {
      if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
      else process.env.MOCK_PROVIDER = previousMockProvider;
    }
  });
});
