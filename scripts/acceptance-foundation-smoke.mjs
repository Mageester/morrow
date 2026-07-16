import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SAFE_ENV_KEYS = ["Path", "PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ComSpec", "COMSPEC"];

export function buildSmokeEnvironment(parent, canary) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) if (parent[key] !== undefined) env[key] = parent[key];
  env.MORROW_ACCEPTANCE_TEST_SECRET = canary;
  return env;
}

function allText(root) {
  const chunks = [];
  const visit = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.size <= 1_048_576) chunks.push(readFileSync(path, "utf8"));
    }
  };
  visit(root);
  return chunks.join("\n");
}

export function inspectAcceptanceArtifacts(runRoot, forbiddenSecrets = [], expectedScenario = "foundation-smoke-v1") {
  const reportPath = join(runRoot, "report.json");
  const markdownPath = join(runRoot, "report.md");
  const ledgerPath = join(runRoot, "evidence.jsonl");
  for (const path of [reportPath, markdownPath, ledgerPath]) {
    if (!existsSync(path)) throw new Error(`Acceptance artifact is missing: ${basename(path)}`);
  }
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  if (report.disposition !== "PASS") throw new Error(`Acceptance report must be PASS (got ${report.disposition ?? "unknown"})`);
  if (!/^[0-9a-f]{40}$/.test(report.fixture?.startingSha ?? "")) throw new Error("Acceptance report is missing a valid fixture starting SHA");
  if (report.product?.packaged !== true || report.product?.exitCode !== 0 || !report.product?.taskId) throw new Error("Acceptance report lacks packaged product proof");
  if (report.checks?.product_persistence?.status !== "passed") throw new Error("Acceptance report lacks persisted product evidence");
  if (report.checks?.secrets_absent?.status !== "passed") throw new Error("Acceptance report did not pass its secret scan");
  if (report.scenarioId !== expectedScenario) throw new Error(`Acceptance report scenario mismatch (got ${report.scenarioId ?? "missing"})`);
  if (expectedScenario === "durable-autonomy-v1") {
    for (const check of ["premature_completion", "context_rollover", "provider_failure", "false_no_progress", "abrupt_process_restart", "stable_mission_identity", "unique_operation_keys", "terminal_completion"]) {
      if (report.checks?.[check]?.status !== "passed") throw new Error(`Durable autonomy report lacks ${check} proof`);
    }
    if (!report.product?.missionId) throw new Error("Durable autonomy report lacks a mission id");
  }
  const ledger = readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (!ledger.some((entry) => entry.step === "product-persistence" && entry.status === "passed")) throw new Error("Evidence ledger lacks product persistence proof");
  const text = allText(runRoot);
  for (const secret of forbiddenSecrets) if (secret && text.includes(secret)) throw new Error("Acceptance artifacts contain a forbidden secret value");
  return { runId: basename(runRoot), scenarioId: expectedScenario, disposition: report.disposition, startingSha: report.fixture.startingSha, taskId: report.product.taskId, missionId: report.product.missionId ?? null };
}

function gitFingerprint() {
  return {
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", shell: false }).trim(),
    status: execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8", shell: false }),
  };
}

function run() {
  if (process.platform !== "win32") throw new Error("The packaged foundation smoke currently requires Windows x64");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const scenarioFlag = process.argv.indexOf("--scenario");
  const scenario = scenarioFlag >= 0 ? process.argv[scenarioFlag + 1] : "foundation-smoke-v1";
  if (scenario !== "foundation-smoke-v1" && scenario !== "durable-autonomy-v1") throw new Error(`Unknown acceptance scenario: ${scenario}`);
  const sourcePackage = join(ROOT, "dist", `Morrow-v${pkg.version}-windows-x64`);
  if (!existsSync(sourcePackage)) throw new Error(`Packaged product not found at ${sourcePackage}. Run: node scripts/package-release.mjs ${pkg.version} --skip-build`);
  const before = gitFingerprint();
  const temporaryInstall = mkdtempSync(join(tmpdir(), "morrow-packaged-acceptance-"));
  const app = join(temporaryInstall, `Morrow-v${pkg.version}-windows-x64`);
  const canary = `morrow-acceptance-canary-${Date.now()}`;
  let stopped = false;
  try {
    cpSync(sourcePackage, app, { recursive: true });
    const node = join(app, "runtime", "node.exe");
    const launcher = join(app, "morrow.mjs");
    const env = buildSmokeEnvironment(process.env, canary);
    const executed = spawnSync(node, [launcher, "acceptance", "run", "--scenario", scenario, "--json", "--no-color", "--quiet"], {
      cwd: ROOT, env, encoding: "utf8", shell: false, windowsHide: true, timeout: 180_000,
    });
    const runsRoot = join(temporaryInstall, "data", "acceptance", "runs");
    const runs = existsSync(runsRoot) ? readdirSync(runsRoot).filter((name) => name.startsWith("run-")) : [];
    if (runs.length !== 1) throw new Error(`Expected one packaged acceptance run, found ${runs.length}. stdout=${executed.stdout} stderr=${executed.stderr}`);
    const runRoot = join(runsRoot, runs[0]);
    const inspected = inspectAcceptanceArtifacts(runRoot, [canary], scenario);
    const reportText = `${readFileSync(join(runRoot, "report.json"), "utf8")}\n${readFileSync(join(runRoot, "report.md"), "utf8")}\n${readFileSync(join(runRoot, "evidence.jsonl"), "utf8")}`;
    if (reportText.includes(ROOT)) throw new Error("Acceptance reports expose the source workspace absolute path");
    if (executed.status !== 0) throw new Error(`Packaged acceptance command exited ${executed.status}. stdout=${executed.stdout} stderr=${executed.stderr}`);
    const artifactFamily = scenario === "durable-autonomy-v1" ? "acceptance-durable-autonomy" : "acceptance-foundation";
    const retained = join(ROOT, ".artifacts", artifactFamily, inspected.runId);
    mkdirSync(dirname(retained), { recursive: true });
    rmSync(retained, { recursive: true, force: true });
    cpSync(runRoot, retained, { recursive: true });
    const stoppedResult = spawnSync(node, [launcher, "stop"], { cwd: ROOT, env, encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 });
    stopped = stoppedResult.status === 0;
    const after = gitFingerprint();
    if (after.commit !== before.commit || after.status !== before.status) throw new Error("Packaged acceptance smoke changed the source Git workspace");
    process.stdout.write(`${JSON.stringify({ ...inspected, sourceCommit: before.commit, sourceUntouched: true, retainedArtifacts: retained, usage: "mock-provider; no metered model usage" }, null, 2)}\n`);
  } finally {
    if (!stopped && existsSync(join(app, "runtime", "node.exe"))) {
      spawnSync(join(app, "runtime", "node.exe"), [join(app, "morrow.mjs"), "stop"], { cwd: ROOT, encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 });
    }
    rmSync(temporaryInstall, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
