import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TASKS, type EvalTask } from "./tasks.js";
import { writeFixture } from "./fixture.js";
import { verifyTask } from "./verify.js";
import { createMorrowAdapter } from "./morrow-adapter.js";
import { createPiAdapter } from "./pi-adapter.js";
import type { HarnessAdapter, HarnessRunResult } from "./harness.js";

/**
 * The cross-harness comparison runner.
 *
 * Same tasks, same prompts, same model, same wall-clock ceiling, one fresh
 * workspace per harness per task. Results stream to JSONL as they land so a
 * run that dies halfway still leaves usable evidence.
 *
 *   pnpm --filter @morrow/orchestrator exec tsx ../../benchmarks/harness-comparison/run.ts \
 *     --harnesses morrow,pi --out benchmarks/harness-comparison/results
 */

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const MODEL = flag("model") ?? process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash";
const TIMEOUT_MS = Number(flag("timeout") ?? 8 * 60 * 1000);
/**
 * Locate the repository root by walking up for the workspace manifest, so the
 * default output path does not depend on which package the runner was launched
 * from. tsx transpiles this file to CommonJS, where `import.meta` is unavailable.
 */
function repositoryRoot(): string {
  let current = process.cwd();
  while (!existsSync(join(current, "pnpm-workspace.yaml"))) {
    const parent = dirname(current);
    if (parent === current) throw new Error("Could not locate the repository root from " + process.cwd());
    current = parent;
  }
  return current;
}

const OUT_DIR = resolve(flag("out") ?? join(repositoryRoot(), "benchmarks", "harness-comparison", "results"));
const REPEATS = Number(flag("repeats") ?? 1);
const ONLY = flag("tasks")?.split(",").map((id) => id.trim()).filter(Boolean);
const HARNESSES = (flag("harnesses") ?? "morrow,pi").split(",").map((name) => name.trim()).filter(Boolean);

function buildAdapters(): HarnessAdapter[] {
  const adapters: HarnessAdapter[] = [];
  for (const name of HARNESSES) {
    if (name === "morrow") {
      adapters.push(createMorrowAdapter({ providerId: "deepseek" }));
    } else if (name === "pi") {
      const binary = process.env.PI_BINARY;
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (!binary) throw new Error("PI_BINARY must point at the pi executable to run the pi harness");
      if (!apiKey) throw new Error("DEEPSEEK_API_KEY must be set to run the pi harness");
      adapters.push(createPiAdapter({ binary, apiKey }));
    } else {
      throw new Error(`Unknown harness "${name}". Known: morrow, pi`);
    }
  }
  return adapters;
}

async function runOne(adapter: HarnessAdapter, task: EvalTask, repeat: number): Promise<HarnessRunResult> {
  const workspace = mkdtempSync(join(tmpdir(), `bench-${adapter.name}-${task.id}-`));
  try {
    writeFixture(workspace, task.files);
    const measured = await adapter.run({
      taskId: task.id,
      category: task.category,
      prompt: task.prompt,
      workspace,
      model: MODEL,
      timeoutMs: TIMEOUT_MS,
    });
    const verification = verifyTask(task, workspace);
    return { ...measured, passed: verification.passed, failureDetail: verification.passed ? null : verification.detail };
  } catch (error) {
    return {
      harness: adapter.name, taskId: task.id, category: task.category, model: MODEL,
      passed: false, claimedSuccess: false,
      failureDetail: null,
      durationMs: 0, timedOut: false,
      inputTokens: null, cachedInputTokens: null, outputTokens: null, firstTurnInputTokens: null, requestTokens: null, measuredCostUsd: null,
      providerCalls: null, toolCalls: null,
      harnessError: error instanceof Error ? error.message : String(error),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    void repeat;
  }
}

async function main(): Promise<void> {
  const adapters = buildAdapters();
  const tasks = ONLY ? TASKS.filter((task) => ONLY.includes(task.id)) : TASKS;
  if (tasks.length === 0) throw new Error("No tasks selected");

  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const evidencePath = join(OUT_DIR, `runs-${stamp}.jsonl`);
  const results: HarnessRunResult[] = [];

  console.log(`model ${MODEL} · ${tasks.length} task(s) · ${adapters.length} harness(es) · ${REPEATS} repeat(s) · ceiling ${Math.round(TIMEOUT_MS / 1000)}s`);
  console.log(`evidence ${evidencePath}\n`);

  for (let repeat = 1; repeat <= REPEATS; repeat++) {
    for (const task of tasks) {
      for (const adapter of adapters) {
        process.stdout.write(`${adapter.name.padEnd(7)} ${task.id.padEnd(24)} `);
        const result = await runOne(adapter, task, repeat);
        results.push(result);
        appendFileSync(evidencePath, `${JSON.stringify({ ...result, repeat, startedAt: new Date().toISOString() })}\n`);
        const verdict = result.harnessError ? "ERROR " : result.passed ? "PASS  " : "fail  ";
        const cost = result.measuredCostUsd === null ? "     ?" : `$${result.measuredCostUsd.toFixed(4)}`;
        console.log(
          `${verdict} ${String(Math.round(result.durationMs / 1000)).padStart(4)}s ` +
          `${String(result.providerCalls ?? "?").padStart(3)} turns ${cost}` +
          `${result.timedOut ? " TIMEOUT" : ""}${result.harnessError ? ` — ${result.harnessError.slice(0, 90)}` : ""}` +
          `${!result.passed && !result.harnessError && result.failureDetail ? ` — ${result.failureDetail.slice(0, 90)}` : ""}`,
        );
      }
    }
  }

  writeFileSync(join(OUT_DIR, `runs-${stamp}.json`), `${JSON.stringify(results, null, 2)}\n`);
  console.log(`\n${results.length} run(s) recorded.`);
  for (const adapter of adapters) {
    const own = results.filter((result) => result.harness === adapter.name && !result.harnessError);
    const passed = own.filter((result) => result.passed).length;
    console.log(`${adapter.name}: ${passed}/${own.length} passed (${results.filter((r) => r.harness === adapter.name && r.harnessError).length} excluded as harness errors)`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
