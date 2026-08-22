import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Context } from "../cli/context.js";
import { CliError, EXIT } from "../cli/errors.js";
import { flagBool } from "../cli/args.js";
import { stop } from "../service/lifecycle.js";

interface UninstallChoices {
  removeApp: boolean;
  removePath: boolean;
  removeShortcuts: boolean;
  removeConfig: boolean;
  removeDatabase: boolean;
  removeLogs: boolean;
  removeCache: boolean;
  removeBackups: boolean;
  dryRun: boolean;
}

interface UninstallTarget {
  label: string;
  path: string;
  exists: boolean;
}

export async function uninstallCommand(ctx: Context): Promise<number> {
  if (flagBool(ctx.flags, "help")) {
    if (ctx.out.json) ctx.out.data({ command: "uninstall", usage: "morrow uninstall [--yes] [--purge-data] [--dry-run]" });
    else printUninstallHelp(ctx);
    return EXIT.OK;
  }

  const installRoot = resolveInstallRoot();
  const binPath = resolveBinDir();
  const choices = await resolveChoices(ctx);
  if (!choices) {
    if (!ctx.out.json) ctx.out.info("Uninstall cancelled. Nothing was removed.");
    return EXIT.OK;
  }
  const targets = buildTargets(ctx, installRoot, choices);

  if (ctx.out.json) {
    ctx.out.data({ choices, installRoot, dataDirectory: ctx.paths.home, targets });
    if (choices.dryRun) return EXIT.OK;
  } else {
    ctx.out.heading("Uninstall Morrow");
    ctx.out.keyValue([
      ["app", installRoot],
      ["data", ctx.paths.home],
      ["mode", choices.dryRun ? "dry run" : "remove selected items"],
    ]);
    ctx.out.print();
    ctx.out.print(ctx.out.bold("Selected removals"));
    for (const target of targets) ctx.out.bullet(`${target.label}: ${target.path}${target.exists ? "" : " (not present)"}`);
  }

  if (choices.dryRun) {
    if (!ctx.out.json) ctx.out.info("Dry run only. Nothing was removed.");
    return EXIT.OK;
  }

  // A service that cannot be stopped must not strand the uninstall. On POSIX
  // nothing holds a file lock, so removal is safe regardless; the previous
  // behaviour let a stop failure throw out of the command *before* a single
  // file was removed, which is how "morrow uninstall" could report a full list
  // of things it was about to delete and then delete none of them.
  let stopped = false;
  let stopProblem: string | null = null;
  try {
    stopped = await stop(ctx);
  } catch (error) {
    stopProblem = error instanceof Error ? error.message : String(error);
    if (process.platform === "win32") {
      throw new CliError(`Morrow could not stop its service, and files are locked while it runs: ${stopProblem}`, {
        code: "UNINSTALL_SERVICE_RUNNING",
        exitCode: EXIT.SERVICE_UNAVAILABLE,
        hint: "Stop the running Morrow, then run `morrow uninstall` again.",
      });
    }
  }
  if (!ctx.out.json) {
    if (stopProblem) ctx.out.warn(`Could not stop the running service: ${stopProblem}`);
    else ctx.out.info(stopped ? "Service stopped." : "Service was not running.");
  }

  if (process.platform === "win32") {
    const script = writeWindowsUninstallScript({ ctx, installRoot, binPath, choices });
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    if (!ctx.out.json) {
      ctx.out.success("Uninstall scheduled. A background cleanup script will finish after this command exits.");
      ctx.out.info(`Cleanup script: ${script}`);
    }
    return EXIT.OK;
  }

  removeSelectedNow(ctx, installRoot, choices);
  if (!ctx.out.json) ctx.out.success("Morrow uninstall complete.");
  return EXIT.OK;
}

function printUninstallHelp(ctx: Context): void {
  ctx.out.print(`Morrow uninstall\n\nUsage:\n  morrow uninstall [--yes] [--purge-data] [--dry-run]\n\nBehavior:\n  - asks for confirmation unless --yes is passed\n  - stops the running Morrow service\n  - removes launcher/shim, shortcuts, and app/runtime files\n  - preserves user data by default\n  - removes user data only with --purge-data\n\nOptions:\n  --yes         do not prompt for confirmation\n  --purge-data  remove local user data too\n  --dry-run     show what would be removed without changing files`);
}

// Returns the resolved removal choices, or null if the user cancelled.
async function resolveChoices(ctx: Context): Promise<UninstallChoices | null> {
  const dryRun = flagBool(ctx.flags, "dry-run");
  const yes = flagBool(ctx.flags, "yes") || flagBool(ctx.flags, "force");
  const removeData = flagBool(ctx.flags, "purge-data") || flagBool(ctx.flags, "remove-data") || flagBool(ctx.flags, "purge");
  const keepData = flagBool(ctx.flags, "keep-data");

  if (removeData && keepData) throw new CliError("Choose either --purge-data or --keep-data, not both.", { exitCode: EXIT.USAGE });

  const defaults: UninstallChoices = {
    removeApp: true,
    removePath: true,
    removeShortcuts: true,
    removeConfig: removeData,
    removeDatabase: removeData,
    removeLogs: removeData,
    removeCache: removeData,
    removeBackups: removeData,
    dryRun,
  };

  if (ctx.out.json || dryRun || yes || keepData || removeData) return defaults;

  if (!process.stdin.isTTY) {
    throw new CliError("morrow uninstall needs an interactive terminal. Re-run with --yes, --keep-data, --purge-data, or --dry-run.", {
      exitCode: EXIT.USAGE,
    });
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    ctx.out.print("This will stop Morrow and remove the app (launcher, PATH entry, and shortcuts).");
    ctx.out.print();
    const proceed = await confirm(rl, "Uninstall Morrow?", true);
    if (!proceed) return null;

    // The headline choice: offer a full wipe of everything, clearly and up front.
    ctx.out.print();
    ctx.out.print(ctx.out.bold("Delete your data too?"));
    ctx.out.print("This permanently deletes ALL of your local Morrow data:");
    ctx.out.bullet("Conversations, memory, and the project database");
    ctx.out.bullet("Config and saved provider keys (API keys / OAuth sign-ins)");
    ctx.out.bullet("Backups, checkpoints, logs, and cache");
    ctx.out.print("This cannot be undone. Choosing No keeps your data so a future reinstall can use it.");
    ctx.out.print();
    const deleteEverything = await confirm(rl, "Delete EVERYTHING, including all of the above?", false);

    return {
      removeApp: true,
      removePath: true,
      removeShortcuts: true,
      removeConfig: deleteEverything,
      removeDatabase: deleteEverything,
      removeLogs: deleteEverything,
      removeCache: deleteEverything,
      removeBackups: deleteEverything,
      dryRun: false,
    };
  } finally {
    rl.close();
  }
}

async function confirm(rl: ReturnType<typeof createInterface>, question: string, defaultYes: boolean): Promise<boolean> {
  const suffix = defaultYes ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} [${suffix}] `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

/**
 * Where the installer for THIS platform puts the application.
 *
 * This used to return `%LOCALAPPDATA%\Morrow` unconditionally, falling back to
 * `~/AppData/Local/Morrow` — a Windows path built out of a POSIX home. On macOS
 * and Linux that names a directory that has never existed, so `morrow
 * uninstall` reported "Application files ... (not present)" and left the real
 * installation in place. It must match installer/install.sh.
 */
export function resolveInstallRoot(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.MORROW_INSTALL_ROOT) return env.MORROW_INSTALL_ROOT;
  if (platform === "win32") {
    return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "Morrow") : join(homedir(), "AppData", "Local", "Morrow");
  }
  if (env.MORROW_PREFIX) return env.MORROW_PREFIX;
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "morrow");
}

/** Where the `morrow` launcher lives. Windows keeps it inside the install root;
 *  POSIX puts it on the user's PATH directory, per install.sh. */
export function resolveBinDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (platform === "win32") return join(resolveInstallRoot(env, platform), "bin");
  if (env.MORROW_BIN_DIR) return env.MORROW_BIN_DIR;
  return env.XDG_BIN_HOME || join(homedir(), ".local", "bin");
}

/** The exact block install.sh appends to a shell profile, so uninstall can take
 *  it back out again without disturbing anything else in the file. */
const PROFILE_MARKER = "# Added by the Morrow installer";

export function stripInstallerPathBlock(contents: string, binDir: string): string {
  const lines = contents.split("\n");
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const isMarker = lines[i]!.trim() === PROFILE_MARKER;
    const exportsBin = (lines[i + 1] ?? "").includes(binDir);
    if (isMarker && exportsBin) {
      i += 1; // drop the marker and the export line that follows it
      // Also drop the blank line the installer wrote before the marker.
      while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
      continue;
    }
    kept.push(lines[i]!);
  }
  return kept.join("\n");
}

function buildTargets(ctx: Context, installRoot: string, choices: UninstallChoices): UninstallTarget[] {
  const targets: UninstallTarget[] = [];
  const add = (label: string, path: string, selected: boolean) => {
    if (selected) targets.push({ label, path, exists: existsSync(path) });
  };
  add("Application files", installRoot, choices.removeApp);
  add("Config and provider keys", ctx.paths.userConfigFile, choices.removeConfig);
  add("Provider secrets", ctx.paths.secretsFile, choices.removeConfig);
  add("Conversation/memory database", ctx.paths.defaultDbPath, choices.removeDatabase);
  add("Database WAL", `${ctx.paths.defaultDbPath}-wal`, choices.removeDatabase);
  add("Database SHM", `${ctx.paths.defaultDbPath}-shm`, choices.removeDatabase);
  add("Orchestrator log", ctx.paths.logFile, choices.removeLogs);
  add("Logs directory", join(ctx.paths.home, "logs"), choices.removeLogs);
  add("Cache", join(ctx.paths.home, "cache"), choices.removeCache);
  add("Browser scratch data", join(ctx.paths.home, "browser"), choices.removeCache);
  add("Backups", join(ctx.paths.home, "backups"), choices.removeBackups);
  add("Legacy backup directory", join(ctx.paths.home, "backup"), choices.removeBackups);
  return targets;
}

function writeWindowsUninstallScript(input: { ctx: Context; installRoot: string; binPath: string; choices: UninstallChoices }): string {
  const { ctx, installRoot, binPath, choices } = input;
  const scriptPath = join(tmpdir(), `morrow-uninstall-${Date.now()}.ps1`);
  const removePaths = selectedPaths(ctx, installRoot, choices).map((path) => `  ${psString(path)}`).join(",`r`n");
  const shortcutPaths = [
    join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Morrow.lnk"),
    join(process.env.USERPROFILE ?? homedir(), "Desktop", "Morrow.lnk"),
  ];
  const shortcuts = shortcutPaths.map((path) => `  ${psString(path)}`).join(",`r`n");
  const body = `
$ErrorActionPreference = 'SilentlyContinue'
Start-Sleep -Seconds 2
${choices.removePath ? `
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath) {
  $remove = ${psString(binPath)}
  $parts = @($userPath -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ine $remove.TrimEnd('\\')) })
  [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
}
` : ""}
${choices.removeShortcuts ? `
$shortcuts = @(
${shortcuts}
)
foreach ($item in $shortcuts) { Remove-Item -LiteralPath $item -Force }
` : ""}
$paths = @(
${removePaths}
)
foreach ($item in $paths) { Remove-Item -LiteralPath $item -Recurse -Force }
Remove-Item -LiteralPath $PSCommandPath -Force
`.trimStart();
  writeFileSync(scriptPath, body, "utf8");
  return scriptPath;
}

function removeSelectedNow(ctx: Context, installRoot: string, choices: UninstallChoices): void {
  for (const path of selectedPaths(ctx, installRoot, choices)) rmSync(path, { recursive: true, force: true });

  // The POSIX launcher lives outside the install root (on the user's PATH
  // directory), so removing the app tree alone leaves a `morrow` command that
  // execs a directory that is no longer there.
  if (process.platform !== "win32" && choices.removeApp) {
    rmSync(join(resolveBinDir(), "morrow"), { force: true });
  }
  if (process.platform !== "win32" && choices.removePath) {
    const binDir = resolveBinDir();
    for (const profile of [".zshrc", ".bashrc", ".bash_profile", ".profile"].map((name) => join(homedir(), name))) {
      if (!existsSync(profile)) continue;
      try {
        const current = readFileSync(profile, "utf8");
        const stripped = stripInstallerPathBlock(current, binDir);
        if (stripped !== current) writeFileSync(profile, stripped, "utf8");
      } catch {
        // A profile we cannot read is one we must not damage; leaving the PATH
        // entry behind is harmless once the launcher itself is gone.
      }
    }
  }
}

function selectedPaths(ctx: Context, installRoot: string, choices: UninstallChoices): string[] {
  if (choices.removeConfig && choices.removeDatabase && choices.removeLogs && choices.removeCache && choices.removeBackups) {
    const paths = choices.removeApp ? [installRoot, ctx.paths.home] : [ctx.paths.home];
    return [...new Set(paths)];
  }
  const paths: string[] = [];
  if (choices.removeApp) paths.push(installRoot);
  if (choices.removeConfig) paths.push(ctx.paths.userConfigFile, ctx.paths.secretsFile);
  if (choices.removeDatabase) paths.push(ctx.paths.defaultDbPath, `${ctx.paths.defaultDbPath}-wal`, `${ctx.paths.defaultDbPath}-shm`);
  if (choices.removeLogs) paths.push(ctx.paths.logFile, join(ctx.paths.home, "logs"));
  if (choices.removeCache) paths.push(join(ctx.paths.home, "cache"), join(ctx.paths.home, "browser"));
  if (choices.removeBackups) paths.push(join(ctx.paths.home, "backups"), join(ctx.paths.home, "backup"));
  return [...new Set(paths)];
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
