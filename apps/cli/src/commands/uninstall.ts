import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
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
  const binPath = join(installRoot, "bin");
  const choices = await resolveChoices(ctx);
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

  const stopped = await stop(ctx);
  if (!ctx.out.json) ctx.out.info(stopped ? "Service stopped." : "Service was not running.");

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

async function resolveChoices(ctx: Context): Promise<UninstallChoices> {
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
    ctx.out.print("This will stop Morrow and remove selected local files. User data is preserved by default; use `morrow uninstall --purge-data` to delete it.");
    ctx.out.print();
    const removeAppChoice = await confirm(rl, "Remove application files from %LOCALAPPDATA%\\Morrow?", true);
    const removePath = await confirm(rl, "Remove Morrow from your user PATH?", true);
    const removeShortcuts = await confirm(rl, "Remove Start Menu/Desktop shortcuts?", true);
    ctx.out.print();
    ctx.out.print(ctx.out.bold("User data choices"));
    const keepConfig = await confirm(rl, "Keep config and provider keys?", true);
    const keepDatabase = await confirm(rl, "Keep conversations, memory, and project database?", true);
    const keepBackups = await confirm(rl, "Keep backups/checkpoints?", true);
    const keepLogs = await confirm(rl, "Keep logs?", true);
    const keepCache = await confirm(rl, "Keep cache/browser scratch data?", true);
    return {
      removeApp: removeAppChoice,
      removePath,
      removeShortcuts,
      removeConfig: !keepConfig,
      removeDatabase: !keepDatabase,
      removeLogs: !keepLogs,
      removeCache: !keepCache,
      removeBackups: !keepBackups,
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

function resolveInstallRoot(): string {
  if (process.env.MORROW_INSTALL_ROOT) return process.env.MORROW_INSTALL_ROOT;
  if (process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "Morrow");
  return join(homedir(), "AppData", "Local", "Morrow");
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
