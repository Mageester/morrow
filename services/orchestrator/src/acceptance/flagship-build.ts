import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runFlagshipScenario, type FlagshipRun, type FlagshipRunInput } from "./flagship-runner.js";

export const FLAGSHIP_BUILD_SCENARIO_ID = "flagship-build-v1";

export const FLAGSHIP_BUILD_PROMPT = [
  "Build a small working command-line task list app in this workspace.",
  "",
  "Create a single file `app.mjs` (Node.js, ESM, no dependencies) that stores tasks in `tasks.json` in the current working directory and supports exactly these commands:",
  "",
  '  node app.mjs add "<text>"   -> appends a task and prints: added: <text>',
  "  node app.mjs list           -> prints one line per task, in order, as: <n>. [ ] <text>   (or [x] when done), and prints exactly `no tasks` when there are none",
  "  node app.mjs done <n>       -> marks task number <n> (1-based) done and prints: done: <text>",
  "",
  "Rules: `tasks.json` must be created on first write and must survive between runs. An unknown command or an out-of-range number must print an error to stderr and exit with a non-zero code. A valid command must exit 0.",
  "",
  "When the app is written, run it yourself to confirm each command behaves as specified, then finish.",
].join("\n");

export type { FlagshipFailureReason } from "./flagship-runner.js";
export type FlagshipBuildRun = FlagshipRun;
export interface FlagshipBuildInput extends FlagshipRunInput {}

interface ContractStep {
  label: string;
  args: string[];
  expectStdout?: RegExp;
  expectExitZero: boolean;
}

const CONTRACT: ContractStep[] = [
  { label: "empty list", args: ["list"], expectStdout: /^\s*no tasks\s*$/i, expectExitZero: true },
  { label: "add first", args: ["add", "buy milk"], expectStdout: /added:\s*buy milk/i, expectExitZero: true },
  { label: "add second", args: ["add", "write tests"], expectStdout: /added:\s*write tests/i, expectExitZero: true },
  { label: "list both, in order, undone", args: ["list"], expectStdout: /1\.\s*\[ \]\s*buy milk[\s\S]*2\.\s*\[ \]\s*write tests/i, expectExitZero: true },
  { label: "complete first", args: ["done", "1"], expectStdout: /done:\s*buy milk/i, expectExitZero: true },
  { label: "completion persists and is visible", args: ["list"], expectStdout: /1\.\s*\[x\]\s*buy milk[\s\S]*2\.\s*\[ \]\s*write tests/i, expectExitZero: true },
  { label: "out-of-range index fails loudly", args: ["done", "99"], expectExitZero: false },
  { label: "unknown command fails loudly", args: ["frobnicate"], expectExitZero: false },
];

export function verifyFlagshipArtifact(
  workspace: string,
  runDir: string,
): { ok: true } | { ok: false; reason: import("./flagship-runner.js").FlagshipFailureReason; detail: string } {
  const appPath = join(workspace, "app.mjs");
  if (!existsSync(appPath)) return { ok: false, reason: "artifact_missing", detail: "app.mjs was never written" };

  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "app.mjs"), readFileSync(appPath));
  for (const step of CONTRACT) {
    const result = spawnSync(process.execPath, ["app.mjs", ...step.args], {
      cwd: runDir,
      encoding: "utf8",
      timeout: 15_000,
      env: { PATH: process.env.PATH ?? "" },
    });
    if (result.error) {
      return { ok: false, reason: "artifact_does_not_run", detail: `"${step.label}" could not be executed: ${result.error.message}` };
    }
    const exitedZero = result.status === 0;
    if (exitedZero !== step.expectExitZero) {
      return { ok: false, reason: "contract_violated", detail: `"${step.label}" exited ${result.status} (expected ${step.expectExitZero ? "0" : "non-zero"})` };
    }
    if (step.expectStdout && !step.expectStdout.test(result.stdout ?? "")) {
      return { ok: false, reason: "contract_violated", detail: `"${step.label}" printed ${JSON.stringify((result.stdout ?? "").trim().slice(0, 120))}, which does not match ${step.expectStdout}` };
    }
  }
  return { ok: true };
}

export async function runFlagshipBuild(input: FlagshipBuildInput): Promise<FlagshipBuildRun> {
  return runFlagshipScenario({
    ...input,
    scenarioId: FLAGSHIP_BUILD_SCENARIO_ID,
    prompt: FLAGSHIP_BUILD_PROMPT,
    projectName: "Flagship build",
    verify: ({ workspace }) => {
      const verification = verifyFlagshipArtifact(workspace, join(input.root, "verify"));
      if (!verification.ok) return verification;
      return {
        ok: true as const,
        artifactSha256: createHash("sha256").update(readFileSync(join(workspace, "app.mjs"))).digest("hex"),
      };
    },
  });
}
