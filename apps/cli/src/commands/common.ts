import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { Project } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import { MorrowApi } from "../client/api.js";
import { CliError, EXIT, notFound, usageError } from "../cli/errors.js";
import { flagBool, flagString } from "../cli/args.js";
import { ask, askMultiline, askSecret, confirm, select } from "../cli/prompts.js";

export { ask, askMultiline, askSecret, confirm, select };

export function isInteractive(ctx: Context): boolean {
  return Boolean(process.stdin.isTTY) && !ctx.out.json && !ctx.out.quiet;
}

/**
 * Resolve the active project with a strict, safety-first precedence:
 *
 *   1. Explicit `--project <id|name|path>` (an intentional override).
 *   2. A registered project whose workspace IS (or contains) the current
 *      directory, or the nearest parent Git root. This comes BEFORE the
 *      configured default so a command launched inside project B can never
 *      silently operate on project A just because A is the saved default.
 *   3. Only once cwd matches no registered workspace does the configured
 *      default even become a candidate — and reaching for it always means
 *      resuming a DIFFERENT workspace than cwd, never an automatic act: a
 *      human present gets an explicit choice, everyone else (one-shot,
 *      --json, CI, PTY-driven automation with no one to answer a prompt)
 *      gets a hard refusal naming exactly why and how to proceed explicitly.
 *      Commands that tolerate no project at all (`required: false`) simply
 *      proceed unscoped instead of being silently attributed to it.
 *   4. Interactive selection or an actionable error when there is no
 *      candidate of any kind.
 *
 * The only automatic (non-prompted, non-refused) resolution is cwd matching
 * a durable, registered workspace — steps 1-2. Everything past that point is
 * either an explicit user choice or a refusal, never a silent guess.
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
  const configured = ctx.config.get("defaults.project") as string | undefined;
  const configuredProject = configured ? projects.find((p) => p.id === configured || p.name === configured) : undefined;
  if (configuredProject) {
    const configuredPath = canonicalProjectPath(configuredProject.workspacePath);
    const safety = isSafeProjectRoot(configuredProject.workspacePath);
    if (!safety.safe) {
      throw usageError(
        `Default project "${configuredProject.name}" points at an unsafe workspace (${safety.reason}).`,
        "Run `morrow init` inside a repository or `morrow projects select` to choose a safe project."
      );
    }
    // Onboarding can be launched from a parent repository while registering a
    // clean child workspace. In that case the explicit default is narrower than
    // cwd and must win over the ancestor project so sessions do not cross roots.
    if (containsPath(cwd, configuredPath)) return configuredProject;
  }

  const cwdProjects = nearestContainingProjects(projects, cwd);
  if (cwdProjects.length === 1) return cwdProjects[0]!;
  if (cwdProjects.length > 1) throw usageError("Multiple registered projects match this directory.", "Pass --project <id> to choose one explicitly.");

  // 3. When launched from a subdirectory, select the registered project whose
  //    workspace is the nearest parent Git root. This avoids using stale defaults
  //    while still refusing broad parents such as home or Documents.
  const gitRoot = findNearestGitRoot(cwd);
  if (gitRoot) {
    const matches = projects.filter((p) => samePath(canonicalProjectPath(p.workspacePath), gitRoot) && isSafeProjectRoot(p.workspacePath).safe);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw usageError("Multiple registered projects match this Git repository.", "Pass --project <id> to choose one explicitly.");
  }

  // 4. This directory has no registered project of its own, and no Git-root
  // match either — the only remaining known project is the configured
  // default, which is by definition a DIFFERENT workspace than cwd. That is
  // exactly "a previous task belongs to another workspace": it must never be
  // resumed automatically. Commands that tolerate no project at all
  // (`required: false`, e.g. an unscoped `audit list`) simply proceed with
  // no project rather than being silently attributed to an unrelated one.
  if (configured && configuredProject) {
    if (!opts.required) return null;
    const stillExists = canonicalDirectory(configuredProject.workspacePath) !== null;
    const reason = stillExists
      ? `at a different location (${configuredProject.workspacePath})`
      : "at a location that no longer exists on disk";
    if (isInteractive(ctx)) {
      return interactiveProjectSelection(ctx, api, projects, { project: configuredProject, reason });
    }
    throw usageError(
      `This directory isn't a registered Morrow project. The last-used project, "${configuredProject.name}", is ${reason}.`,
      `Pass --project ${configuredProject.id} to resume it explicitly, --project "${cwd}" to work here instead, or run \`morrow init\` in this directory.`
    );
  }
  // A stale default (project id no longer registered) has no "different
  // workspace" to guard against; fall through to plain interactive selection
  // or refusal below.

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

  // Short-id prefix match — the id form `morrow projects list` prints (first 8
  // chars). Only after exact id/name so an exact match always wins.
  const prefix = matchProjectByIdPrefix(projects, ref);
  if (prefix.project) return prefix.project;
  if (prefix.ambiguous.length > 1) {
    throw usageError(
      `Ambiguous project id "${ref}" — it matches ${prefix.ambiguous.length} projects.`,
      `Matches: ${prefix.ambiguous.map((p) => `${shortId(p.id)} (${p.name})`).join(", ")}. Use a longer id.`,
    );
  }

  throw notFound(`No project matching "${ref}".`);
}

/**
 * Match a project by an id prefix (e.g. the 8-char short id shown by
 * `projects list`). A ref only qualifies as an id prefix when it is a
 * hex/dash token of at least 4 chars, so ordinary names never accidentally
 * prefix-match an id. Returns the unique match, or the ambiguous candidates
 * when more than one id starts with the ref.
 */
export function matchProjectByIdPrefix(
  projects: Project[],
  ref: string,
): { project?: Project; ambiguous: Project[] } {
  if (!/^[0-9a-fA-F-]{4,}$/.test(ref)) return { ambiguous: [] };
  const lower = ref.toLowerCase();
  const matches = projects.filter((p) => p.id.toLowerCase().startsWith(lower));
  if (matches.length === 1) return { project: matches[0]!, ambiguous: [] };
  return { ambiguous: matches };
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

/** All registered projects whose workspace contains `cwd`, tied for the
 *  deepest (most specific) match — usually one, but more than one means two
 *  projects were registered at the same path and the caller must refuse
 *  rather than arbitrarily pick the first, same as the Git-root fallback below. */
function nearestContainingProjects(projects: Project[], cwd: string): Project[] {
  const matches = projects
    .map((project) => ({ project, path: canonicalProjectPath(project.workspacePath), safety: isSafeProjectRoot(project.workspacePath) }))
    .filter((item) => item.safety.safe && containsPath(item.path, cwd))
    .sort((a, b) => b.path.length - a.path.length);
  if (matches.length === 0) return [];
  const bestLength = matches[0]!.path.length;
  return matches.filter((item) => item.path.length === bestLength).map((item) => item.project);
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

/**
 * Blocking, explicit-choice project selection. When `staleDefault` is given,
 * a previous task/default belongs to a different workspace than cwd — this
 * is the ONLY path allowed to resume it, and only via an explicit choice a
 * human actually made, never automatically.
 */
async function interactiveProjectSelection(
  ctx: Context,
  api: MorrowApi,
  projects: Project[],
  staleDefault?: { project: Project; reason: string },
): Promise<Project | null> {
  ctx.out.heading("Choose a project");
  const resumeChoice = staleDefault ? `Resume "${staleDefault.project.name}" anyway` : null;
  if (staleDefault) {
    ctx.out.info(
      `This directory isn't a registered Morrow project. Your last-used project, "${staleDefault.project.name}", is ${staleDefault.reason} — a different workspace than here.`
    );
  } else {
    ctx.out.info("Morrow will not inspect files until a project is explicit.");
  }
  const recent = projects.filter((p) => isSafeProjectRoot(p.workspacePath).safe);
  const choices = [
    ...(resumeChoice ? [resumeChoice] : []),
    ...(recent.length > 0 ? ["Open an existing project"] : []),
    "Register this folder",
    "Initialize this folder",
    "Continue without a project",
    "Exit",
  ];
  const choice = choices[await select(ctx, "When launched outside a project", choices, (item) => item)]!;
  if (resumeChoice && choice === resumeChoice) return staleDefault!.project;
  if (choice === "Open an existing project") {
    const idx = await select(ctx, "Recent projects", recent, (p) => `${p.name}  ${ctx.out.gray(p.workspacePath)}`);
    return recent[idx]!;
  }
  if (choice === "Initialize this folder") {
    const path = await ask("Project directory: ");
    if (!path) return null;
    return autoCreateProjectForPath(ctx, api, path);
  }
  if (choice === "Register this folder") return autoCreateProjectForPath(ctx, api, process.cwd());
  if (choice === "Continue without a project") {
    const quick = await api.quickChat();
    ctx.out.info(`Using filesystem-disabled chat workspace: ${quick.workspacePath}`);
    return api.getProject(quick.projectId);
  }
  throw new CliError("No project selected.", { exitCode: EXIT.CANCELLED, code: "CANCELLED" });
}

// Interactive prompt primitives (ask, askMultiline, askSecret, confirm, select)
// live in ../cli/prompts.js and are re-exported above for existing importers.

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
