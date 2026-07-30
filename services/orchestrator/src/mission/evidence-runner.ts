import { spawn, spawnSync } from "node:child_process";
import type { MissionVerificationStrategy, MissionEvidenceStatus, MissionEvidenceType } from "@morrow/contracts";
import type { BrowserController } from "../browser/types.js";

/**
 * Executes a criterion's verification strategy against a workspace and returns
 * concrete evidence. This is the "evidence over narration" engine: a criterion
 * is only ever proven by a real action here, never by an agent's assertion.
 */

export interface EvidenceOutcome {
  type: MissionEvidenceType;
  status: MissionEvidenceStatus;
  summary: string;
  command?: string;
  exitCode?: number;
  /** Truncated combined output; the caller stores it and keeps a reference. */
  output: string;
}

const MAX_OUTPUT = 8000;

// Guard against destructive verification commands sneaking in from a model.
const DANGEROUS = /\b(rm\s+-rf|rmdir\s+\/s|del\s+\/|format\s|mkfs|dd\s+if=|:\(\)\s*\{|shutdown|reboot|git\s+push\s+--force|git\s+reset\s+--hard\s+HEAD~|>\s*\/dev\/sd)/i;

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS.test(command);
}

/** A service started for the duration of one gate. `stop` must be idempotent. */
export interface ServiceHandle {
  stop(): Promise<void>;
  /** Output captured so far — surfaced when the service never becomes ready. */
  output(): string;
  /** Set when the process died on its own before the gate finished. */
  exited(): { code: number | null } | null;
}

export interface RunOptions {
  workspacePath: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a real spawn. */
  exec?: (command: string, cwd: string, timeoutMs: number) => Promise<{ exitCode: number; output: string; timedOut: boolean }>;
  /** Injectable HTTP probe for tests. */
  httpProbe?: (url: string) => Promise<{ status: number; ok: boolean; error?: string }>;
  /** Injectable git diff name-only lister. */
  gitChangedFiles?: (cwd: string) => Promise<string[]>;
  /**
   * Start a long-running service in the background for the duration of a gate.
   * A service gate cannot use `exec`: a server that never exits would consume
   * the whole command timeout and then be killed, which is exactly how a
   * working app failed every startup, API-health and browser check.
   */
  startService?: (command: string, cwd: string) => Promise<ServiceHandle>;
  /** Browser factory for `browser` gates. Absent → browser gates stay inconclusive. */
  browser?: () => BrowserController;
  /** How long a service may take to become ready. Bounded, never unlimited. */
  readinessTimeoutMs?: number;
}

/** Viewports every browser gate must render at. */
export const GATE_VIEWPORTS = [
  { width: 1280, height: 800, label: "desktop" },
  { width: 375, height: 812, label: "mobile" },
] as const;

export async function runVerification(
  strategy: MissionVerificationStrategy,
  opts: RunOptions,
): Promise<EvidenceOutcome> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const exec = opts.exec ?? defaultExec;

  switch (strategy.kind) {
    case "command":
    case "test":
    case "build":
    case "typecheck":
    case "lint":
    case "runtime": {
      // A service command is a *service* gate, not a command gate: start it,
      // prove it answers, then always stop it. Running `npm start` through
      // `exec` can only ever time out, because a working server never exits.
      if (strategy.command && (strategy.service || strategy.url)) {
        return runServiceGate(strategy, opts, mapType(strategy.kind));
      }
      if (!strategy.command) {
        return { type: mapType(strategy.kind), status: "inconclusive", summary: `No command supplied for ${strategy.kind} verification`, output: "" };
      }
      if (isDangerousCommand(strategy.command)) {
        return { type: mapType(strategy.kind), status: "inconclusive", summary: "Refused to run a potentially destructive verification command", command: strategy.command, output: "" };
      }
      const expect = strategy.expectExitCode ?? 0;
      const res = await exec(strategy.command, opts.workspacePath, timeoutMs);
      const status: MissionEvidenceStatus = res.timedOut ? "inconclusive" : res.exitCode === expect ? "passed" : "failed";
      const summary = res.timedOut
        ? `\`${strategy.command}\` timed out after ${timeoutMs}ms`
        : `\`${strategy.command}\` exited ${res.exitCode} (expected ${expect})`;
      return { type: mapType(strategy.kind), status, summary, command: strategy.command, exitCode: res.exitCode, output: res.output };
    }
    case "http": {
      if (!strategy.url) return { type: "http", status: "inconclusive", summary: "No URL supplied for http verification", output: "" };
      const probe = opts.httpProbe ?? defaultHttpProbe;
      const expect = strategy.expectStatus ?? 200;
      const res = await probe(strategy.url);
      if (res.error) return { type: "http", status: "inconclusive", summary: `Could not reach ${strategy.url}: ${res.error}`, output: res.error };
      const status: MissionEvidenceStatus = res.status === expect ? "passed" : "failed";
      return { type: "http", status, summary: `GET ${strategy.url} → ${res.status} (expected ${expect})`, output: `status ${res.status}` };
    }
    case "diff": {
      const lister = opts.gitChangedFiles ?? defaultGitChangedFiles;
      const changed = await lister(opts.workspacePath);
      if (!strategy.pathScope) {
        return { type: "diff", status: "inconclusive", summary: `${changed.length} file(s) changed; no path scope to check against`, output: changed.join("\n") };
      }
      const scope = strategy.pathScope;
      const outside = changed.filter((f) => !matchesScope(f, scope));
      const status: MissionEvidenceStatus = outside.length === 0 ? "passed" : "failed";
      const summary = outside.length === 0
        ? `All ${changed.length} changed file(s) are within ${scope}`
        : `${outside.length} change(s) outside ${scope}: ${outside.slice(0, 5).join(", ")}`;
      return { type: "diff", status, summary, output: changed.join("\n") };
    }
    case "browser": {
      const addressable = strategy.url || (strategy.command && strategy.service);
      if (!addressable || !opts.browser) {
        return { type: "browser", status: "inconclusive", summary: strategy.describe ?? "browser verification requires a URL and a browser", output: "" };
      }
      return runBrowserGate(strategy, opts);
    }
    case "manual":
    case "review":
    case "artifact":
    default:
      // These require an external observation the runner cannot produce itself.
      return { type: mapType(strategy.kind), status: "inconclusive", summary: strategy.describe ?? `${strategy.kind} verification requires an external observation`, output: "" };
  }
}

/**
 * Start the service, wait for it to answer, record what happened, stop it.
 *
 * Every exit path goes through `finally`, so a gate can fail, time out or throw
 * without leaving a stray server holding a port.
 */
async function runServiceGate(
  strategy: MissionVerificationStrategy,
  opts: RunOptions,
  type: MissionEvidenceType,
): Promise<EvidenceOutcome> {
  const command = strategy.command!;
  if (isDangerousCommand(command)) {
    return { type, status: "inconclusive", summary: "Refused to run a potentially destructive verification command", command, output: "" };
  }
  const start = opts.startService ?? defaultStartService;
  const probe = opts.httpProbe ?? defaultHttpProbe;
  const expect = strategy.expectStatus ?? 200;
  const readinessMs = opts.readinessTimeoutMs ?? 30_000;

  let service: ServiceHandle | null = null;
  try {
    service = await start(command, opts.workspacePath);
  } catch (error) {
    return { type, status: "failed", summary: `Could not start \`${command}\`: ${error instanceof Error ? error.message : String(error)}`, command, output: "" };
  }
  try {
    const url = strategy.url ?? await discoverServiceUrl(service, readinessMs);
    if (!url) {
      return {
        type,
        status: "inconclusive",
        summary: `\`${command}\` did not announce a URL to probe within ${readinessMs}ms`,
        command,
        output: `$ ${command}\n${service.output()}`.slice(0, MAX_OUTPUT),
      };
    }
    if (!isLoopbackUrl(url)) {
      return { type, status: "inconclusive", summary: `Refused to probe a non-local verification URL: ${url}`, command, output: "" };
    }
    const ready = await waitForService(service, url, probe, expect, readinessMs);
    const output = `$ ${command}\n${service.output()}`.slice(0, MAX_OUTPUT);
    if (ready.status === "ready") {
      return { type, status: "passed", summary: `\`${command}\` served ${url} → ${ready.httpStatus} (expected ${expect})`, command, output };
    }
    if (ready.status === "exited") {
      return { type, status: "failed", summary: `\`${command}\` exited (code ${ready.exitCode ?? "unknown"}) before serving ${url}`, command, ...(ready.exitCode === null ? {} : { exitCode: ready.exitCode }), output };
    }
    if (ready.status === "wrong_status") {
      return { type, status: "failed", summary: `${url} answered ${ready.httpStatus} (expected ${expect})`, command, output };
    }
    return { type, status: "failed", summary: `\`${command}\` did not serve ${url} within ${readinessMs}ms (last error: ${ready.lastError ?? "no response"})`, command, output };
  } finally {
    await service.stop().catch(() => undefined);
  }
}

type ReadinessResult =
  | { status: "ready"; httpStatus: number }
  | { status: "wrong_status"; httpStatus: number }
  | { status: "exited"; exitCode: number | null }
  | { status: "timeout"; lastError: string | null };

/** Poll until the service answers, it dies, or the deadline passes. */
async function waitForService(
  service: ServiceHandle,
  url: string,
  probe: (url: string) => Promise<{ status: number; ok: boolean; error?: string }>,
  expect: number,
  readinessMs: number,
): Promise<ReadinessResult> {
  const deadline = Date.now() + readinessMs;
  let lastError: string | null = null;
  let sawResponse = false;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const exited = service.exited();
    // A process that exited may still have answered first (a wrapper script
    // handing off). Only call it dead when nothing ever responded.
    if (exited && !sawResponse) return { status: "exited", exitCode: exited.code };
    const res = await probe(url);
    if (!res.error) {
      sawResponse = true;
      lastStatus = res.status;
      if (res.status === expect) return { status: "ready", httpStatus: res.status };
    } else {
      lastError = res.error;
    }
    await delay(250);
  }
  if (sawResponse) return { status: "wrong_status", httpStatus: lastStatus };
  return { status: "timeout", lastError };
}

/**
 * Render the page at every required viewport and report what the browser
 * actually saw — including console errors, which are a real defect signal that
 * a passing HTTP probe hides completely.
 */
async function runBrowserGate(
  strategy: MissionVerificationStrategy,
  opts: RunOptions,
): Promise<EvidenceOutcome> {
  const readinessMs = opts.readinessTimeoutMs ?? 30_000;
  let service: ServiceHandle | null = null;
  const lines: string[] = [];
  let url = strategy.url ?? "";
  if (url && !isLoopbackUrl(url)) {
    return { type: "browser", status: "inconclusive", summary: `Refused to render a non-local verification URL: ${url}`, output: "" };
  }

  try {
    if (strategy.command) {
      if (isDangerousCommand(strategy.command)) {
        return { type: "browser", status: "inconclusive", summary: "Refused to run a potentially destructive verification command", command: strategy.command, output: "" };
      }
      const start = opts.startService ?? defaultStartService;
      service = await start(strategy.command, opts.workspacePath);
      const discovered = url || await discoverServiceUrl(service, readinessMs);
      if (!discovered) {
        return {
          type: "browser",
          status: "inconclusive",
          summary: `\`${strategy.command}\` did not announce a URL to render within ${readinessMs}ms`,
          command: strategy.command,
          output: service.output().slice(0, MAX_OUTPUT),
        };
      }
      if (!isLoopbackUrl(discovered)) {
        return { type: "browser", status: "inconclusive", summary: `Refused to render a non-local verification URL: ${discovered}`, command: strategy.command, output: "" };
      }
      url = discovered;
      const probe = opts.httpProbe ?? defaultHttpProbe;
      const ready = await waitForService(service, url, probe, strategy.expectStatus ?? 200, readinessMs);
      if (ready.status !== "ready") {
        return {
          type: "browser",
          status: "failed",
          summary: `\`${strategy.command}\` never served ${url}, so the UI could not be rendered`,
          command: strategy.command,
          output: service.output().slice(0, MAX_OUTPUT),
        };
      }
      lines.push(`service: \`${strategy.command}\` serving ${url}`);
    }

    const browser = opts.browser!();
    try {
      await browser.start();
      const problems: string[] = [];
      for (const viewport of GATE_VIEWPORTS) {
        await browser.setViewport({ width: viewport.width, height: viewport.height, label: viewport.label });
        const snapshot = await browser.open(url);
        const text = snapshot.text.trim();
        lines.push(`${viewport.label} ${viewport.width}x${viewport.height}: title=${JSON.stringify(snapshot.title)} refs=${snapshot.refs.length} text=${text.length} chars`);
        // A blank page is the failure this gate exists to catch: the server
        // answers 200 and the app renders nothing.
        if (text.length === 0 && snapshot.refs.length === 0) {
          problems.push(`nothing rendered at ${viewport.label} ${viewport.width}x${viewport.height}`);
        }
      }
      const consoleErrors = browser.evidence().filter((entry) => entry.kind === "page-error"
        || (entry.kind === "console" && /error/i.test(String(entry.detail.type ?? ""))));
      for (const entry of consoleErrors) lines.push(`console error: ${entry.message}`);
      if (consoleErrors.length > 0) problems.push(`${consoleErrors.length} console error(s)`);

      const output = lines.join("\n").slice(0, MAX_OUTPUT);
      return problems.length === 0
        ? { type: "browser", status: "passed", summary: `${url} rendered at ${GATE_VIEWPORTS.map((v) => `${v.width}x${v.height}`).join(" and ")} with no console errors`, ...(strategy.command ? { command: strategy.command } : {}), output }
        : { type: "browser", status: "failed", summary: `${url}: ${problems.join("; ")}`, ...(strategy.command ? { command: strategy.command } : {}), output };
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    return {
      type: "browser",
      status: "inconclusive",
      summary: `Browser verification could not run: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500),
      output: lines.join("\n").slice(0, MAX_OUTPUT),
    };
  } finally {
    if (service) await service.stop().catch(() => undefined);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * A verification gate exists to prove the service this mission just started, so
 * it may only ever address the local machine. Criteria can originate from a
 * planning model, and without this a generated `url` would turn the evidence
 * runner into a request-forger against whatever it named.
 */
export function isLoopbackUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

/** `http://localhost:3000`, or a bare port from "Listening on port 3000". */
const URL_IN_OUTPUT = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d{2,5}))?[^\s"'<>]*/i;
const PORT_IN_OUTPUT = /(?:\bport\b\D{0,10}|:)(\d{4,5})\b/i;

/** The port a freshly generated app binds is not knowable in advance, so take
 *  it from what the service itself announces. Bounded by the same deadline as
 *  readiness; no scanning, no guessing at ports we were never told about. */
export function serviceUrlFromOutput(output: string): string | null {
  const direct = output.match(URL_IN_OUTPUT);
  if (direct) {
    // 0.0.0.0 is a bind address, not an address to connect to.
    return direct[0].replace("0.0.0.0", "127.0.0.1").replace(/[.,;]$/, "");
  }
  const port = output.match(PORT_IN_OUTPUT);
  if (port?.[1]) return `http://127.0.0.1:${port[1]}/`;
  return null;
}

async function discoverServiceUrl(service: ServiceHandle, readinessMs: number): Promise<string | null> {
  const deadline = Date.now() + readinessMs;
  while (Date.now() < deadline) {
    const url = serviceUrlFromOutput(service.output());
    if (url) return url;
    if (service.exited()) return serviceUrlFromOutput(service.output());
    await delay(250);
  }
  return serviceUrlFromOutput(service.output());
}

/**
 * Background service launcher. Mirrors the tool executor's process-tree kill so
 * a stopped service takes its children (a shell wrapper, a package-manager
 * shim) with it instead of orphaning the process that holds the port.
 */
function defaultStartService(command: string, cwd: string): Promise<ServiceHandle> {
  const isWin = process.platform === "win32";
  const shell = isWin ? "cmd.exe" : "/bin/sh";
  const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
  const child = spawn(shell, args, { cwd, windowsHide: true, ...(isWin ? {} : { detached: true }) });

  let output = "";
  let exit: { code: number | null } | null = null;
  let stopped = false;
  const onData = (buf: Buffer) => { if (output.length < MAX_OUTPUT) output += buf.toString("utf8"); };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  child.on("error", (err) => { output += String(err); exit = { code: null }; });
  child.on("close", (code) => { exit = { code }; });

  return Promise.resolve({
    output: () => output.slice(0, MAX_OUTPUT),
    exited: () => exit,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (isWin) {
        if (child.pid) {
          const killed = spawnSync("taskkill", ["/F", "/T", "/PID", String(child.pid)], { shell: false, windowsHide: true });
          if (killed.status !== 0) { try { child.kill("SIGKILL"); } catch { /* already gone */ } }
        }
      } else {
        try {
          if (child.pid) process.kill(-child.pid, "SIGKILL");
        } catch {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }
    },
  });
}

function mapType(kind: MissionVerificationStrategy["kind"]): MissionEvidenceType {
  return kind as MissionEvidenceType;
}

function matchesScope(file: string, scope: string): boolean {
  const f = file.replace(/\\/g, "/");
  const s = scope.replace(/\\/g, "/");
  if (s.endsWith("/**")) return f.startsWith(s.slice(0, -3) + "/") || f === s.slice(0, -3);
  if (s.endsWith("/")) return f.startsWith(s);
  if (s.includes("*")) {
    const re = new RegExp("^" + s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return re.test(f);
  }
  return f === s || f.startsWith(s + "/");
}

function defaultExec(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const isWin = process.platform === "win32";
    const shell = isWin ? "cmd.exe" : "/bin/sh";
    const args = isWin ? ["/d", "/s", "/c", command] : ["-c", command];
    const child = spawn(shell, args, { cwd, windowsHide: true });
    let output = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    const onData = (buf: Buffer) => { if (output.length < MAX_OUTPUT) output += buf.toString("utf8"); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => { clearTimeout(timer); resolve({ exitCode: 127, output: String(err), timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, output: output.slice(0, MAX_OUTPUT), timedOut }); });
  });
}

async function defaultHttpProbe(url: string): Promise<{ status: number; ok: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return { status: res.status, ok: res.ok };
  } catch (err) {
    return { status: 0, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function defaultGitChangedFiles(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    const child = spawn("git", ["status", "--porcelain"], { cwd, windowsHide: true });
    let out = "";
    child.stdout?.on("data", (b: Buffer) => { out += b.toString("utf8"); });
    child.on("error", () => resolve([]));
    child.on("close", () => {
      const files = out.split("\n").map((l) => l.slice(3).trim()).filter(Boolean).map((f) => f.replace(/^"|"$/g, ""));
      resolve(files);
    });
  });
}
