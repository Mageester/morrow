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

export function inspectAcceptanceArtifacts(runRoot, forbiddenSecrets = []) {
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
  const ledger = readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  if (!ledger.some((entry) => entry.step === "product-persistence" && entry.status === "passed")) throw new Error("Evidence ledger lacks product persistence proof");
  const text = allText(runRoot);
  for (const secret of forbiddenSecrets) if (secret && text.includes(secret)) throw new Error("Acceptance artifacts contain a forbidden secret value");
  return { runId: basename(runRoot), disposition: report.disposition, startingSha: report.fixture.startingSha, taskId: report.product.taskId };
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
    const executed = spawnSync(node, [launcher, "acceptance", "run", "--json", "--no-color", "--quiet"], {
      cwd: ROOT, env, encoding: "utf8", shell: false, windowsHide: true, timeout: 180_000,
    });
    const runsRoot = join(temporaryInstall, "data", "acceptance", "runs");
    const runs = existsSync(runsRoot) ? readdirSync(runsRoot).filter((name) => name.startsWith("run-")) : [];
    if (runs.length !== 1) throw new Error(`Expected one packaged acceptance run, found ${runs.length}. stdout=${executed.stdout} stderr=${executed.stderr}`);
    const runRoot = join(runsRoot, runs[0]);
    const inspected = inspectAcceptanceArtifacts(runRoot, [canary]);
    const reportText = `${readFileSync(join(runRoot, "report.json"), "utf8")}\n${readFileSync(join(runRoot, "report.md"), "utf8")}\n${readFileSync(join(runRoot, "evidence.jsonl"), "utf8")}`;
    if (reportText.includes(ROOT)) throw new Error("Acceptance reports expose the source workspace absolute path");
    if (executed.status !== 0) throw new Error(`Packaged acceptance command exited ${executed.status}. stdout=${executed.stdout} stderr=${executed.stderr}`);
    const retained = join(ROOT, ".artifacts", "acceptance-foundation", inspected.runId);
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
