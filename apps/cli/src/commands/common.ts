import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Project } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import { MorrowApi } from "../client/api.js";
import { CliError, EXIT, notFound, usageError } from "../cli/errors.js";
import { flagBool, flagString } from "../cli/args.js";

export function isInteractive(ctx: Context): boolean {
  return Boolean(process.stdin.isTTY) && !ctx.out.json && !ctx.out.quiet;
}

/**
 * Resolve the active project with a strict, safety-first precedence:
 *
 *   1. Explicit `--project <id|name|path>` (an intentional override).
 *   2. A registered project whose workspace IS the current directory. This comes
 *      BEFORE the configured default so a command launched inside project B can
 *      never silently operate on project A just because A is the saved default.
 *   3. The configured default project.
 *   4. Interactive selection or an actionable error.
 *
 * Throws a clear error when none can be resolved and `required` is set.
 */
export async function resolveProject(
  ctx: Context,
  api: MorrowApi,
  opts: { required?: boolean; autoCreateMissing?: boolean } = {},
): Promise<Project | null> {
  const flag = flagString(ctx.flags, "project");
  const projects = await api.listProjects();

  // 1. Explicit --project always wins.
  if (flag) return resolveRef(ctx, api, projects, flag, opts);

  const cwd = canonicalDirectory(process.cwd()) ?? resolve(process.cwd());

  // 2. A registered project matching (or containing) the current directory takes
  //    precedence over the configured default. This is the isolation guarantee:
  //    being inside B's workspace selects B, regardless of what default is saved.
  const cwdProject = nearestContainingProject(projects, cwd);
  if (cwdProject) return cwdProject;

  // 3. When launched from a subdirectory, select the registered project whose
  //    workspace is the nearest parent Git root. This avoids using stale defaults
  //    while still refusing broad parents such as home or Documents.
  const gitRoot = findNearestGitRoot(cwd);
  if (gitRoot) {
    const matches = projects.filter((p) => samePath(canonicalProjectPath(p.workspacePath), gitRoot) && isSafeProjectRoot(p.workspacePath).safe);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw usageError("Multiple registered projects match this Git repository.", "Pass --project <id> to choose one explicitly.");
  }

  // 4. The configured default project (only when cwd is not itself a workspace).
  const configured = ctx.config.get("defaults.project") as string | undefined;
  if (configured) {
    const byConfig = projects.find((p) => p.id === configured || p.name === configured);
    if (byConfig) {
      const safety = isSafeProjectRoot(byConfig.workspacePath);
      if (!safety.safe) {
        throw usageError(
          `Default project "${byConfig.name}" points at an unsafe workspace (${safety.reason}).`,
          "Run `morrow init` inside a repository or `morrow projects select` to choose a safe project."
        );
      }
      return byConfig;
    }
    // A stale default (project since removed) should not hard-fail resolution;
    // fall through to explicit interactive selection or a clear refusal below.
  }

  // 5. Interactive users get an explicit choice instead of silent filesystem
  //    access. Non-interactive commands fail with a clear refusal.
  if (isInteractive(ctx)) return interactiveProjectSelection(ctx, api, projects);
  if (!opts.required) return null;
  throw usageError(
    "No safe project selected.",
    "Run `morrow init` inside a Git repository, pass --project <id|path>, or use the interactive `morrow` shell to choose a project."
  );
}

/** Resolve an explicit reference (id, unique name, or workspace path). */
async function resolveRef(
  ctx: Context,
  api: MorrowApi,
  projects: Project[],
  ref: string,
  opts: { autoCreateMissing?: boolean },
): Promise<Project> {
  // Exact id match.
  const byId = projects.find((p) => p.id === ref);
  if (byId) return byId;

  // Workspace path match (resolve to canonical path like the server does).
  if (looksLikePath(ref)) {
    const byPath = matchProjectByPath(projects, ref);
    if (byPath) return byPath;
    if (opts.autoCreateMissing) return autoCreateProjectForPath(ctx, api, ref);
    throw notFound(`No project registered for path "${ref}". Add it with \`morrow projects add ${ref}\`.`);
  }

  // Name match (unique).
  const byName = projects.filter((p) => p.name === ref);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw usageError(`Multiple projects named "${ref}". Use the project id instead.`);

  throw notFound(`No project matching "${ref}".`);
}

function matchProjectByPath(projects: Project[], ref: string): Project | undefined {
  const canonical = canonicalDirectory(ref) ?? ref;
  return projects.find((p) => samePath(canonicalProjectPath(p.workspacePath), canonical));
}

async function autoCreateProjectForPath(ctx: Context, api: MorrowApi, ref: string): Promise<Project> {
  const canonical = validateProjectDirectory(ref, { force: flagBool(ctx.flags, "force") });
  const name = basename(canonical) || canonical;
  const project = await api.createProject(name, canonical);
  ctx.out.info(`Using current workspace as project: ${project.name}`);
  return project;
}

export function looksLikePath(ref: string): boolean {
  return ref.startsWith(".") || ref.startsWith("/") || ref.startsWith("~") || isAbsolute(ref) || ref.includes("/") || ref.includes("\\");
}

export function validateDirectory(path: string): string {
  if (!existsSync(path)) throw usageError(`Path does not exist: ${path}`);
  if (!statSync(path).isDirectory()) throw usageError(`Path is not a directory: ${path}`);
  try {
    return realpathSync(path);
  } catch {
    throw usageError(`Cannot resolve path: ${path}`);
  }
}

export function validateProjectDirectory(path: string, opts: { force?: boolean } = {}): string {
  const canonical = validateDirectory(path);
  const safety = isSafeProjectRoot(canonical);
  if (!safety.safe && !opts.force) {
    throw usageError(
      `Refusing to use unsafe workspace: ${canonical}`,
      `${safety.reason}. Run this from a repository, choose a narrower directory, or repeat with --force if you intentionally want this scope.`
    );
  }
  return canonical;
}

export function findNearestGitRoot(start: string): string | null {
  let dir = canonicalDirectory(start) ?? resolve(start);
  for (let i = 0; i < 80; i++) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function isSafeProjectRoot(path: string): { safe: boolean; reason?: string } {
  const canonical = canonicalDirectory(path) ?? resolve(path);
  const parsed = parse(canonical);
  if (samePath(canonical, parsed.root)) return { safe: false, reason: "Drive roots are too broad" };

  const home = canonicalDirectory(homedir());
  if (home && samePath(canonical, home)) return { safe: false, reason: "Home directories are too broad" };

  const base = basename(canonical).toLowerCase();
  if (["documents", "desktop", "downloads"].includes(base)) return { safe: false, reason: `${basename(canonical)} is a broad user folder` };
  if (base.startsWith("onedrive") && containsManyGitRepos(canonical, 2)) return { safe: false, reason: "OneDrive root contains multiple repositories" };
  if (containsManyGitRepos(canonical, 3)) return { safe: false, reason: "Directory contains many unrelated Git repositories" };
  return { safe: true };
}

function canonicalDirectory(path: string): string | null {
  try {
    if (!existsSync(path) || !statSync(path).isDirectory()) return null;
    return realpathSync(path);
  } catch {
    return null;
  }
}

function canonicalProjectPath(path: string): string {
  return canonicalDirectory(path) ?? path;
}

function samePath(left: string, right: string): boolean {
  return normalizePath(left) === normalizePath(right);
}

function normalizePath(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function nearestContainingProject(projects: Project[], cwd: string): Project | null {
  const matches = projects
    .map((project) => ({ project, path: canonicalProjectPath(project.workspacePath), safety: isSafeProjectRoot(project.workspacePath) }))
    .filter((item) => item.safety.safe && containsPath(item.path, cwd))
    .sort((a, b) => b.path.length - a.path.length);
  return matches[0]?.project ?? null;
}

function containsManyGitRepos(path: string, threshold: number): boolean {
  let count = 0;
  try {
    for (const child of readdirSync(path, { withFileTypes: true }).slice(0, 250)) {
      if (!child.isDirectory()) continue;
      if (existsSync(join(path, child.name, ".git"))) count++;
      if (count >= threshold) return true;
    }
  } catch {
    return false;
  }
  return false;
}

async function interactiveProjectSelection(ctx: Context, api: MorrowApi, projects: Project[]): Promise<Project | null> {
  ctx.out.heading("Choose a project");
  ctx.out.info("Morrow will not inspect files until a project is explicit.");
  const recent = projects.filter((p) => isSafeProjectRoot(p.workspacePath).safe);
  const choices = [
    ...(recent.length > 0 ? ["Open recent project"] : []),
    "Select a directory",
    "Register current directory",
    "Start filesystem-disabled chat",
    "Exit",
  ];
  const choice = choices[await select(ctx, "When launched outside a project", choices, (item) => item)]!;
  if (choice === "Open recent project") {
    const idx = await select(ctx, "Recent projects", recent, (p) => `${p.name}  ${ctx.out.gray(p.workspacePath)}`);
    return recent[idx]!;
  }
  if (choice === "Select a directory") {
    const path = await ask("Project directory: ");
    if (!path) return null;
    return autoCreateProjectForPath(ctx, api, path);
  }
  if (choice === "Register current directory") return autoCreateProjectForPath(ctx, api, process.cwd());
  if (choice === "Start filesystem-disabled chat") {
    const quick = await api.quickChat();
    ctx.out.info(`Using filesystem-disabled chat workspace: ${quick.workspacePath}`);
    return api.getProject(quick.projectId);
  }
  throw new CliError("No project selected.", { exitCode: EXIT.CANCELLED, code: "CANCELLED" });
}

// ── Interactive prompts ───────────────────────────────────────────────────────

export function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function confirm(question: string, defaultYes = false): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await ask(question + suffix)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

/** Numbered single-choice selection from a list. Returns the chosen index. */
export async function select<T>(ctx: Context, title: string, items: T[], render: (item: T) => string): Promise<number> {
  if (items.length === 0) throw new CliError("Nothing to select.", { exitCode: EXIT.USAGE });
  ctx.out.diag("");
  ctx.out.diag(ctx.out.bold(title));
  items.forEach((item, i) => ctx.out.diag(`  ${ctx.out.cyan(String(i + 1))}. ${render(item)}`));
  while (true) {
    const answer = await ask(`Select 1-${items.length}: `);
    const n = Number(answer);
    if (Number.isInteger(n) && n >= 1 && n <= items.length) return n - 1;
    ctx.out.warn("Invalid selection.");
  }
}

const CTRL_C = 3;
const BACKSPACE_A = 8;
const LF = 10;
const CR = 13;
const BACKSPACE_B = 127;

/** Masked secret input (e.g. API keys). Falls back to plain read if not a TTY. */
export function askSecret(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return ask(question);
  return new Promise((resolve) => {
    process.stderr.write(question);
    let value = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        const code = ch.charCodeAt(0);
        if (code === LF || code === CR) {
          finish();
          resolve(value);
          return;
        }
        if (code === CTRL_C) {
          finish();
          process.exit(EXIT.CANCELLED);
        }
        if (code === BACKSPACE_A || code === BACKSPACE_B) {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  if (Number.isNaN(then)) return iso;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
