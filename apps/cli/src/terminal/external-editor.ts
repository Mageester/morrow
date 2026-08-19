import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Compose a long prompt in a real editor.
 *
 * A terminal composer is fine for a sentence and miserable for a spec. Every
 * comparable CLI has this; Morrow had no way out of a one-line box.
 *
 * Ink owns the TTY in raw mode, so the handoff matters more than the spawn:
 * raw mode goes off, the child inherits the real terminal, and `spawnSync`
 * blocks the loop so Ink cannot paint over an editor that is on screen. The
 * caller restores raw mode afterwards — this module deliberately does no
 * terminal state management of its own, because a helper that half-owns the
 * TTY is how a shell ends up wedged.
 */

/** The editor to use, in the order a user would expect it to be honoured. */
export function editorCommand(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const configured = env.MORROW_EDITOR?.trim() || env.VISUAL?.trim() || env.EDITOR?.trim();
  if (configured) return configured;
  return platform === "win32" ? "notepad" : "nano";
}

/** Quote a path for the platform shell, for the one branch that needs one. */
export function quoteArgument(value: string, platform: NodeJS.Platform): string {
  // cmd.exe has no escape for a quote inside a quoted string; a temp path
  // cannot contain one, and stripping is safer than emitting broken syntax.
  if (platform === "win32") return `"${value.replaceAll('"', "")}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface ExternalEditResult {
  /** The edited text, or null when nothing usable came back. */
  text: string | null;
  /** Why, when it did not work. */
  error?: string;
}

/**
 * Hand `text` to an editor and return what came back.
 *
 * `.md` because a prompt is prose, and every editor's markdown mode is kinder
 * to it than a plain buffer.
 */
export function editExternally(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ExternalEditResult {
  const command = editorCommand(env, platform);
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "morrow-compose-"));
    const file = join(dir, "message.md");
    writeFileSync(file, text, "utf8");
    // A shell is used only when the configured editor carries its own flags
    // ("code -w"), because that form has to be word-split to work at all.
    //
    // It is NOT used for a bare command, and that distinction matters: with
    // `shell: true` Node concatenates argv without escaping (DEP0190), so the
    // temp path gets word-split too. Any Windows account whose username holds
    // a space — C:\Users\John Smith\AppData\... — had the editor opening
    // C:\Users\John instead of the draft.
    const needsShell = /\s/.test(command);
    const result = needsShell
      ? spawnSync(`${command} ${quoteArgument(file, platform)}`, { stdio: "inherit", shell: true, windowsHide: false })
      : spawnSync(command, [file], { stdio: "inherit", windowsHide: false });
    if (result.error) return { text: null, error: `${command} could not be started (${result.error.message})` };
    if (typeof result.status === "number" && result.status !== 0) {
      return { text: null, error: `${command} exited with status ${result.status}` };
    }
    // Trailing newlines are the editor's, not the user's.
    return { text: readFileSync(file, "utf8").replace(/\s+$/, "") };
  } catch (error) {
    return { text: null, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // A temp directory that will not delete is not worth failing an edit over.
      }
    }
  }
}
