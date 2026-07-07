import { basename, extname } from "node:path";

export type CommandRisk = "auto_approvable" | "approval_required" | "denied";
export type CommandPolicyDecision = { risk: CommandRisk; pattern: string; reason: string };

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn"]);
const VERIFY_SCRIPTS = new Set(["test", "check", "typecheck", "lint", "build"]);
const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "zsh", "sudo", "runas", "su"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const SHELL_BUILT_INS = new Set(["dir", "cd", "copy", "del", "set", "cls"]);
// `mkdir`/`md` are shell built-ins on Windows, not real executables, so running
// them via run_command fails with an opaque "could not be resolved from PATH".
// Deny them with a clear pointer to the first-class tool so the agent recovers
// instead of looping. (Directory creation itself is fully supported.)
const DIR_MAKERS = new Set(["mkdir", "md", "makedir"]);

/**
 * Recognize the one safe PowerShell form we permit: creating a directory or file
 * inside the workspace via `New-Item`. Anything else through powershell/pwsh
 * stays denied. The `-Command` payload is matched against a strict shape with a
 * single quoted relative path and no chaining/expansion metacharacters, so it
 * cannot be used to smuggle a second command.
 */
function isSafePowerShellNewItem(args: string[]): boolean {
  let commandPayload: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!.toLowerCase();
    if (flag === "-noprofile" || flag === "-noninteractive" || flag === "-nologo") continue;
    if (flag === "-command" || flag === "-c") {
      if (commandPayload !== null || i !== args.length - 2) return false; // exactly one payload, and it must be last
      commandPayload = args[i + 1] ?? null;
      i++;
      continue;
    }
    return false; // any other flag/positional disqualifies
  }
  if (commandPayload === null) return false;
  const match = /^New-Item\s+-ItemType\s+(Directory|File)\s+(?:-Force\s+)?-Path\s+(['"])([^'"]+)\2\s*$/i.exec(commandPayload.trim());
  if (!match) return false;
  const path = match[3]!;
  // Reject metacharacters, expansion, chaining, absolute paths, and traversal.
  if (/[;&|$`\r\n%(){}<>^!]/.test(path)) return false;
  if (path.includes("..")) return false;
  if (/^([a-zA-Z]:[\\/]|[\\/]{1,2})/.test(path)) return false; // C:\, \\server, /abs
  return true;
}
const DELETE_COMMANDS = new Set(["rm", "del", "rmdir", "remove-item", "erase", "rd", "sdelete"]);
const DENIED_COMMANDS = new Set(["mimikatz", "psexec", "shutdown", "reboot", "halt", "poweroff", "init", "format"]);
// Direct network-transfer tools are an exfiltration vector. They are denied
// outright; legitimate dependency installation flows through the package
// managers below, which still require explicit approval for mutations.
const NETWORK_EXFIL = new Set(["curl", "wget", "nc", "ncat", "netcat", "telnet", "scp", "sftp", "ftp", "tftp", "socat", "ssh", "rsync"]);

/** A directory-redirect flag escapes the project workspace; precise to avoid clashing with read-only flags like `git log -C`. */
function redirectsWorkspace(command: string, args: string[]): boolean {
  const lower = args.map((a) => a.toLowerCase());
  const hasGitDirRedirect = lower.some((a) => a === "--git-dir" || a.startsWith("--git-dir=") || a === "--work-tree" || a.startsWith("--work-tree="));
  if (command === "git") {
    // `-C <path>` is only a change-directory option when it leads the command;
    // `git log -C` (copy detection) is a different, read-only flag.
    return args[0] === "-C" || hasGitDirRedirect;
  }
  return lower.some((a) => a === "--prefix" || a.startsWith("--prefix=") || a === "--cwd" || a.startsWith("--cwd=") || a === "--dir" || a.startsWith("--dir=") || a === "--directory" || a.startsWith("--directory="));
}

function executableName(executable: string): string {
  const file = basename(executable).toLowerCase();
  const extension = extname(file);
  return extension === ".cmd" || extension === ".exe" || extension === ".bat" ? file.slice(0, -extension.length) : file;
}

function decision(risk: CommandRisk, pattern: string, reason: string): CommandPolicyDecision {
  return { risk, pattern, reason };
}

/**
 * Canonical key a "trust this command" decision binds to. Trust is exact: it
 * covers only the same normalized executable, the same argument vector, and the
 * same working directory. It deliberately does NOT cover a broad pattern such
 * as "every pnpm test", and it is always derived server-side from the persisted
 * approval, never from a value supplied by the client.
 */
export function canonicalCommandTrustKey(executable: string, args: string[], cwd: string): string {
  return `cmd|${executableName(executable)}|${JSON.stringify(args)}|${cwd || "."}`;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const LONG_COMMAND_TIMEOUT_MS = 300_000; // 5 minutes for installs/builds/tests
const LONG_RUNNING_SCRIPTS = new Set(["install", "ci", "build", "test", "check", "typecheck", "lint"]);

/**
 * Ceiling for a command's run time. Dependency installation, builds, and test
 * runs routinely take minutes, so a flat 30s ceiling made ordinary project
 * setup (`npm install`, `npm run build`) time out and look "broken". Grant the
 * package-manager verbs and Node/bundler entrypoints a 5-minute ceiling; keep
 * everything else short so a hung one-off command still fails fast.
 */
export function longRunningCommandTimeoutMs(executable: string, args: string[]): number {
  const command = executableName(executable);
  const normalized = args.map((arg) => arg.toLowerCase());
  if (PACKAGE_MANAGERS.has(command)) {
    const script = normalized[0] === "run" ? normalized[1] : normalized[0];
    if (script && LONG_RUNNING_SCRIPTS.has(script)) return LONG_COMMAND_TIMEOUT_MS;
    // Bare `npm`/`pnpm`/`yarn` with no verb defaults to install.
    if (!script) return LONG_COMMAND_TIMEOUT_MS;
  }
  if (command === "node" || command === "tsc" || command === "vite" || command === "tsx" || command === "npx") {
    return LONG_COMMAND_TIMEOUT_MS;
  }
  return DEFAULT_COMMAND_TIMEOUT_MS;
}

export function classifyCommand(executable: string, args: string[]): CommandPolicyDecision {
  const command = executableName(executable);
  const normalizedArgs = args.map((arg) => arg.toLowerCase());
  const display = [command, ...args].join(" ").trim();

  if (DIR_MAKERS.has(command)) {
    return decision("denied", command, "mkdir is not an executable here. Use the create_directory tool to make a directory, or create_file to add a file (its parent directories are created automatically).");
  }
  if (SHELL_BUILT_INS.has(command)) {
    return decision("denied", command, "Shell built-in commands are unsupported. Use Morrow inspection tools or /project for workspace switching.");
  }
  // Narrow, safe exception: PowerShell used only to create a workspace directory
  // or file via New-Item. General PowerShell/shell invocation stays denied below.
  if (POWERSHELLS.has(command) && isSafePowerShellNewItem(args)) {
    return decision("approval_required", `${command} New-Item`, "Creating a workspace file or directory via PowerShell New-Item is allowed with approval.");
  }
  if (!command || SHELLS.has(command) || DELETE_COMMANDS.has(command) || DENIED_COMMANDS.has(command)) {
    return decision("denied", command || "unknown", "Shell invocation, privilege escalation, filesystem deletion, credential extraction, format, and shutdown are denied. To create files or directories, use the create_file / create_directory tools.");
  }
  if (NETWORK_EXFIL.has(command)) {
    return decision("denied", command, "Direct network-transfer tools are denied to prevent unauthorized data transfer and exfiltration.");
  }
  if (redirectsWorkspace(command, args)) {
    return decision("denied", `${command} workspace-redirect`, "Redirecting a command outside the project workspace is denied.");
  }
  if (command === "git" && (normalizedArgs[0] === "reset" || normalizedArgs.includes("--hard") || normalizedArgs[0] === "clean" || normalizedArgs[0] === "rebase" || normalizedArgs[0] === "filter-branch")) {
    return decision("denied", "git destructive-history", "Destructive Git history rewrites are denied.");
  }
  if (command === "git" && normalizedArgs[0] === "push" && (normalizedArgs.includes("-f") || normalizedArgs.some((a) => a.startsWith("--force")))) {
    return decision("denied", "git force-push", "Force-pushing rewrites published history and is denied.");
  }

  if (command === "git") {
    const subcommand = normalizedArgs[0] ?? "";
    if (subcommand === "status" || subcommand === "diff" || subcommand === "log") {
      return decision("auto_approvable", `git ${subcommand}`, "Read-only Git inspection may be trusted per project.");
    }
    return decision("approval_required", `git ${subcommand || "command"}`, "Git mutations require explicit approval.");
  }

  if (PACKAGE_MANAGERS.has(command)) {
    const script = normalizedArgs[0] === "run" ? normalizedArgs[1] : normalizedArgs[0];
    if (script && VERIFY_SCRIPTS.has(script)) {
      return decision("auto_approvable", `${command} ${script}`, "Project verification commands may be trusted per project.");
    }
    return decision("approval_required", `${command} ${script || "command"}`, "Package-manager mutation or unknown scripts require explicit approval.");
  }

  return decision("approval_required", display || "unknown", "Unknown command patterns require explicit approval.");
}
