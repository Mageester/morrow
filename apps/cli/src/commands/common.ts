import { createInterface } from "node:readline";
import { basename } from "node:path";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Project } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import { MorrowApi } from "../client/api.js";
import { CliError, EXIT, notFound, usageError } from "../cli/errors.js";
import { flagString } from "../cli/args.js";

export function isInteractive(ctx: Context): boolean {
  return Boolean(process.stdin.isTTY) && !ctx.out.json && !ctx.out.quiet;
}

/**
 * Resolve the active project from --project (id | name | workspace path) or the
 * configured default. Throws a clear error when none can be resolved.
 */
export async function resolveProject(
  ctx: Context,
  api: MorrowApi,
  opts: { required?: boolean; autoCreateMissing?: boolean } = {},
): Promise<Project | null> {
  const flag = flagString(ctx.flags, "project");
  const configured = ctx.config.get("defaults.project") as string | undefined;
  const ref = flag ?? configured;
  const projects = await api.listProjects();

  if (!ref) {
    const cwdProject = matchProjectByPath(projects, process.cwd());
    if (cwdProject) return cwdProject;
    if (opts.autoCreateMissing) return autoCreateProjectForPath(ctx, api, process.cwd());
    if (projects.length === 1) return projects[0]!;
    if (!opts.required) return null;
    throw usageError(
      "No project selected.",
      "Pass --project <id|path>, run `morrow projects select`, or add one with `morrow projects add`."
    );
  }

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
  let canonical = ref;
  try {
    if (existsSync(ref)) canonical = realpathSync(ref);
  } catch {
    /* ignore */
  }
  return projects.find((p) => p.workspacePath === canonical || p.workspacePath === ref);
}

async function autoCreateProjectForPath(ctx: Context, api: MorrowApi, ref: string): Promise<Project> {
  const canonical = validateDirectory(ref);
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
