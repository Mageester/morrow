import { spawn } from "node:child_process";
import type { MissionVerificationStrategy, MissionEvidenceStatus, MissionEvidenceType } from "@morrow/contracts";

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

export interface RunOptions {
  workspacePath: string;
  timeoutMs?: number;
  /** Injectable for tests; defaults to a real spawn. */
  exec?: (command: string, cwd: string, timeoutMs: number) => Promise<{ exitCode: number; output: string; timedOut: boolean }>;
  /** Injectable HTTP probe for tests. */
  httpProbe?: (url: string) => Promise<{ status: number; ok: boolean; error?: string }>;
  /** Injectable git diff name-only lister. */
  gitChangedFiles?: (cwd: string) => Promise<string[]>;
}

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
    case "manual":
    case "review":
    case "browser":
    case "artifact":
    default:
      // These require an external observation the runner cannot produce itself.
      return { type: mapType(strategy.kind), status: "inconclusive", summary: strategy.describe ?? `${strategy.kind} verification requires an external observation`, output: "" };
  }
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
