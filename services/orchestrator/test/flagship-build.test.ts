import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FLAGSHIP_BUILD_PROMPT,
  runFlagshipBuild,
  verifyFlagshipArtifact,
} from "../src/acceptance/flagship-build.js";
import {
  appendFlagshipRun,
  evaluateFlagshipGate,
  readFlagshipLog,
  FLAGSHIP_GATE_MIN_PASSES,
  FLAGSHIP_GATE_MIN_RUNS,
} from "../src/acceptance/flagship-gate.js";
import type { FlagshipBuildRun } from "../src/acceptance/flagship-build.js";
import type { AiProvider, ChatMessage, ProviderChunk, StreamOptions, ToolCall } from "../src/provider/base.js";

/**
 * These tests prove the flagship HARNESS — that the scenario runs end to end,
 * that its verifier accepts a correct app and rejects an incorrect one, and
 * that the release gate scores a log the way it claims to.
 *
 * They deliberately prove nothing about any model. That is the whole point of
 * the flagship workflow: the mock suite has always been green, and every
 * provider defect Morrow shipped passed it. Real-model evidence lives in
 * docs/evidence/flagship-runs.jsonl and is produced by test/live.
 */

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "morrow-flagship-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

/** A correct implementation of the contract stated in the prompt. */
const CORRECT_APP = `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const FILE = "tasks.json";
const load = () => (existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : []);
const save = (tasks) => writeFileSync(FILE, JSON.stringify(tasks, null, 2));
const [command, ...rest] = process.argv.slice(2);
const tasks = load();
if (command === "add") {
  const text = rest.join(" ");
  if (!text) { console.error("add requires text"); process.exit(1); }
  tasks.push({ text, done: false });
  save(tasks);
  console.log(\`added: \${text}\`);
} else if (command === "list") {
  if (tasks.length === 0) console.log("no tasks");
  else tasks.forEach((task, i) => console.log(\`\${i + 1}. [\${task.done ? "x" : " "}] \${task.text}\`));
} else if (command === "done") {
  const index = Number(rest[0]);
  if (!Number.isInteger(index) || index < 1 || index > tasks.length) { console.error("no such task"); process.exit(1); }
  tasks[index - 1].done = true;
  save(tasks);
  console.log(\`done: \${tasks[index - 1].text}\`);
} else {
  console.error(\`unknown command: \${command ?? ""}\`);
  process.exit(1);
}
`;

const done: ProviderChunk = { type: "done", finishReason: "stop" };
const tool = (id: string, index: number, name: string, args: unknown): ToolCall => ({
  id, index, type: "function", function: { name, arguments: JSON.stringify(args) },
});

/** Replays a fixed sequence of turns. Stands in for a model, nothing more. */
class ScriptedProvider implements AiProvider {
  readonly id = "openai" as const;
  private turn = 0;
  constructor(private readonly turns: ProviderChunk[][]) {}
  async *streamChat(_messages: ChatMessage[], _options: StreamOptions): AsyncIterable<ProviderChunk> {
    for (const chunk of this.turns[this.turn++] ?? [{ type: "text", text: "Done." }, done]) yield chunk;
  }
}

function writeAppTurns(content: string): ProviderChunk[][] {
  return [
    [{ type: "tool_call", toolCalls: [tool("flagship-write", 0, "create_file", { path: "app.mjs", content, purpose: "Create the task list app" })] } as ProviderChunk, done],
    [{ type: "tool_call", toolCalls: [tool("flagship-syntax", 0, "run_command", { executable: "node", args: ["--check", "app.mjs"], purpose: "Verify app syntax" })] } as ProviderChunk, done],
    [{ type: "tool_call", toolCalls: [tool("flagship-behavior", 0, "run_command", { executable: "node", args: ["app.mjs", "list"], purpose: "Verify CLI behavior" })] } as ProviderChunk, done],
    [{ type: "text", text: "Built app.mjs with add, list, and done, and verified each command." }, done],
  ];
}

describe("flagship build scenario", () => {
  it("states the behavioral contract it will be scored against", () => {
    // A prompt vague about the contract would only move the failure from "the
    // app does not work" to "we cannot tell whether it works".
    for (const clause of ["app.mjs", "tasks.json", "add", "list", "done", "no tasks", "non-zero"]) {
      expect(FLAGSHIP_BUILD_PROMPT).toContain(clause);
    }
  });

  it("passes a run whose app satisfies the contract", async () => {
    const run = await runFlagshipBuild({
      root: scratch(),
      providerId: "openai",
      model: "scripted-correct",
      provider: new ScriptedProvider(writeAppTurns(CORRECT_APP)),
    });
    expect(run.failureDetail).toBeNull();
    expect(run.passed).toBe(true);
    expect(run.mode).toBe("mock");
    expect(run.taskStatus).toBe("completed");
    expect(run.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
  }, 60_000);

  it("fails a run that never wrote the app", async () => {
    const run = await runFlagshipBuild({
      root: scratch(),
      providerId: "openai",
      model: "scripted-empty",
      provider: new ScriptedProvider([[{ type: "text", text: "I have finished the task." }, done]]),
    });
    expect(run.passed).toBe(false);
    expect(run.failureReason).toBe("artifact_missing");
  }, 60_000);

  it("fails a run whose app is written but does not behave as specified", async () => {
    // The failure a model-written test would most easily hide: it runs, it
    // exits 0, and it is wrong.
    const plausibleButWrong = CORRECT_APP.replace('console.log("no tasks")', 'console.log("")');
    const run = await runFlagshipBuild({
      root: scratch(),
      providerId: "openai",
      model: "scripted-wrong",
      provider: new ScriptedProvider(writeAppTurns(plausibleButWrong)),
    });
    expect(run.passed).toBe(false);
    expect(run.failureReason).toBe("contract_violated");
    expect(run.failureDetail).toContain("empty list");
  }, 60_000);
});

describe("flagship artifact verification", () => {
  const verifyWith = (content: string) => {
    const root = scratch();
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "app.mjs"), content);
    return verifyFlagshipArtifact(workspace, join(root, "verify"));
  };

  it("accepts a correct app", () => {
    expect(verifyWith(CORRECT_APP)).toEqual({ ok: true });
  });

  it("rejects an app that ignores persistence", () => {
    const result = verifyWith(CORRECT_APP.replace("save(tasks);\n  console.log(`done:", "console.log(`done:"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("contract_violated");
  });

  it("rejects an app that exits zero on an invalid command", () => {
    const result = verifyWith(CORRECT_APP.replace('console.error(`unknown command: ${command ?? ""}`);\n  process.exit(1);', 'console.log("ok");'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("contract_violated");
  });

  it("rejects an app that cannot be executed at all", () => {
    const result = verifyWith("this is not javascript {{{");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("contract_violated");
  });

  it("reports a missing artifact distinctly from a broken one", () => {
    const root = scratch();
    mkdirSync(join(root, "workspace"), { recursive: true });
    const result = verifyFlagshipArtifact(join(root, "workspace"), join(root, "verify"));
    expect(result).toMatchObject({ ok: false, reason: "artifact_missing" });
  });

  it("verifies in a clean directory, so a run cannot inherit the previous run's state", () => {
    // The agent's workspace may contain a tasks.json left over from the model
    // exercising its own app. Scoring against that would let "empty list"
    // pass for the wrong reason.
    const root = scratch();
    const workspace = join(root, "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "app.mjs"), CORRECT_APP);
    writeFileSync(join(workspace, "tasks.json"), JSON.stringify([{ text: "left over", done: true }]));
    expect(verifyFlagshipArtifact(workspace, join(root, "verify"))).toEqual({ ok: true });
  });
});

describe("flagship release gate", () => {
  const run = (providerId: string, passed: boolean, mode: "real" | "mock" = "real"): FlagshipBuildRun => ({
    scenarioId: "flagship-build-v1",
    runId: `${providerId}-${Math.random().toString(36).slice(2)}`,
    startedAt: new Date().toISOString(),
    mode,
    providerId,
    model: `${providerId}-model`,
    passed,
    failureReason: passed ? null : "contract_violated",
    failureDetail: null,
    taskStatus: passed ? "completed" : "interrupted",
    toolCalls: 3,
    promptTokens: 100,
    completionTokens: 200,
    wallClockMs: 1000,
    artifactSha256: null,
  });

  const window = (providerId: string, passes: number, total = FLAGSHIP_GATE_MIN_RUNS) =>
    Array.from({ length: total }, (_, i) => run(providerId, i < passes));

  it("passes only when two providers each clear 9/10", () => {
    const result = evaluateFlagshipGate([
      ...window("anthropic", FLAGSHIP_GATE_MIN_PASSES),
      ...window("gemini", FLAGSHIP_GATE_MIN_RUNS),
    ]);
    expect(result.passed).toBe(true);
    expect(result.summary).toContain("proven");
  });

  it("fails when only one provider clears the bar", () => {
    const result = evaluateFlagshipGate([
      ...window("anthropic", FLAGSHIP_GATE_MIN_RUNS),
      ...window("gemini", 5),
    ]);
    expect(result.passed).toBe(false);
    expect(result.providers.find((p) => p.providerId === "gemini")?.qualified).toBe(false);
  });

  it("fails on too few runs rather than extrapolating from a short streak", () => {
    const result = evaluateFlagshipGate([...window("anthropic", 3, 3), ...window("gemini", 3, 3)]);
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("needs 7 more run(s)");
  });

  it("scores only the most recent window, so old passes cannot dilute a present regression", () => {
    const result = evaluateFlagshipGate([
      ...window("anthropic", FLAGSHIP_GATE_MIN_RUNS),
      ...window("anthropic", 2),
      ...window("gemini", FLAGSHIP_GATE_MIN_RUNS),
    ]);
    expect(result.passed).toBe(false);
    expect(result.providers.find((p) => p.providerId === "anthropic")?.passes).toBe(2);
  });

  it("never counts a mock run, and says how many it excluded", () => {
    const result = evaluateFlagshipGate([
      ...window("anthropic", FLAGSHIP_GATE_MIN_RUNS).map((r) => ({ ...r, mode: "mock" as const })),
      ...window("gemini", FLAGSHIP_GATE_MIN_RUNS).map((r) => ({ ...r, mode: "mock" as const })),
    ]);
    expect(result.passed).toBe(false);
    expect(result.excluded.mockRuns).toBe(FLAGSHIP_GATE_MIN_RUNS * 2);
    expect(result.summary).toContain("no real-provider runs");
  });

  it("reports the failure reasons behind a short window, not just the count", () => {
    const runs = window("anthropic", 8);
    runs[9] = { ...runs[9]!, failureReason: "task_not_completed" };
    const result = evaluateFlagshipGate(runs);
    expect(result.providers[0]!.failureReasons).toEqual(["contract_violated", "task_not_completed"]);
  });

  it("round-trips the append-only log and rejects a corrupted line", () => {
    const path = join(scratch(), "evidence", "runs.jsonl");
    expect(readFlagshipLog(path)).toEqual([]);
    const first = run("anthropic", true);
    appendFlagshipRun(path, first);
    appendFlagshipRun(path, run("gemini", false));
    expect(readFlagshipLog(path)).toHaveLength(2);
    expect(readFlagshipLog(path)[0]).toEqual(first);

    writeFileSync(path, "{ not json\n", { flag: "a" });
    expect(() => readFlagshipLog(path)).toThrow(/append-only/);
  });
});
