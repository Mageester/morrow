/**
 * `morrow build "<what you want>"` — start a whole new project from nothing.
 *
 * Morrow already has a durable mission engine that can build software; what it
 * lacked was a way in when the project does not exist yet. Every existing entry
 * point resolves an *existing* workspace first, so building something new meant
 * the user had to guess the preamble: make a directory, cd into it, `git init`,
 * `morrow init`, and only then describe the work. That is a lot of ceremony
 * before the first useful moment.
 *
 * This command collapses that into one step: pick a safe empty directory,
 * register it, and hand the objective to the same mission engine.
 *
 * Two deliberate safety properties:
 *
 *  - **It will not build into a directory that already has contents.** A fresh
 *    build starts in an empty (or brand-new) directory, so an autonomous run
 *    can never be pointed at existing work it might overwrite. `--force` is the
 *    explicit opt-out for an intentionally non-empty target.
 *  - **Autonomy is scoped to the new directory.** Building a new project in its
 *    own empty workspace is exactly the case where autonomous execution is
 *    safe, so it is the default here — but it is still the workspace-scoped
 *    autonomy the rest of Morrow uses, with the same hard denials, audit trail,
 *    and undo. `--no-yolo` steps back to approval-per-change.
 */
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Context } from "../cli/context.js";
import { EXIT, usageError } from "../cli/errors.js";
import { flagBool, flagString } from "../cli/args.js";
import { ensureRunning } from "../service/lifecycle.js";
import { runMission } from "./mission.js";
import { isSafeProjectRoot } from "./common.js";

/**
 * Turn a free-text description into a plausible directory name.
 *
 * This only has to produce something short, safe, and recognisable — the user
 * can always override it with `--name`. It must never produce a path segment
 * that escapes the parent directory, so everything outside a conservative
 * character set is dropped rather than transliterated.
 */
export function slugForProject(description: string): string {
  const slug = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 5)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "morrow-project";
}

/** True when a path is a directory that already contains something. */
export function directoryHasContents(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    if (!statSync(path).isDirectory()) return true;
    return readdirSync(path).length > 0;
  } catch {
    // Unreadable is not the same as empty; refuse rather than assume.
    return true;
  }
}

/**
 * The flags handed to the mission engine's own `Context`, scoped to the
 * project `build` just created.
 *
 * `--in` selected the directory that became this project; carrying it forward
 * makes `resolveProject` see both `--in` and `--project` and reject the
 * context outright ("--in and --project both select a workspace"), which
 * turned every `morrow build --in <dir>` into a dead end. `--in` did its job
 * choosing the workspace — `--project` is now the authoritative selector for
 * everything downstream, so `--in` is cleared here rather than carried along.
 */
export function buildContextFlags(
  flags: Record<string, string | boolean>,
  projectId: string,
  autonomous: boolean,
): Record<string, string | boolean> {
  const next: Record<string, string | boolean> = { ...flags, project: projectId, ...(autonomous ? { yolo: true } : {}) };
  delete next.in;
  return next;
}

export async function buildCommand(ctx: Context, args: string[]): Promise<number> {
  const description = args.filter(Boolean).join(" ").trim();
  if (!description) {
    ctx.out.info('Usage: morrow build "<what you want built>" [--in <directory>] [--name <name>]');
    ctx.out.info("");
    ctx.out.info("Creates a new project directory, registers it, and builds it end to end.");
    ctx.out.info('Example: morrow build "a CLI todo app in TypeScript with tests"');
    return EXIT.USAGE;
  }

  await ensureRunning(ctx);
  const api = ctx.api();

  const name = flagString(ctx.flags, "name") ?? slugForProject(description);
  const requested = flagString(ctx.flags, "in");
  const target = requested
    ? isAbsolute(requested)
      ? resolve(requested)
      : resolve(process.cwd(), requested)
    : join(resolve(process.cwd()), name);
  const force = flagBool(ctx.flags, "force");

  // Scope is checked before emptiness, because it is the more fundamental
  // objection and the more useful message. Told only "your home directory is
  // not empty", a user might reasonably try to empty it; the real problem is
  // that a home directory is far too broad to scope an autonomous build to.
  const safety = isSafeProjectRoot(target);
  if (!safety.safe && !force) {
    throw usageError(
      `Refusing to build in ${target}`,
      `${safety.reason}. Choose a narrower directory with --in, or pass --force if you intend this scope.`
    );
  }

  if (directoryHasContents(target) && !force) {
    throw usageError(
      `${target} already has contents.`,
      "A new build starts in an empty directory so it cannot overwrite existing work. Choose another path with --in, or pass --force to build here anyway."
    );
  }

  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
    ctx.out.info(`Created ${target}`);
  }

  const project = await api.createProject(name, target);
  ctx.out.success(`New project "${project.name}" — ${project.workspacePath}`);

  // Scope every subsequent step to the project just created, so the mission can
  // never resolve to some previously-saved default workspace.
  const autonomous = !flagBool(ctx.flags, "no-yolo");
  const buildCtx = new (ctx.constructor as typeof Context)({
    out: ctx.out,
    config: ctx.config,
    paths: ctx.paths,
    flags: buildContextFlags(ctx.flags, project.id, autonomous),
  });

  ctx.out.info(
    autonomous
      ? "Building autonomously inside this workspace. Every change is logged and reversible; `morrow panic` stops it."
      : "Building with approval required for each change."
  );

  return runMission(buildCtx, api, description);
}
