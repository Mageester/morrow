import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { isDeniedWorkspacePath } from "../workspace/safe-reader.js";

export class GitInspectionError extends Error {
  readonly code = "git_inspection_rejected";
  constructor(message: string) { super(message); }
}

export type GitInspectionOptions = { maxOutputBytes?: number; timeoutMs?: number; signal?: AbortSignal; limit?: number };
export type GitStatusResult = { lines: string[]; truncated: boolean; timedOut: boolean };
export type GitDiffResult = { files: Array<{ path: string; diff: string }>; truncated: boolean; timedOut: boolean };
export type GitLogResult = { commits: Array<{ hash: string; subject: string; committedAt: string }>; truncated: boolean; timedOut: boolean };

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 1_000;
const DEFAULT_LOG_LIMIT = 20;

type ProcessResult = { stdout: string; stderr: string; exitCode: number | null; truncated: boolean; timedOut: boolean };

function bounded(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) throw new GitInspectionError(`${name} must be a positive integer`);
  return result;
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\b(api[_-]?key|token|secret|password)\b\s*([=:])\s*(['"]?)[^\s'"`]+\3/gi, "$1$2[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]");
}

function safePath(value: string): boolean {
  const path = value.trim().replace(/^"|"$/g, "").replace(/\\/g, "/");
  return Boolean(path) && !path.startsWith(".git/") && !isDeniedWorkspacePath(path);
}

async function runGit(root: string, args: string[], options: GitInspectionOptions = {}): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new GitInspectionError("Git inspection cancelled");
  let cwd: string;
  try {
    cwd = realpathSync(root);
  } catch {
    throw new GitInspectionError("Workspace is inaccessible");
  }
  const maxOutputBytes = bounded(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
  const timeoutMs = bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");

  return new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const stop = () => {
      if (!child.killed) child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const cancel = () => {
      cancelled = true;
      stop();
    };
    options.signal?.addEventListener("abort", cancel, { once: true });

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (settled || truncated) return;
      const remaining = maxOutputBytes - bytes;
      if (remaining <= 0) {
        truncated = true;
        stop();
        return;
      }
      const part = chunk.subarray(0, remaining);
      target.push(part);
      bytes += part.length;
      if (part.length < chunk.length || bytes >= maxOutputBytes) {
        truncated = true;
        stop();
      }
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      reject(new GitInspectionError(`Unable to start git: ${error.message}`));
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (cancelled) {
        reject(new GitInspectionError("Git inspection cancelled"));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode, truncated, timedOut });
    });
  });
}

function ensureSuccess(result: ProcessResult): ProcessResult {
  if (result.timedOut || result.truncated || result.exitCode === 0) return result;
  throw new GitInspectionError(redactSecrets(result.stderr.trim() || "Git command failed"));
}

export async function gitStatus(root: string, options: GitInspectionOptions = {}): Promise<GitStatusResult> {
  const result = ensureSuccess(await runGit(root, ["status", "--porcelain=v1", "--branch"], options));
  const lines = result.stdout.split(/\r?\n/).filter((line) => {
    if (!line) return false;
    if (line.startsWith("## ")) return true;
    return safePath(line.slice(3));
  }).map(redactSecrets);
  return { lines, truncated: result.truncated, timedOut: result.timedOut };
}

export async function gitDiff(root: string, options: GitInspectionOptions = {}): Promise<GitDiffResult> {
  const maxOutputBytes = bounded(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
  const names = ensureSuccess(await runGit(root, ["diff", "--name-only", "-z"], { ...options, maxOutputBytes }));
  const paths = names.stdout.split("\0").filter(safePath);
  const files: Array<{ path: string; diff: string }> = [];
  let remaining = maxOutputBytes;
  let truncated = names.truncated;
  let timedOut = names.timedOut;

  for (const path of paths) {
    if (options.signal?.aborted) throw new GitInspectionError("Git inspection cancelled");
    if (remaining < 1 || timedOut) {
      truncated = true;
      break;
    }
    const result = ensureSuccess(await runGit(root, ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", "--", path], { ...options, maxOutputBytes: remaining }));
    const diff = redactSecrets(result.stdout);
    files.push({ path, diff });
    remaining -= Buffer.byteLength(diff, "utf8");
    truncated ||= result.truncated;
    timedOut ||= result.timedOut;
    if (result.truncated || result.timedOut) break;
  }
  return { files, truncated, timedOut };
}

export async function gitLog(root: string, options: GitInspectionOptions = {}): Promise<GitLogResult> {
  const limit = bounded(options.limit, DEFAULT_LOG_LIMIT, "limit");
  const result = ensureSuccess(await runGit(root, ["log", "--no-decorate", `-n${limit}`, "--format=%H%x09%s%x09%aI"], options));
  const commits = result.stdout.split(/\r?\n/).filter(Boolean).map(redactSecrets).flatMap((line) => {
    const [hash, subject, committedAt] = line.split("\t");
    return hash && subject && committedAt ? [{ hash, subject, committedAt }] : [];
  });
  return { commits, truncated: result.truncated, timedOut: result.timedOut };
}
