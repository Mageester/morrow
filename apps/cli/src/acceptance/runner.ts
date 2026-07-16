import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { createFoundationFixture, verifyFixtureUnchanged } from "./fixture.js";
import { classifyFoundationRun, writeAcceptanceReports } from "./report.js";
import { AcceptanceStore, assertContainedPath } from "./storage.js";
import type { AcceptanceCheck, AcceptanceRunState, SourceFingerprint } from "./types.js";

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
}

export interface AcceptanceRunResult { state: AcceptanceRunState; reportJson: string; reportMarkdown: string }

const SAFE_ENV_KEYS = ["Path", "PATH", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "ComSpec", "COMSPEC", "MORROW_PACKAGED", "MORROW_SKILLS_DIR"];

export function buildAcceptanceChildEnvironment(parent: NodeJS.ProcessEnv, productHome: string, port: number): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) if (parent[key] !== undefined) child[key] = parent[key];
  child.MORROW_HOME = productHome;
  child.MOCK_PROVIDER = "true";
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
    schemaVersion: 1, runId: id, scenarioId: "foundation-smoke-v1", lifecycle: "created", disposition: "NOT RUN",
    startedAt: now, updatedAt: now, completedAt: null, activeStep: null, completedSteps: [], recoveryCount: 0,
    fixture: null,
    product: { home: productHome, entrypoint: options.entrypoint, packaged: options.packaged, version: options.version, taskId: null, exitCode: null },
    source: fingerprintSource(options.sourceCwd), checks: {}, artifacts: [], message: null,
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
    if (!state.fixture || !verifyFixtureUnchanged(state.fixture).unchanged) throw new Error("Cannot safely resume: the read-only fixture changed after interruption");
    state.recoveryCount += 1;
    store.appendEvidence(state.runId, { step: "recovery", kind: "resume", status: "passed", summary: "Resumed interrupted read-only product invocation without repeating completed steps" });
    state.activeStep = null;
    store.save(state);
  }
  return execute(store, state, options, secrets);
}

async function execute(store: AcceptanceStore, state: AcceptanceRunState, options: AcceptanceRunnerOptions, secrets: string[]): Promise<AcceptanceRunResult> {
  const invoke = options.invoke ?? defaultInvoker(options.executable, options.entrypoint);
  const runRoot = store.runRoot(state.runId);
  const productHome = state.product?.home ?? assertContainedPath(runRoot, join(runRoot, "product-home"));
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
    const entry = store.appendEvidence(state.runId, { step: state.activeStep ?? "runner", kind: "failure", status: "failed", summary: message });
    const key = state.activeStep === "product" || state.activeStep === "product-init" ? "product_exit" : "product_persistence";
    state.checks[key] = makeCheck("failed", message, [entry.id]);
    state.message = message;
  } finally {
    if (!options.simulateAbruptInterruption && state.fixture) {
      try { await invoke(["stop", "--no-color", "--quiet"], { cwd: state.fixture.path, env: childEnv, timeoutMs: 20_000 }); } catch { /* bounded best effort */ }
    }
  }

  state.activeStep = null;
  state.disposition = classifyFoundationRun(state);
  state.updatedAt = new Date().toISOString();
  store.save(state);
  let paths = writeAcceptanceReports(store, state, store.readEvidence(state.runId));
  const reportEntry = store.appendEvidence(state.runId, { step: "report", kind: "artifact", status: "passed", summary: "Generated machine-readable JSON and human-readable Markdown reports", artifact: "report.json" });
  state.checks.reports_generated = makeCheck("passed", "Generated report.json and report.md", [reportEntry.id]);
  const rawReports = `${readFileSync(paths.json, "utf8")}\n${readFileSync(paths.markdown, "utf8")}`;
  const leak = reportLeak(rawReports, secrets);
  const leakEntry = store.appendEvidence(state.runId, { step: "report", kind: "redaction-scan", status: leak ? "failed" : "passed", summary: leak ? `Report leak scan found ${leak}` : "Report leak scan found no credential material" });
  state.checks.secrets_absent = makeCheck(leak ? "failed" : "passed", leakEntry.summary, [leakEntry.id]);
  state.disposition = classifyFoundationRun(state);
  state.lifecycle = "completed";
  state.completedAt = new Date().toISOString();
  state.updatedAt = state.completedAt;
  state.artifacts = [...new Set([...state.artifacts, "report.json", "report.md", "evidence.jsonl"])];
  store.save(state);
  paths = writeAcceptanceReports(store, state, store.readEvidence(state.runId));
  if (state.disposition === "PASS") {
    if (state.fixture) rmSync(state.fixture.path, { recursive: true, force: true });
    rmSync(productHome, { recursive: true, force: true });
  }
  return { state, reportJson: paths.json, reportMarkdown: paths.markdown };
}
