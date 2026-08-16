/**
 * Guards the benchmark itself: a task is only evidence about a model if its
 * fixture is deterministic, starts in a genuinely unsolved state, and is
 * actually solvable by a correct answer.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { BENCHMARK_TASKS, findTask } from "../benchmark/tasks.js";

function fingerprint(dir: string): string[] {
  const walk = (current: string): string[] =>
    readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name === "node_modules") return [];
      const full = join(current, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!statSync(full).isFile()) return [];
      return [`${relative(dir, full)}:${createHash("sha256").update(readFileSync(full)).digest("hex").slice(0, 16)}`];
    });
  return walk(dir).sort();
}

function workspace(): string {
  return mkdtempSync(join(tmpdir(), "morrow-bench-fixture-"));
}

describe("Morrow Harness Benchmark v1 fixtures", () => {
  it("exposes ten distinct tasks addressable by letter and id", () => {
    expect(BENCHMARK_TASKS).toHaveLength(10);
    expect(new Set(BENCHMARK_TASKS.map((task) => task.id)).size).toBe(10);
    expect(BENCHMARK_TASKS.map((task) => task.letter)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]);
    expect(findTask("A")?.id).toBe("missing-assets-website");
    expect(findTask("longer-autonomy")?.letter).toBe("J");
  });

  it.each(BENCHMARK_TASKS.map((task) => [task.letter, task] as const))(
    "%s produces a deterministic, resettable fixture",
    (_letter, task) => {
      const first = workspace();
      const second = workspace();
      try {
        task.fixture(first);
        task.fixture(second);
        expect(fingerprint(first)).toEqual(fingerprint(second));
      } finally {
        rmSync(first, { recursive: true, force: true });
        rmSync(second, { recursive: true, force: true });
      }
    },
  );

  it.each(BENCHMARK_TASKS.map((task) => [task.letter, task] as const))(
    "%s starts unsolved so a passing run is real evidence",
    async (_letter, task) => {
      const dir = workspace();
      try {
        task.fixture(dir);
        const verification = await task.verify({ workspace: dir, toolCalls: [] });
        expect(verification.ok).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    120_000,
  );

  // Reference solutions prove each verifier is satisfiable. They are only used
  // here; no benchmark run ever sees them.
  const solutions: Record<string, (dir: string) => void> = {
    C: (dir) => {
      writeFileSync(join(dir, "src/invoice.ts"), readFileSync(join(dir, "src/invoice.ts"), "utf8")
        .replace("taxRate: string;", "taxRate: number;")
        .replace("return discounted + Math.round(subtotal * invoice.taxRate);", "return discounted + Math.round(discounted * invoice.taxRate);"));
    },
    F: (dir) => {
      writeFileSync(join(dir, "src/text.mjs"), readFileSync(join(dir, "src/text.mjs"), "utf8").replace("value.slice(0, limit - 1)", "value.slice(0, limit)"));
    },
    H: (dir) => {
      const source = readFileSync(join(dir, "src/config.mjs"), "utf8");
      writeFileSync(join(dir, "src/config.mjs"), source.replace(/network: \{\n    maxAttempts: 3,/, "network: {\n    maxAttempts: 5,"));
    },
    I: (dir) => {
      writeFileSync(join(dir, "lib/domain/money/registry.mjs"), readFileSync(join(dir, "lib/domain/money/registry.mjs"), "utf8")
        .replace('GBP: { symbol: "£", decimals: 2 },', 'GBP: { symbol: "£", decimals: 2 },\n  JPY: { symbol: "¥", decimals: 0 },'));
    },
  };

  it.each(Object.keys(solutions))("%s is solvable by a correct fix", async (letter) => {
    const task = findTask(letter);
    expect(task).toBeDefined();
    const dir = workspace();
    try {
      task!.fixture(dir);
      solutions[letter]!(dir);
      const verification = await task!.verify({ workspace: dir, toolCalls: [] });
      const failed = verification.steps.filter((entry) => !entry.ok).map((entry) => `${entry.name}: ${entry.detail}`);
      expect(failed).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
