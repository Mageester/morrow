import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createFoundationFixture, createWriteFixFixture, verifyFixtureUnchanged } from "./fixture.js";
import { classifyAcceptanceRun, writeAcceptanceReports } from "./report.js";
import { AcceptanceStore, assertContainedPath } from "./storage.js";
import type { AcceptanceCheck, AcceptanceRunState, AcceptanceScenarioId, SourceFingerprint } from "./types.js";
import { runDurableAutonomyScenarios } from "./scenarios/durable-autonomy.js";
import { runBrowserSiteAcceptance, runCortexLearningAcceptance, runSustainedAutonomyAcceptance, type BrowserSiteAcceptanceResult, type CortexLearningAcceptanceResult, type SustainedAutonomyAcceptanceResult } from "@morrow/orchestrator";

export interface InvocationResult { exitCode: number; stdout: string; stderr: string }
export interface InvocationOptions { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
export type AcceptanceInvocation = (args: string[], options: InvocationOptions) => Promise<InvocationResult>;

export interface AcceptanceRunnerOptions {
  acceptanceRoot: string;
  executable: string;
  entrypoint: string;
  packaged: boolean;
  version: string;
  sourceCwd: string;
  runId?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  invoke?: AcceptanceInvocation;
  simulateAbruptInterruption?: boolean;
  scenarioId?: AcceptanceScenarioId;
  /** Intended source commit the package should reflect. Defaults to the commit
   *  fingerprinted from sourceCwd. Override only for tests that need to model
   *  a deliberate mismatch. */
  intendedSourceCommit?: string;
  /** Explicit escape hatches; both default to false (strict rejection). */
  allowProvenanceMismatch?: boolean;
  allowDirtyPackage?: boolean;
  browserSiteScenario?: (input: { root: string }) => Promise<BrowserSiteAcceptanceResult>;
  cortexLearningScenario?: (input: { root: string }) => Promise<CortexLearningAcceptanceResult>;
  sustainedAutonomyScenario?: (input: { root: string }) => Promise<SustainedAutonomyAcceptanceResult>;
}

export interface AcceptanceRunResult { state: AcceptanceRunState; reportJson: string; reportMarkdown: string }

const SAFE_ENV_KEYS = ["Path", "PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ComSpec", "COMSPEC", "MORROW_PACKAGED", "MORROW_SKILLS_DIR"];

export function buildAcceptanceChildEnvironment(parent: NodeJS.ProcessEnv, productHome: string, port: number): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) if (parent[key] !== undefined) child[key] = parent[key];
  child.MORROW_HOME = productHome;
  child.MOCK_PROVIDER = "true";
  child.MORROW_ACCEPTANCE_MODE = "beta31";
  child.PORT = String(port);
  child.NODE_ENV = "production";
  return child;
}

export function collectAcceptanceSecrets(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([key, value]) => Boolean(value) && /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(key))
    .map(([, value]) => value!)
    .filter((value) => value.length >= 4);
}

export function validateAcceptanceRunPaths(runRoot: string, state: AcceptanceRunState): { fixturePath: string | null; productHome: string | null } {
  return {
    fixturePath: state.fixture ? assertContainedPath(runRoot, state.fixture.path) : null,
    productHome: state.product ? assertContainedPath(runRoot, state.product.home) : null,
  };
}

export function classifyAcceptanceFailure(error: unknown): "BLOCKED" | "FAIL" {
  const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
  return code === "ENOENT" || code === "EACCES" ? "BLOCKED" : "FAIL";
}

function newRunId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return `run-${stamp}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

function fingerprintSource(cwd: string): SourceFingerprint {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000 }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd, encoding: "utf8", shell: false, windowsHide: true, timeout: 10_000 });
    return { commit: /^[0-9a-f]{40}$/.test(commit) ? commit : null, statusHash: createHash("sha256").update(status).digest("hex") };
  } catch {
    return { commit: null, statusHash: null };
  }
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function defaultInvoker(executable: string, entrypoint: string): AcceptanceInvocation {
  return async (args, options) => await new Promise((resolve, reject) => {
    const child = spawn(executable, [entrypoint, ...args], { cwd: options.cwd, env: options.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, options.timeoutMs);
    child.stdout.on("data", (chunk) => { if (stdout.length < 1_048_576) stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { if (stderr.length < 1_048_576) stderr += String(chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Packaged Morrow command timed out after ${options.timeoutMs}ms`));
      else resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

function parseJsonOutput(raw: string): any {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Packaged Morrow returned no JSON output");
  try { return JSON.parse(trimmed); } catch {
    const lines = trimmed.split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      try { return JSON.parse(lines.slice(i).join("\n")); } catch { /* keep scanning */ }
    }
    throw new Error("Packaged Morrow output was not valid JSON");
  }
}

function makeCheck(status: AcceptanceCheck["status"], summary: string, evidenceIds: string[]): AcceptanceCheck {
  return { status, summary, evidenceIds };
}

function beginStep(store: AcceptanceStore, state: AcceptanceRunState, step: string): void {
  state.lifecycle = "running";
  state.activeStep = step;
  state.updatedAt = new Date().toISOString();
  store.save(state);
  store.appendEvidence(state.runId, { step, kind: "lifecycle", status: "info", summary: `Started ${step}` });
}

function completeStep(store: AcceptanceStore, state: AcceptanceRunState, step: string): void {
  if (!state.completedSteps.includes(step)) state.completedSteps.push(step);
  state.activeStep = null;
  state.updatedAt = new Date().toISOString();
  store.save(state);
}

function writeArtifact(store: AcceptanceStore, state: AcceptanceRunState, name: string, content: string): string {
  const artifact = `artifacts/${name}`;
  const runRoot = store.runRoot(state.runId);
  const path = assertContainedPath(runRoot, join(runRoot, artifact));
  let localized = content.split(runRoot).join("<run-root>");
  localized = localized.split(runRoot.replace(/\\/g, "/")).join("<run-root>");
  writeFileSync(path, store.redact(localized).slice(0, 1_048_576), "utf8");
  if (!state.artifacts.includes(artifact)) state.artifacts.push(artifact);
  return artifact;
}

function copyBinaryArtifact(
  store: AcceptanceStore,
  state: AcceptanceRunState,
  sourceRoot: string,
  sourcePath: string,
  name: string,
  expectedSha256: string,
): string {
  const source = assertContainedPath(sourceRoot, sourcePath);
  const artifact = `artifacts/${name}`;
  const runRoot = store.runRoot(state.runId);
  const destination = assertContainedPath(runRoot, join(runRoot, artifact));
  copyFileSync(source, destination);
  const actualSha256 = createHash("sha256").update(readFileSync(destination)).digest("hex");
  if (actualSha256 !== expectedSha256) throw new Error(`Copied acceptance artifact hash mismatch: ${name}`);
  if (!state.artifacts.includes(artifact)) state.artifacts.push(artifact);
  return artifact;
}

function reportLeak(raw: string, secrets: readonly string[]): string | null {
  for (const secret of secrets) if (secret.length >= 4 && raw.includes(secret)) return "known credential value";
  if (/-----BEGIN [^-\r\n]*PRIVATE KEY-----/i.test(raw)) return "private key block";
  if (/\bBearer\s+(?!\[REDACTED\])[A-Za-z0-9._~+\/-]{6,}/i.test(raw)) return "bearer token";
  if (/\b(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)\s*[:=]\s*(?!\[REDACTED\])[^\s,;]+/i.test(raw)) return "credential assignment";
  return null;
}

export async function runAcceptance(options: AcceptanceRunnerOptions): Promise<AcceptanceRunResult> {
  const env = options.env ?? process.env;
  const secrets = collectAcceptanceSecrets(env);
  const store = new AcceptanceStore(options.acceptanceRoot, { secrets });
  const id = options.runId ?? newRunId();
  const root = store.runRoot(id);
  const productHome = assertContainedPath(root, join(root, "product-home"));
  const now = new Date().toISOString();
  const state: AcceptanceRunState = {
    schemaVersion: 1, runId: id, scenarioId: options.scenarioId ?? "foundation-smoke-v1", lifecycle: "created", disposition: "NOT RUN",
    startedAt: now, updatedAt: now, completedAt: null, activeStep: null, completedSteps: [], recoveryCount: 0,
    fixture: null,
    product: { home: productHome, entrypoint: options.entrypoint, packaged: options.packaged, version: options.version, taskId: null, missionId: null, exitCode: null },
    source: fingerprintSource(options.sourceCwd), provenance: null, checks: {}, artifacts: [], message: null,
  };
  store.create(state);
  return execute(store, state, options, secrets);
}

export async function resumeAcceptance(runId: string, options: AcceptanceRunnerOptions): Promise<AcceptanceRunResult> {
  const env = options.env ?? process.env;
  const secrets = collectAcceptanceSecrets(env);
  const store = new AcceptanceStore(options.acceptanceRoot, { secrets });
  const state = store.load(runId);
  if (state.lifecycle === "completed") {
    const paths = writeAcceptanceReports(store, state, store.readEvidence(state.runId));
    return { state, reportJson: paths.json, reportMarkdown: paths.markdown };
  }
  if (state.activeStep === "product") {
    validateAcceptanceRunPaths(store.runRoot(state.runId), state);
    if (!state.fixture || !verifyFixtureUnchanged(state.fixture).unchanged) throw new Error("Cannot safely resume: the read-only fixture changed after interruption");
    state.recoveryCount += 1;
    store.appendEvidence(state.runId, { step: "recovery", kind: "resume", status: "passed", summary: "Resumed interrupted read-only product invocation without repeating completed steps" });
    state.activeStep = null;
    store.save(state);
  }
  if (state.activeStep === "durable-autonomy") {
    const scenarioRoot = assertContainedPath(store.runRoot(state.runId), join(store.runRoot(state.runId), "durable-autonomy"));
    rmSync(scenarioRoot, { recursive: true, force: true });
    state.recoveryCount += 1;
    store.appendEvidence(state.runId, { step: "recovery", kind: "resume", status: "passed", summary: "Reset the contained disposable scenario runtime before resuming acceptance" });
    state.activeStep = null;
    store.save(state);
  }
  if (state.activeStep === "write-capable-fix") {
    const fixtureRoot = assertContainedPath(store.runRoot(state.runId), join(store.runRoot(state.runId), "write-fix-fixture"));
    rmSync(fixtureRoot, { recursive: true, force: true });
    state.recoveryCount += 1;
    store.appendEvidence(state.runId, { step: "recovery", kind: "resume", status: "passed", summary: "Reset the contained disposable write-fix fixture before resuming acceptance" });
    state.activeStep = null;
    store.save(state);
  }
  if (state.activeStep === "browser-company-site" || state.activeStep === "cortex-learning") {
    const interruptedStep = state.activeStep;
    const scenarioRoot = assertContainedPath(store.runRoot(state.runId), join(store.runRoot(state.runId), interruptedStep));
    rmSync(scenarioRoot, { recursive: true, force: true });
    state.recoveryCount += 1;
    store.appendEvidence(state.runId, {
      step: "recovery",
      kind: "resume",
      status: "passed",
      summary: `Reset the contained disposable ${interruptedStep} runtime before resuming acceptance`,
    });
    state.activeStep = null;
    store.save(state);
  }
  if (state.activeStep === "package-provenance") {
    state.recoveryCount += 1;
    store.appendEvidence(state.runId, { step: "recovery", kind: "resume", status: "passed", summary: "Re-read the idempotent packaged provenance report after interruption" });
    state.activeStep = null;
    store.save(state);
  }
  if (state.activeStep === "model-truth") {
    state.recoveryCount += 1;
    store.appendEvidence(state.runId, { step: "recovery", kind: "resume", status: "passed", summary: "Reran the idempotent model-truth probes after interruption" });
    state.activeStep = null;
    store.save(state);
  }
  return execute(store, state, options, secrets);
}

async function execute(store: AcceptanceStore, state: AcceptanceRunState, options: AcceptanceRunnerOptions, secrets: string[]): Promise<AcceptanceRunResult> {
  const invoke = options.invoke ?? defaultInvoker(options.executable, options.entrypoint);
  const runRoot = store.runRoot(state.runId);
  const persistedPaths = validateAcceptanceRunPaths(runRoot, state);
  const productHome = persistedPaths.productHome ?? assertContainedPath(runRoot, join(runRoot, "product-home"));
  const port = options.port ?? await availablePort();
  const childEnv = buildAcceptanceChildEnvironment(options.env ?? process.env, productHome, port);
  try {
    if (!state.completedSteps.includes("fixture")) {
      beginStep(store, state, "fixture");
      state.fixture = createFoundationFixture(runRoot);
      const isolation = store.appendEvidence(state.runId, { step: "fixture", kind: "containment", status: "passed", summary: "Fixture and product state are descendants of the acceptance run root" });
      const git = store.appendEvidence(state.runId, { step: "fixture", kind: "git", status: "passed", summary: `Recorded clean fixture starting SHA ${state.fixture.startingSha}`, details: { startingSha: state.fixture.startingSha } });
      state.checks.isolation = makeCheck("passed", "Disposable paths are contained within the run root", [isolation.id]);
      state.checks.fixture_git = makeCheck("passed", `Clean starting commit ${state.fixture.startingSha}`, [git.id]);
      completeStep(store, state, "fixture");
    }
    if (!state.fixture || !state.product) throw new Error("Acceptance run is missing fixture or product state");
    mkdirSync(productHome, { recursive: true });

    if (options.packaged && !state.completedSteps.includes("package-provenance")) {
      beginStep(store, state, "package-provenance");
      const invoked = await invoke(["provenance", "--json", "--no-color", "--quiet"], { cwd: state.fixture.path, env: childEnv, timeoutMs: 15_000 });
      const artifact = writeArtifact(store, state, "package-provenance.json", invoked.stdout);
      const payload = parseJsonOutput(invoked.stdout);
      const provenance = payload?.provenance ?? null;
      const isPackaged = Boolean(payload?.packaged) && provenance !== null;
      const intendedCommit = options.intendedSourceCommit ?? state.source?.commit ?? null;
      const matchesIntendedCommit = isPackaged && intendedCommit !== null ? provenance.sourceCommit === intendedCommit : null;
      const dirty: boolean | null = isPackaged ? Boolean(provenance.dirty) : null;
      state.provenance = {
        packaged: isPackaged,
        sourceCommit: isPackaged ? provenance.sourceCommit ?? null : null,
        dirty,
        version: isPackaged ? provenance.version ?? null : null,
        buildTimestamp: isPackaged ? provenance.buildTimestamp ?? null : null,
        schemaCatalogVersion: isPackaged ? provenance.schemaCatalogVersion ?? null : null,
        manifestHash: isPackaged ? provenance.manifestHash ?? null : null,
        matchesIntendedCommit,
      };
      if (!isPackaged) throw new Error("Packaged acceptance run requires embedded PROVENANCE.json, but the running binary reported none");
      if (matchesIntendedCommit === false && !options.allowProvenanceMismatch) {
        throw new Error(`Stale package: binary was built from commit ${provenance.sourceCommit ?? "unknown"}, but the intended source commit is ${intendedCommit}`);
      }
      if (dirty === true && !options.allowDirtyPackage) {
        throw new Error("Package was built from a dirty worktree; rejecting unless allowDirtyPackage is explicitly set");
      }
      const passed = isPackaged && matchesIntendedCommit !== false && (dirty !== true || Boolean(options.allowDirtyPackage));
      const entry = store.appendEvidence(state.runId, {
        step: "package-provenance",
        kind: "package-provenance",
        status: passed ? "passed" : "failed",
        summary: passed
          ? `Packaged binary reported provenance for commit ${provenance.sourceCommit}, matching the intended source commit, with manifest hash ${String(provenance.manifestHash).slice(0, 12)}…`
          : "Packaged binary provenance did not match the intended source commit or was built dirty",
        artifact,
        details: { sourceCommit: provenance.sourceCommit, intendedCommit, dirty, manifestHash: provenance.manifestHash, version: provenance.version, buildTimestamp: provenance.buildTimestamp },
      });
      state.checks.package_provenance = makeCheck(entry.status, entry.summary, [entry.id]);
      completeStep(store, state, "package-provenance");
    }

    writeFileSync(join(productHome, "config.json"), `${JSON.stringify({ user: { onboarded: true }, service: { port }, defaults: { mode: "read-only", useMemory: false } }, null, 2)}\n`, "utf8");

    if (!state.completedSteps.includes("product-init")) {
      beginStep(store, state, "product-init");
      const initialized = await invoke(["init", state.fixture.path, "--json", "--no-color", "--quiet"], { cwd: state.fixture.path, env: childEnv, timeoutMs: 60_000 });
      writeArtifact(store, state, "product-init.stdout.txt", initialized.stdout);
      if (initialized.stderr) writeArtifact(store, state, "product-init.stderr.txt", initialized.stderr);
      if (initialized.exitCode !== 0) throw new Error(`Packaged Morrow init exited ${initialized.exitCode}`);
      completeStep(store, state, "product-init");
    }

    if (!state.completedSteps.includes("product")) {
      beginStep(store, state, "product");
      const executed = await invoke(["ask", "Read evidence.txt and report the foundation marker.", "--json", "--no-color", "--quiet"], { cwd: state.fixture.path, env: childEnv, timeoutMs: 90_000 });
      const stdoutArtifact = writeArtifact(store, state, "product-task.stdout.txt", executed.stdout);
      if (executed.stderr) writeArtifact(store, state, "product-task.stderr.txt", executed.stderr);
      state.product.exitCode = executed.exitCode;
      const payload = parseJsonOutput(executed.stdout);
      state.product.taskId = typeof payload?.task?.id === "string" ? payload.task.id : null;
      const passed = executed.exitCode === 0 && payload?.status === "completed" && payload?.task?.status === "completed" && payload?.evidence?.some((item: any) => item.path === "evidence.txt");
      const entry = store.appendEvidence(state.runId, { step: "product", kind: "consumer-command", status: passed ? "passed" : "failed", summary: passed ? "Packaged Morrow completed the read-only fixture task with workspace evidence" : "Packaged Morrow did not complete the fixture task with required evidence", artifact: stdoutArtifact });
      state.checks.product_exit = makeCheck(passed ? "passed" : "failed", entry.summary, [entry.id]);
      completeStep(store, state, "product");
    }

    if (!state.product.taskId) throw new Error("Packaged Morrow did not return a task id");
    if (!state.completedSteps.includes("product-persistence")) {
      beginStep(store, state, "product-persistence");
      const audit = await invoke(["audit", "show", state.product.taskId, "--json", "--no-color", "--quiet"], { cwd: state.fixture.path, env: childEnv, timeoutMs: 30_000 });
      const artifact = writeArtifact(store, state, "product-audit.json", audit.stdout);
      if (audit.stderr) writeArtifact(store, state, "product-audit.stderr.txt", audit.stderr);
      const payload = parseJsonOutput(audit.stdout);
      const persisted = audit.exitCode === 0 && payload?.task?.status === "completed" && Array.isArray(payload?.events) && payload.events.length > 0 && payload?.evidence?.some((item: any) => item.path === "evidence.txt");
      const entry = store.appendEvidence(state.runId, { step: "product-persistence", kind: "consumer-audit", status: persisted ? "passed" : "failed", summary: persisted ? "Consumer audit observed durable task events and evidence" : "Consumer audit could not prove durable task events and evidence", artifact });
      state.checks.product_persistence = makeCheck(persisted ? "passed" : "failed", entry.summary, [entry.id]);
      completeStep(store, state, "product-persistence");
    }

    if (state.scenarioId === "durable-autonomy-v1" && !state.completedSteps.includes("write-capable-fix")) {
      beginStep(store, state, "write-capable-fix");
      const fixture = createWriteFixFixture(runRoot);
      const before = spawnSync(process.execPath, ["--test"], { cwd: fixture.path, encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 });
      const beforeArtifact = writeArtifact(store, state, "write-fix-before.txt", `${before.stdout ?? ""}${before.stderr ?? ""}`);
      const initialized = await invoke(["init", fixture.path, "--json", "--no-color", "--quiet"], { cwd: fixture.path, env: childEnv, timeoutMs: 60_000 });
      if (initialized.exitCode !== 0) throw new Error(`Packaged Morrow write-fix init exited ${initialized.exitCode}`);
      const executed = await invoke([
        "yolo",
        "BETA31-WRITE-FIX: reproduce both defects, repair all affected files, add regression coverage, run the full tests, and inspect the final diff.",
        "--json", "--no-color", "--quiet",
      ], { cwd: fixture.path, env: childEnv, timeoutMs: 120_000 });
      const taskArtifact = writeArtifact(store, state, "write-fix-task.json", executed.stdout);
      if (executed.stderr) writeArtifact(store, state, "write-fix-task.stderr.txt", executed.stderr);
      const taskPayload = parseJsonOutput(executed.stdout);
      const taskId = typeof taskPayload?.task?.id === "string" ? taskPayload.task.id : null;
      if (!taskId) throw new Error("Packaged write-fix task did not return a task id");
      const audit = await invoke(["audit", "show", taskId, "--json", "--no-color", "--quiet"], { cwd: fixture.path, env: childEnv, timeoutMs: 30_000 });
      const auditArtifact = writeArtifact(store, state, "write-fix-audit.json", audit.stdout);
      const auditPayload = parseJsonOutput(audit.stdout);
      const after = spawnSync(process.execPath, ["--test"], { cwd: fixture.path, encoding: "utf8", shell: false, windowsHide: true, timeout: 30_000 });
      const afterArtifact = writeArtifact(store, state, "write-fix-after.txt", `${after.stdout ?? ""}${after.stderr ?? ""}`);
      const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: fixture.path, encoding: "utf8", shell: false, windowsHide: true, timeout: 15_000 });
      const diff = execFileSync("git", ["diff", "--", "src/cart.mjs", "src/receipt.mjs", "test/cart.test.mjs"], { cwd: fixture.path, encoding: "utf8", shell: false, windowsHide: true, timeout: 15_000 });
      const diffArtifact = writeArtifact(store, state, "write-fix.diff", diff);
      const toolCalls = Array.isArray(auditPayload?.toolCalls) ? auditPayload.toolCalls : [];
      const named = (name: string) => toolCalls.filter((call: any) => call?.toolName === name);
      const changedFiles = status.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/\\/g, "/")).sort();
      const expectedFiles = ["src/cart.mjs", "src/receipt.mjs", "test/cart.test.mjs"].sort();
      const reproduced = before.status !== 0;
      const commandRecovered = named("run_command").some((call: any) => call.status === "failed")
        && named("run_command").some((call: any) => call.status === "completed");
      const malformedRecovered = named("run_command").some((call: any) => call.status === "failed" && /argument|json|parse/i.test(String(call.resultJson ?? call.errorMessage ?? "")));
      const patched = named("propose_patch").some((call: any) => call.status === "completed");
      const diffInspected = named("git_diff").some((call: any) => call.status === "completed");
      const passed = reproduced
        && initialized.exitCode === 0
        && executed.exitCode === 0
        && taskPayload?.task?.status === "completed"
        && audit.exitCode === 0
        && after.status === 0
        && JSON.stringify(changedFiles) === JSON.stringify(expectedFiles)
        && patched
        && diffInspected
        && commandRecovered
        && malformedRecovered;
      const entry = store.appendEvidence(state.runId, {
        step: "write-capable-fix",
        kind: "packaged-write-mission",
        status: passed ? "passed" : "failed",
        summary: passed
          ? "Packaged Morrow reproduced two defects, recovered from malformed and failing commands, patched three files, passed three tests, and inspected the diff"
          : `Packaged write fix failed: before=${before.status}; task=${taskPayload?.task?.status ?? "unknown"}; after=${after.status}; files=${changedFiles.join(",")}`,
        artifact: auditArtifact,
        details: { taskId, changedFiles, reproduced, patched, diffInspected, commandRecovered, malformedRecovered, artifacts: [beforeArtifact, taskArtifact, afterArtifact, diffArtifact] },
      });
      state.checks.write_capable_bug_fix = makeCheck(entry.status, entry.summary, [entry.id]);
      state.checks.malformed_tool_recovery = makeCheck(malformedRecovered ? "passed" : "failed", malformedRecovered ? "Malformed tool arguments were recorded and the task continued" : "Malformed tool recovery was not proven", [entry.id]);
      state.checks.command_failure_recovery = makeCheck(commandRecovered ? "passed" : "failed", commandRecovered ? "A failing test command was followed by a successful verification command" : "Command failure recovery was not proven", [entry.id]);
      state.checks.diff_inspected = makeCheck(diffInspected ? "passed" : "failed", diffInspected ? "The packaged task inspected its final Git diff" : "Final diff inspection was not proven", [entry.id]);
      completeStep(store, state, "write-capable-fix");
    }

    if (state.scenarioId === "durable-autonomy-v1" && !state.completedSteps.includes("browser-company-site")) {
      beginStep(store, state, "browser-company-site");
      const browserRoot = assertContainedPath(runRoot, join(runRoot, "browser-company-site"));
      const browserResult = await (options.browserSiteScenario ?? runBrowserSiteAcceptance)({ root: browserRoot });
      const retainedScreenshots = browserResult.screenshots.map((item) => ({
        ...item,
        artifact: copyBinaryArtifact(store, state, browserRoot, item.path, `${item.label}.png`, item.sha256),
      }));
      const artifact = writeArtifact(store, state, "browser-company-site.json", `${JSON.stringify(browserResult, null, 2)}\n`);
      const entry = store.appendEvidence(state.runId, {
        step: "browser-company-site",
        kind: "packaged-browser-vision",
        status: browserResult.passed ? "passed" : "failed",
        summary: browserResult.passed
          ? `Built and validated the responsive company site through ${browserResult.toolCalls} agent tool calls and ${browserResult.screenshots.length} vision-attached screenshots`
          : `Company-site browser validation failed: ${browserResult.message ?? "unknown failure"}`,
        artifact,
        details: {
          taskId: browserResult.taskId,
          taskStatus: browserResult.taskStatus,
          screenshots: retainedScreenshots.map(({ label, sha256, bytes, viewport, vision, artifact: screenshotArtifact }) => ({ label, sha256, bytes, viewport, vision, artifact: screenshotArtifact })),
          consoleHealthy: browserResult.consoleHealthy,
          interactionProven: browserResult.interactionProven,
          testsPassed: browserResult.testsPassed,
          userInterventions: browserResult.userInterventions,
          wallClockMs: browserResult.wallClockMs,
        },
      });
      state.checks.browser_company_site = makeCheck(entry.status, entry.summary, [entry.id]);
      const visualPassed = retainedScreenshots.length === 3 && retainedScreenshots.every((item) => item.vision === "attached");
      state.checks.browser_vision = makeCheck(visualPassed ? "passed" : "failed", visualPassed ? "Desktop, tablet, and mobile PNGs traversed the verified vision attachment path" : "Responsive vision evidence was incomplete", [entry.id]);
      state.checks.frontend_visual_validation = makeCheck(browserResult.consoleHealthy && browserResult.interactionProven ? "passed" : "failed", browserResult.consoleHealthy && browserResult.interactionProven ? "Rendered DOM, console, and interaction validation passed" : "Rendered frontend interaction or console validation failed", [entry.id]);
      completeStep(store, state, "browser-company-site");
    }

    if (state.scenarioId === "durable-autonomy-v1" && !state.completedSteps.includes("cortex-learning")) {
      beginStep(store, state, "cortex-learning");
      const cortexRoot = assertContainedPath(runRoot, join(runRoot, "cortex-learning"));
      const cortexResult = await (options.cortexLearningScenario ?? runCortexLearningAcceptance)({ root: cortexRoot });
      const artifact = writeArtifact(store, state, "cortex-learning.json", `${JSON.stringify(cortexResult, null, 2)}\n`);
      const entry = store.appendEvidence(state.runId, {
        step: "cortex-learning",
        kind: "automatic-memory-and-skills",
        status: cortexResult.passed ? "passed" : "failed",
        summary: cortexResult.passed
          ? `Mission B automatically recalled Mission A memory; validated skill ${cortexResult.skillId} v${cortexResult.skillVersion} was automatically applied in Mission C`
          : `Automatic Cortex learning failed: ${cortexResult.message ?? "unknown failure"}`,
        artifact,
        details: {
          memoryCreatedAutomatically: cortexResult.memoryCreatedAutomatically,
          memoryRetrievedInMissionB: cortexResult.memoryRetrievedInMissionB,
          skillCandidateAfterMissionA: cortexResult.skillCandidateAfterMissionA,
          skillActiveAfterMissionB: cortexResult.skillActiveAfterMissionB,
          skillAppliedInMissionC: cortexResult.skillAppliedInMissionC,
          validationRequirements: cortexResult.validationRequirements,
          permissions: cortexResult.permissions,
          userMemoryCommands: cortexResult.userMemoryCommands,
          userSkillCommands: cortexResult.userSkillCommands,
        },
      });
      state.checks.automatic_memory = makeCheck(cortexResult.memoryCreatedAutomatically && cortexResult.memoryRetrievedInMissionB ? "passed" : "failed", cortexResult.memoryCreatedAutomatically && cortexResult.memoryRetrievedInMissionB ? "Mission A memory was captured with evidence and injected into Mission B without a memory command" : "Automatic memory capture or recall was not proven", [entry.id]);
      state.checks.automatic_skills = makeCheck(cortexResult.skillCandidateAfterMissionA && cortexResult.skillActiveAfterMissionB && cortexResult.skillAppliedInMissionC ? "passed" : "failed", cortexResult.skillCandidateAfterMissionA && cortexResult.skillActiveAfterMissionB && cortexResult.skillAppliedInMissionC ? "A repeated workflow progressed from candidate to validated active skill and was applied to Mission C" : "Automatic skill promotion or later application was not proven", [entry.id]);
      completeStep(store, state, "cortex-learning");
    }

    if (state.scenarioId === "durable-autonomy-v1" && !state.completedSteps.includes("model-truth")) {
      beginStep(store, state, "model-truth");
      const listArgs = ["models", "list", "--all", "--json", "--no-color", "--quiet"];
      const before = await invoke(listArgs, { cwd: state.fixture.path, env: childEnv, timeoutMs: 30_000 });
      const beforeModels = parseJsonOutput(before.stdout);
      if (before.exitCode !== 0 || !Array.isArray(beforeModels) || beforeModels.length === 0) throw new Error("Packaged model catalog returned no diagnostic entries");
      const selected = beforeModels.find((item: any) => item?.model?.lifecycle === "current") ?? beforeModels[0];
      const selectedId = selected?.model?.id;
      if (typeof selectedId !== "string") throw new Error("Packaged model catalog entry lacked a model id");
      const info = await invoke(["models", "info", selectedId, "--json", "--no-color", "--quiet"], { cwd: state.fixture.path, env: childEnv, timeoutMs: 30_000 });
      const infoModel = parseJsonOutput(info.stdout);
      const restarted = await invoke(["restart", "--no-color", "--quiet"], { cwd: state.fixture.path, env: childEnv, timeoutMs: 30_000 });
      const after = await invoke(listArgs, { cwd: state.fixture.path, env: childEnv, timeoutMs: 30_000 });
      const afterModels = parseJsonOutput(after.stdout);
      const truthfulMetadata = beforeModels.every((item: any) => {
        const context = item?.model?.contextWindow;
        const output = item?.model?.maxOutputTokens;
        const validLimit = (value: unknown) => value === null || value === undefined || (Number.isInteger(value) && Number(value) > 0);
        return typeof item?.model?.id === "string"
          && typeof item?.model?.providerId === "string"
          && validLimit(context)
          && validLimit(output)
          && typeof (item?.model?.metadataSource ?? "unknown") === "string";
      });
      const detailConsistent = info.exitCode === 0 && JSON.stringify(infoModel) === JSON.stringify(selected);
      const restartPersistent = restarted.exitCode === 0 && after.exitCode === 0 && JSON.stringify(afterModels) === JSON.stringify(beforeModels);
      const passed = truthfulMetadata && detailConsistent && restartPersistent;
      const artifact = writeArtifact(store, state, "model-truth.json", `${JSON.stringify({ selectedId, beforeModels, infoModel, afterModels, truthfulMetadata, detailConsistent, restartPersistent }, null, 2)}\n`);
      const entry = store.appendEvidence(state.runId, {
        step: "model-truth",
        kind: "packaged-model-catalog",
        status: passed ? "passed" : "failed",
        summary: passed ? `Packaged model list and ${selectedId} detail agreed across service restart with sourced or explicitly unknown limits` : `Model truth failed: metadata=${truthfulMetadata}; detail=${detailConsistent}; restart=${restartPersistent}`,
        artifact,
        details: { selectedId, entries: beforeModels.length, truthfulMetadata, detailConsistent, restartPersistent },
      });
      state.checks.model_truth = makeCheck(entry.status, entry.summary, [entry.id]);
      completeStep(store, state, "model-truth");
    }

    if (state.scenarioId === "durable-autonomy-v1" && !state.completedSteps.includes("durable-autonomy")) {
      beginStep(store, state, "durable-autonomy");
      const scenarioRoot = assertContainedPath(runRoot, join(runRoot, "durable-autonomy"));
      const result = await runDurableAutonomyScenarios({ root: scenarioRoot });
      const sustainedAutonomy = await (options.sustainedAutonomyScenario ?? runSustainedAutonomyAcceptance)({ root: join(scenarioRoot, "sustained-autonomy") });
      const artifact = writeArtifact(store, state, "durable-autonomy.json", `${JSON.stringify(result, null, 2)}\n`);
      const sustainedArtifact = writeArtifact(store, state, "sustained-autonomy.json", `${JSON.stringify(sustainedAutonomy, null, 2)}\n`);
      state.product.missionId = result.scenarios[0]?.missionId ?? null;
      for (const scenario of result.scenarios) {
        const entry = store.appendEvidence(state.runId, {
          step: "durable-autonomy",
          kind: "controller-fault-scenario",
          status: scenario.passed ? "passed" : "failed",
          summary: scenario.passed
            ? `${scenario.fault} continued to ${scenario.terminalState} on one mission with ${scenario.dispatchCount} dispatch(es)`
            : `${scenario.fault} failed: ${scenario.message ?? "unknown failure"}`,
          artifact,
          details: {
            missionId: scenario.missionId,
            operationKeys: scenario.operationKeys,
            recoveryCategories: scenario.recoveryCategories,
            guardianRejections: scenario.guardianRejections,
            controllerOwners: scenario.controllerOwners,
          },
        });
        state.checks[scenario.fault] = makeCheck(entry.status, entry.summary, [entry.id]);
      }
      const stable = result.scenarios.every((scenario) => scenario.missionIds.length === 1 && scenario.missionIds[0] === scenario.missionId);
      const unique = result.scenarios.every((scenario) => new Set(scenario.operationKeys).size === scenario.operationKeys.length);
      const terminal = result.scenarios.every((scenario) => scenario.terminalState === "completed");
      for (const [key, passed, summary] of [
        ["stable_mission_identity", stable, "Every continuation retained one stable mission identity"],
        ["unique_operation_keys", unique, "Every durable side effect retained a unique idempotency key"],
        ["terminal_completion", terminal, "Every injected fault reached Guardian-gated completion"],
      ] as const) {
        const entry = store.appendEvidence(state.runId, { step: "durable-autonomy", kind: "ledger-invariant", status: passed ? "passed" : "failed", summary });
        state.checks[key] = makeCheck(entry.status, entry.summary, [entry.id]);
      }
      const sustainedEntry = store.appendEvidence(state.runId, {
        step: "durable-autonomy",
        kind: "sustained-autonomy",
        status: sustainedAutonomy.passed ? "passed" : "failed",
        summary: sustainedAutonomy.passed
          ? `Production controller/runner stack completed ${sustainedAutonomy.productiveWorkUnits} real work units through ${sustainedAutonomy.contextRolloverCount} context rollovers, ${sustainedAutonomy.recoveryCount} classified recoveries, a real SQLite close/reopen, a real Guardian rejection, and real Guardian authorization`
          : `Sustained-autonomy scenario failed: ${sustainedAutonomy.message ?? "unknown failure"}`,
        artifact: sustainedArtifact,
        details: {
          missionId: sustainedAutonomy.missionId,
          productiveWorkUnits: sustainedAutonomy.productiveWorkUnits,
          progressObservationCount: sustainedAutonomy.progressObservationCount,
          contextRolloverCount: sustainedAutonomy.contextRolloverCount,
          checkpointCount: sustainedAutonomy.checkpointCount,
          recoveryCategories: sustainedAutonomy.recoveryCategories,
          databaseRestartCount: sustainedAutonomy.databaseRestartCount,
          leaseGenerationBeforeRestart: sustainedAutonomy.leaseGenerationBeforeRestart,
          leaseGenerationAfterRestart: sustainedAutonomy.leaseGenerationAfterRestart,
          duplicateCompletedOperations: sustainedAutonomy.duplicateCompletedOperations,
          guardianRejectionCount: sustainedAutonomy.guardianRejectionCount,
          guardianAuthorizationCount: sustainedAutonomy.guardianAuthorizationCount,
          transitionActors: sustainedAutonomy.transitionActors,
          deadlineMs: sustainedAutonomy.deadlineMs,
          userContinuations: sustainedAutonomy.userContinuations,
          sqliteIntegrity: sustainedAutonomy.sqliteIntegrity,
          wallClockMs: sustainedAutonomy.wallClockMs,
        },
      });
      state.checks.sustained_autonomy_production_run = makeCheck(sustainedEntry.status, sustainedEntry.summary, [sustainedEntry.id]);
      const sustainedInvariants: Array<[string, boolean, string]> = [
        ["sustained_autonomy_work_units", sustainedAutonomy.productiveWorkUnits >= 96, `Production execution produced ${sustainedAutonomy.productiveWorkUnits} real work units (>=96 required)`],
        ["sustained_autonomy_rollovers", sustainedAutonomy.contextRolloverCount >= 3, `Production context accounting triggered ${sustainedAutonomy.contextRolloverCount} rollover(s) (>=3 required)`],
        ["sustained_autonomy_recoveries", sustainedAutonomy.recoveryCount >= 2, `The production recovery planner classified ${sustainedAutonomy.recoveryCount} recover(y/ies) (>=2 required)`],
        ["sustained_autonomy_restart", sustainedAutonomy.databaseRestartCount === 1 && sustainedAutonomy.leaseGenerationAfterRestart > sustainedAutonomy.leaseGenerationBeforeRestart, "A real SQLite close/reopen was followed by lease-generation advancement under a new owner"],
        ["sustained_autonomy_no_duplicates", sustainedAutonomy.duplicateCompletedOperations === 0, "No completed side effect ran a second time after the restart"],
        ["sustained_autonomy_guardian", sustainedAutonomy.guardianRejectionCount > 0 && sustainedAutonomy.guardianAuthorizationCount === 1, "The real Guardian rejected the first candidate and authorized exactly one terminal completion after correction"],
        ["sustained_autonomy_terminal", sustainedAutonomy.terminalState === "completed", "The mission reached a production-created terminal completion"],
        ["sustained_autonomy_no_deadline", sustainedAutonomy.deadlineMs === null && sustainedAutonomy.userContinuations === 0, "The mission ran to completion without a configured arbitrary deadline or an observed user continuation"],
        ["sustained_autonomy_integrity", sustainedAutonomy.sqliteIntegrity === "ok", "SQLite integrity_check reported ok after the run"],
      ];
      for (const [key, passed, summary] of sustainedInvariants) {
        const entry = store.appendEvidence(state.runId, { step: "durable-autonomy", kind: "sustained-autonomy-invariant", status: passed ? "passed" : "failed", summary });
        state.checks[key] = makeCheck(entry.status, entry.summary, [entry.id]);
      }
      completeStep(store, state, "durable-autonomy");
    }

    if (!state.completedSteps.includes("integrity")) {
      beginStep(store, state, "integrity");
      const fixture = verifyFixtureUnchanged(state.fixture);
      const fixtureEntry = store.appendEvidence(state.runId, { step: "integrity", kind: "git", status: fixture.unchanged ? "passed" : "failed", summary: fixture.unchanged ? "Fixture remained at its clean starting commit" : "Fixture changed during the read-only smoke" });
      state.checks.fixture_unchanged = makeCheck(fixture.unchanged ? "passed" : "failed", fixtureEntry.summary, [fixtureEntry.id]);
      const after = fingerprintSource(options.sourceCwd);
      const sourceKnown = state.source?.commit !== null && state.source?.statusHash !== null;
      const untouched = sourceKnown && after.commit === state.source?.commit && after.statusHash === state.source?.statusHash;
      const sourceEntry = store.appendEvidence(state.runId, { step: "integrity", kind: "source-git", status: sourceKnown ? (untouched ? "passed" : "failed") : "inconclusive", summary: sourceKnown ? (untouched ? "Invoking source Git fingerprint remained unchanged" : "Invoking source Git fingerprint changed") : "Invoking directory was not a verifiable Git workspace" });
      state.checks.source_untouched = makeCheck(sourceEntry.status, sourceEntry.summary, [sourceEntry.id]);
      completeStep(store, state, "integrity");
    }
  } catch (error) {
    if (options.simulateAbruptInterruption) throw error;
    const message = error instanceof Error ? error.message : String(error);
    const failureDisposition = classifyAcceptanceFailure(error);
    if (failureDisposition === "BLOCKED") state.disposition = "BLOCKED";
    const evidenceStatus = failureDisposition === "BLOCKED" ? "inconclusive" : "failed";
    const entry = store.appendEvidence(state.runId, { step: state.activeStep ?? "runner", kind: "failure", status: evidenceStatus, summary: message });
    const key = state.activeStep === "product" || state.activeStep === "product-init"
      ? "product_exit"
      : state.activeStep === "package-provenance"
        ? "package_provenance"
        : state.activeStep === "write-capable-fix"
          ? "write_capable_bug_fix"
          : state.activeStep === "browser-company-site"
            ? "browser_company_site"
            : state.activeStep === "cortex-learning"
              ? "automatic_memory"
              : state.activeStep === "model-truth"
                ? "model_truth"
                : state.activeStep === "durable-autonomy"
                  ? "terminal_completion"
                  : "product_persistence";
    state.checks[key] = makeCheck(evidenceStatus, message, [entry.id]);
    state.message = message;
  } finally {
    if (!options.simulateAbruptInterruption && state.fixture) {
      try { await invoke(["stop", "--no-color", "--quiet"], { cwd: state.fixture.path, env: childEnv, timeoutMs: 20_000 }); } catch { /* bounded best effort */ }
    }
  }

  state.activeStep = null;
  state.disposition = classifyAcceptanceRun(state);
  state.updatedAt = new Date().toISOString();
  store.save(state);
  let paths = writeAcceptanceReports(store, state, store.readEvidence(state.runId));
  const reportEntry = store.appendEvidence(state.runId, { step: "report", kind: "artifact", status: "passed", summary: "Generated machine-readable JSON and human-readable Markdown reports", artifact: "report.json" });
  state.checks.reports_generated = makeCheck("passed", "Generated report.json and report.md", [reportEntry.id]);
  const rawReports = `${readFileSync(paths.json, "utf8")}\n${readFileSync(paths.markdown, "utf8")}`;
  const leak = reportLeak(rawReports, secrets);
  const leakEntry = store.appendEvidence(state.runId, { step: "report", kind: "redaction-scan", status: leak ? "failed" : "passed", summary: leak ? `Report leak scan found ${leak}` : "Report leak scan found no credential material" });
  state.checks.secrets_absent = makeCheck(leak ? "failed" : "passed", leakEntry.summary, [leakEntry.id]);
  state.disposition = classifyAcceptanceRun(state);
  state.lifecycle = "completed";
  state.completedAt = new Date().toISOString();
  state.updatedAt = state.completedAt;
  state.artifacts = [...new Set([...state.artifacts, "report.json", "report.md", "evidence.jsonl"])];
  store.save(state);
  paths = writeAcceptanceReports(store, state, store.readEvidence(state.runId));
  if (state.disposition === "PASS") {
    const cleanupPaths = validateAcceptanceRunPaths(runRoot, state);
    if (cleanupPaths.fixturePath) rmSync(cleanupPaths.fixturePath, { recursive: true, force: true });
    if (cleanupPaths.productHome) rmSync(cleanupPaths.productHome, { recursive: true, force: true });
    if (state.scenarioId === "durable-autonomy-v1") {
      rmSync(assertContainedPath(runRoot, join(runRoot, "durable-autonomy")), { recursive: true, force: true });
      rmSync(assertContainedPath(runRoot, join(runRoot, "write-fix-fixture")), { recursive: true, force: true });
    }
  }
  return { state, reportJson: paths.json, reportMarkdown: paths.markdown };
}
