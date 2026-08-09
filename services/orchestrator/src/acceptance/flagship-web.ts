import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { BrowserController, PageSnapshot } from "../browser/types.js";
import { playwrightController, resolvePlaywrightChannel } from "../browser/playwright.js";
import { runVerification, type EvidenceOutcome } from "../mission/evidence-runner.js";
import { runProcessSafe } from "../tools/command-executor.js";
import { processesRepository } from "../repositories/processes.js";
import { runFlagshipScenario, type FlagshipFailureReason, type FlagshipRun, type FlagshipRunInput } from "./flagship-runner.js";

export const FLAGSHIP_WEB_SCENARIO_ID = "flagship-web-v1";

export const FLAGSHIP_WEB_PROMPT = [
  "Build a small working multi-file frontend in this workspace.",
  "",
  "Create `package.json`, `index.html`, `styles.css`, `app.js`, `server.mjs`, `scripts/test-runner.mjs`, and `tests/acceptance check.test.mjs`.",
  "The page must be titled `Flagship Task Board`, show an initial `0 tasks` count, and provide an `Add sample task` button that appends `Verify Morrow` and updates the count.",
  "Include a responsive mobile media query in `styles.css` and serve the files from loopback only.",
  "In `server.mjs`, wait for stdin to reach EOF before listening; after EOF, listen and keep serving until terminated. Do not treat stdin EOF as a shutdown signal.",
  "",
  "Required package scripts:",
  "  start: node server.mjs --port 0",
  '  test: node scripts/test-runner.mjs "tests/acceptance check.test.mjs"',
  "The test runner is watch-capable: without CI=true it stays open; with CI=true it runs once. It must ignore pnpm's forwarded literal `--` separator and then require the quoted argument `flagship web verification`.",
  "",
  'Run the test in foreground as: pnpm test -- "flagship web verification". The harness supplies CI=true, so this invocation exits after one run.',
  "Start the dev server using the command tool in background mode, inspect the printed loopback URL, verify the page, then stop the background process before finishing.",
].join("\n");

const REQUIRED_FILES = [
  "package.json",
  "index.html",
  "styles.css",
  "app.js",
  "server.mjs",
  "scripts/test-runner.mjs",
  "tests/acceptance check.test.mjs",
] as const;

const PACKAGE_MANAGER_START_FORMS: Record<string, readonly (readonly string[])[]> = {
  pnpm: [["start"], ["run", "start"]],
  npm: [["start"], ["run", "start"]],
  yarn: [["start"], ["run", "start"]],
};

export function isDeclaredServerCommand(command: string, args: string[], declaredStart: string): boolean {
  if (declaredStart.length === 0) return false;
  if ([command, ...args].join(" ") === declaredStart) return true;

  return PACKAGE_MANAGER_START_FORMS[command]?.some((form) =>
    form.length === args.length && form.every((value, index) => value === args[index]),
  ) ?? false;
}

export interface FlagshipWebVerificationOutcomes {
  generatedTest: EvidenceOutcome;
  hiddenTest: EvidenceOutcome;
  diff: EvidenceOutcome;
  browser: EvidenceOutcome;
}

export type FlagshipWebVerificationResult =
  | { ok: true; artifactSha256: string; outcomes: FlagshipWebVerificationOutcomes }
  | { ok: false; reason: FlagshipFailureReason; detail: string; outcomes?: Partial<FlagshipWebVerificationOutcomes> };

export interface FlagshipWebInput extends FlagshipRunInput {
  /** Test seam for the one production RunOptions dependency. */
  browser?: () => BrowserController;
}

export async function initializeFlagshipWebWorkspace(workspace: string): Promise<void> {
  mkdirSync(workspace, { recursive: true });
  const result = await runProcessSafe("git", ["init", "--quiet"], workspace, process.env, { timeoutMs: 30_000 });
  if (result.terminationReason !== "completed" || result.exitCode !== 0) {
    throw new Error(`Could not initialize flagship web Git workspace: ${result.error ?? result.stderr ?? result.terminationReason}`);
  }
}

function hiddenCheckerSource(): string {
  return `import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const workspace = resolve(process.argv[2]);
const read = (path) => readFileSync(join(workspace, path), "utf8");
const pkg = JSON.parse(read("package.json"));
assert.equal(pkg.scripts?.start, "node server.mjs --port 0", "hidden: start script");
assert.equal(pkg.scripts?.test, "node scripts/test-runner.mjs \\\"tests/acceptance check.test.mjs\\\"", "hidden: quoted test script");
assert.match(read("index.html"), /<title>Flagship Task Board<\\/title>/, "hidden: title");
assert.match(read("app.js"), /addEventListener/, "hidden: interaction listener");
assert.match(read("app.js"), /Verify Morrow/, "hidden: sample task");
assert.match(read("styles.css"), /@media/, "hidden: responsive rule");
assert.match(read("server.mjs"), /127\\.0\\.0\\.1/, "hidden: loopback server");
assert.match(read("server.mjs"), /process\\.stdin/, "hidden: server waits on stdin closure");
assert.match(read("scripts/test-runner.mjs"), /process\\.env\\.CI/, "hidden: test runner is CI-aware");
assert.match(read("scripts/test-runner.mjs"), /setInterval|watch/, "hidden: test runner has a watch-capable path");
const child = spawn(process.execPath, ["server.mjs", "--port", "0"], {
  cwd: workspace,
  env: { ...process.env, CI: "true" },
  stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
child.stdout.on("data", (chunk) => { output += chunk.toString(); });
child.stderr.on("data", (chunk) => { output += chunk.toString(); });
const waitForUrl = (timeoutMs) => new Promise((resolveWait) => {
  const current = output.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\//)?.[0];
  if (current) { resolveWait(current); return; }
  const onData = () => {
    const url = output.match(/http:\\/\\/127\\.0\\.0\\.1:\\d+\\//)?.[0];
    if (!url) return;
    clearTimeout(timer);
    child.stdout.off("data", onData);
    child.stderr.off("data", onData);
    resolveWait(url);
  };
  const timer = setTimeout(() => {
    child.stdout.off("data", onData);
    child.stderr.off("data", onData);
    resolveWait(null);
  }, timeoutMs);
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
});
try {
  assert.equal(await waitForUrl(250), null, "hidden: server listened before stdin EOF");
  child.stdin.end();
  assert.ok(await waitForUrl(5_000), "hidden: server did not listen after stdin EOF: " + output.slice(0, 300));
} finally {
  if (child.exitCode === null) child.kill();
  if (child.exitCode === null) await Promise.race([once(child, "exit"), new Promise((resolveWait) => setTimeout(resolveWait, 2_000))]);
}
console.log("hidden flagship web checker passed");
`;
}

function quotedRelativePath(from: string, to: string): string {
  return `"${relative(from, to).replaceAll("\\\\", "/")}"`;
}

function failure(
  reason: FlagshipFailureReason,
  label: string,
  outcome: EvidenceOutcome,
  outcomes: Partial<FlagshipWebVerificationOutcomes>,
): FlagshipWebVerificationResult {
  return {
    ok: false,
    reason,
    detail: `${label}: ${outcome.summary}${outcome.output ? ` — ${outcome.output.slice(0, 500)}` : ""}`,
    outcomes,
  };
}

export async function verifyFlagshipWebArtifact(input: {
  root: string;
  workspace: string;
  browser: () => BrowserController;
}): Promise<FlagshipWebVerificationResult> {
  const missing = REQUIRED_FILES.filter((path) => !existsSync(join(input.workspace, path)));
  if (missing.length > 0) {
    return { ok: false, reason: "artifact_missing", detail: `required web artifact(s) missing: ${missing.join(", ")}` };
  }

  const verifyDir = join(input.root, "verify");
  mkdirSync(verifyDir, { recursive: true });
  const checkerPath = join(verifyDir, "flagship web checker.mjs");
  writeFileSync(checkerPath, hiddenCheckerSource(), "utf8");
  const outcomes: Partial<FlagshipWebVerificationOutcomes> = {};

  const generatedTest = await runVerification(
    { kind: "test", command: 'pnpm test -- "flagship web verification"', expectExitCode: 0 },
    { workspacePath: input.workspace },
  );
  outcomes.generatedTest = generatedTest;
  if (generatedTest.status !== "passed") return failure("contract_violated", "generated test command", generatedTest, outcomes);

  const hiddenTest = await runVerification(
    { kind: "test", command: `node ${quotedRelativePath(input.workspace, checkerPath)} "."`, expectExitCode: 0 },
    { workspacePath: input.workspace },
  );
  outcomes.hiddenTest = hiddenTest;
  if (hiddenTest.status !== "passed") return failure("contract_violated", "hidden contract checker", hiddenTest, outcomes);

  const diff = await runVerification(
    { kind: "diff", pathScope: "*", describe: "generated web files are visible to Git" },
    { workspacePath: input.workspace },
  );
  outcomes.diff = diff;
  const changedFiles = new Set(diff.output.split("\n").map((path) => path.trim()).filter(Boolean));
  const missingFromDiff = REQUIRED_FILES.filter((path) => {
    if (changedFiles.has(path)) return false;
    const topLevelDirectory = `${path.split("/")[0]}/`;
    return !changedFiles.has(topLevelDirectory);
  });
  if (diff.status !== "passed" || missingFromDiff.length > 0) {
    const detail = missingFromDiff.length > 0
      ? { ...diff, summary: `${diff.summary}; required changed file(s) absent: ${missingFromDiff.join(", ")}` }
      : diff;
    return failure("contract_violated", "Git changed-file verification", detail, outcomes);
  }

  const renderedSnapshots: PageSnapshot[] = [];
  const recordingBrowser = () => {
    const controller = input.browser();
    return new Proxy<BrowserController>(controller, {
      get(target, property) {
        if (property === "open") {
          return async (...args: Parameters<BrowserController["open"]>): Promise<PageSnapshot> => {
            const snapshot = await target.open(...args);
            renderedSnapshots.push(snapshot);
            return snapshot;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  const browser = await runVerification(
    { kind: "browser", command: "pnpm start", service: true, expectStatus: 200 },
    { workspacePath: input.workspace, browser: recordingBrowser },
  );
  outcomes.browser = browser;
  if (browser.status === "inconclusive") return failure("harness_error", "browser verification unavailable", browser, outcomes);
  if (browser.status !== "passed") return failure("contract_violated", "browser verification", browser, outcomes);

  const normalizeSnapshotText = (value: string): string => value.replace(/\s+/g, " ").trim();
  const containsNormalizedSnapshotText = (value: string, expected: string): boolean => {
    const normalized = normalizeSnapshotText(value);
    return normalized === expected
      || normalized.startsWith(`${expected} `)
      || normalized.endsWith(` ${expected}`)
      || normalized.includes(` ${expected} `);
  };
  const browserFailure = renderedSnapshots.length === 0
    ? "browser verification produced no viewport snapshots"
    : (() => {
      const invalidIndex = renderedSnapshots.findIndex((snapshot) => {
        const hasButton = snapshot.refs.some((ref) => ref.role.trim().toLowerCase() === "button"
          && normalizeSnapshotText(ref.name) === "Add sample task");
        const hasCount = containsNormalizedSnapshotText(snapshot.text, "0 tasks");
        return !hasButton || !hasCount;
      });
      if (invalidIndex < 0) return null;
      const snapshot = renderedSnapshots[invalidIndex]!;
      const hasButton = snapshot.refs.some((ref) => ref.role.trim().toLowerCase() === "button"
        && normalizeSnapshotText(ref.name) === "Add sample task");
      const hasCount = containsNormalizedSnapshotText(snapshot.text, "0 tasks");
      const missing: string[] = [];
      if (!hasButton) missing.push('accessible button "Add sample task"');
      if (!hasCount) missing.push('visible text "0 tasks"');
      return `rendered viewport snapshot ${invalidIndex + 1} (${snapshot.viewport.width}x${snapshot.viewport.height}) missing ${missing.join(" and ")}`;
    })();
  if (browserFailure) {
    const failedBrowser: EvidenceOutcome = { ...browser, status: "failed", summary: browserFailure };
    outcomes.browser = failedBrowser;
    return failure("contract_violated", "browser verification", failedBrowser, outcomes);
  }

  const hash = createHash("sha256");
  for (const path of REQUIRED_FILES) {
    hash.update(path);
    hash.update("\0");
    hash.update(readFileSync(join(input.workspace, path)));
    hash.update("\0");
  }
  return { ok: true, artifactSha256: hash.digest("hex"), outcomes: outcomes as FlagshipWebVerificationOutcomes };
}

function productionBrowser(): BrowserController {
  return playwrightController({
    headless: true,
    allowPrivateNetwork: true,
    allowedDomains: ["localhost", "127.0.0.1"],
    ...(resolvePlaywrightChannel(undefined, process.env) ? { browser: resolvePlaywrightChannel(undefined, process.env)! } : {}),
  });
}

export async function runFlagshipWeb(input: FlagshipWebInput): Promise<FlagshipRun> {
  return runFlagshipScenario({
    ...input,
    scenarioId: FLAGSHIP_WEB_SCENARIO_ID,
    prompt: FLAGSHIP_WEB_PROMPT,
    projectName: "Flagship web build",
    initializeWorkspace: initializeFlagshipWebWorkspace,
    verify: async ({ workspace, taskId, projectId, db, toolCalls }) => {
      const parseArgs = (call: typeof toolCalls[number]): Record<string, unknown> => {
        try { return JSON.parse(call.argsJson ?? "{}") as Record<string, unknown>; } catch { return {}; }
      };
      const testCall = toolCalls.find((call) => {
        const args = parseArgs(call);
        let result: Record<string, unknown> = {};
        try { result = JSON.parse(call.resultJson ?? "{}") as Record<string, unknown>; } catch { /* not a passing foreground command */ }
        return call.toolName === "run_command" && args.executable === "pnpm"
          && JSON.stringify(args.args) === JSON.stringify(["test", "--", "flagship web verification"])
          && args.background !== true && call.status === "completed" && result.exitCode === 0;
      });
      if (!testCall) return { ok: false, reason: "contract_violated", detail: "agent did not complete the required quoted test command" };

      const processes = processesRepository(db).listByProject(projectId)
        .filter((record) => record.taskId === taskId && record.cwd === workspace);
      const backgroundCall = toolCalls.find((call) => {
        const args = parseArgs(call);
        if (call.toolName !== "run_command" || args.background !== true || call.status !== "completed") return false;
        try {
          const result = JSON.parse(call.resultJson ?? "{}") as Record<string, unknown>;
          return processes.some((record) => record.id === result.processId);
        } catch {
          return false;
        }
      });
      const backgroundResult = backgroundCall
        ? JSON.parse(backgroundCall.resultJson ?? "{}") as Record<string, unknown>
        : {};
      const process = processes.find((record) => record.id === backgroundResult.processId);
      if (!backgroundCall || !process) {
        return { ok: false, reason: "contract_violated", detail: "agent did not start the dev server through the supervisor boundary" };
      }
      const pkg = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")) as { scripts?: { start?: unknown } };
      const declaredStart = typeof pkg.scripts?.start === "string" ? pkg.scripts.start : "";
      const runsDeclaredServer = isDeclaredServerCommand(process.command, process.args, declaredStart);
      const inspectedProcess = toolCalls.some((call) => {
        const args = parseArgs(call);
        return call.toolName === "read_process_output" && args.processId === process.id && call.status === "completed";
      });
      const openedLoopback = toolCalls.some((call) => {
        const args = parseArgs(call);
        return call.toolName === "browser_open" && typeof args.url === "string"
          && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(args.url) && call.status === "completed";
      });
      if (!runsDeclaredServer || !inspectedProcess || !openedLoopback) {
        return { ok: false, reason: "contract_violated", detail: "agent did not inspect and verify the supervised dev server" };
      }
      const stopCall = toolCalls.find((call) => call.toolName === "stop_process" && call.status === "completed"
        && call.resultJson?.includes(process.id));
      if (!stopCall || process.status === "running") {
        return { ok: false, reason: "contract_violated", detail: "agent did not stop the supervised dev server before completion" };
      }

      return verifyFlagshipWebArtifact({
        root: input.root,
        workspace,
        // Mirror mission/controller-runner.ts: browser is the only injected
        // RunOptions dependency. exec, startService, and gitChangedFiles remain
        // unset so evidence-runner exercises its real defaults.
        browser: input.browser ?? productionBrowser,
      });
    },
  });
}
