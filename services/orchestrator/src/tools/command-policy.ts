import { basename, extname } from "node:path";

export type CommandRisk = "auto_approvable" | "approval_required" | "denied";
export type CommandPolicyDecision = { risk: CommandRisk; pattern: string; reason: string };

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn"]);
const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "zsh"]);
const PRIVILEGE_ESCALATION = new Set(["sudo", "runas", "su", "doas"]);
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

/** Shell payloads cannot use the structured executor's argv containment. Keep
 * the shell available for legitimate work, but categorically reject payloads
 * whose text already proves a host-destructive or intentionally opaque action. */
function isDangerousShellInvocation(args: string[]): boolean {
  const payload = args.join(" ");
  if (/(?:-encodedcommand|--encoded-command|\biex\b|invoke-expression)/i.test(payload)) return true;
  if (/\b(?:remove-item|format-volume|clear-disk|initialize-disk|stop-computer|restart-computer)\b/i.test(payload)) return true;
  if (/\b(?:mimikatz|credentials?|passwords?|api[_ -]?keys?|secrets?|tokens?)\b/i.test(payload) && /\b(?:get-content|type|cat|print|echo|upload|send)\b/i.test(payload)) return true;
  // A failed New-Item safety match with chaining, traversal, or an absolute
  // host path is an attempted escape, not merely an unknown shell command.
  if (/\bNew-Item\b/i.test(payload) && (/[;&|`\r\n]/.test(payload) || /(?:\.\.[\\/]|[A-Za-z]:[\\/]|['"]\/[A-Za-z])/i.test(payload))) return true;
  return false;
}
const DELETE_COMMANDS = new Set(["rm", "del", "rmdir", "remove-item", "erase", "rd", "sdelete"]);

/**
 * Process-killing tools. Ending processes is never scoped to the workspace:
 * the blast radius is the whole machine, and Morrow's own controller runs as
 * one of the processes these commands match.
 *
 * Observed live during a packaged build: an agent ran
 * `taskkill /F /IM node.exe` "to get a clean slate", killed every node.exe on
 * the host including Morrow's bundled `runtime\node.exe`, and terminated the
 * controller that was supervising it — along with an unrelated Morrow service
 * belonging to a different worktree. Cleaning up a dev server it started is a
 * legitimate need; a machine-wide image kill is not the way to do it.
 */
const PROCESS_KILLERS = new Set(["taskkill", "kill", "pkill", "killall", "stop-process", "tskill"]);

/** Image/name-wide kills, i.e. "every process called X" rather than one pid. */
function killsByImageName(command: string, args: string[]): boolean {
  const lower = args.map((arg) => arg.toLowerCase());
  if (command === "taskkill") {
    // /IM <image> and /FI <filter> both select by name/attribute, not identity.
    return lower.some((arg) => arg === "/im" || arg.startsWith("/im:") || arg === "-im" || arg === "/fi" || arg === "/f?");
  }
  if (command === "pkill" || command === "killall" || command === "tskill") return true;
  if (command === "stop-process") {
    return lower.some((arg) => arg === "-name" || arg.startsWith("-name:"));
  }
  return false;
}
const DENIED_COMMANDS = new Set(["mimikatz", "psexec", "shutdown", "reboot", "halt", "poweroff", "init", "format"]);
// Direct network tools are useful for real development, but can move data
// beyond the workspace. They are available behind an explicit human boundary
// rather than being categorically removed from the model's hands.
const NETWORK_TRANSFER = new Set(["curl", "wget", "nc", "ncat", "netcat", "telnet", "scp", "sftp", "ftp", "tftp", "socat", "ssh", "rsync"]);
const DEPLOY_EXECUTABLES = new Set(["vercel", "netlify", "wrangler", "firebase", "fly", "flyctl", "railway", "render", "heroku"]);

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

const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const LONG_COMMAND_TIMEOUT_MS = 1_800_000; // 30 minutes for installs/builds/tests
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
  // Narrow, workspace-relative PowerShell creation is equivalent to the native
  // file tools and can proceed in trusted-workspace mode.
  if (POWERSHELLS.has(command) && isSafePowerShellNewItem(args)) {
    return decision("auto_approvable", `${command} New-Item`, "Workspace-contained file and directory creation is ordinary trusted work.");
  }
  if (!command || PRIVILEGE_ESCALATION.has(command) || DELETE_COMMANDS.has(command) || DENIED_COMMANDS.has(command)) {
    return decision("denied", command || "unknown", "Shell invocation, privilege escalation, filesystem deletion, credential extraction, format, and shutdown are denied. To create files or directories, use the create_file / create_directory tools.");
  }
  if (PROCESS_KILLERS.has(command)) {
    if (killsByImageName(command, args)) {
      return decision(
        "denied",
        `${command} image-wide`,
        "Killing processes by image name affects the whole machine, including Morrow's own service and any unrelated work. Stop a process you started with the process tools (`morrow ps`), which track the pid, port, and logs of that process only.",
      );
    }
    return decision(
      "approval_required",
      display,
      "Ending a process is outside the workspace boundary and always requires explicit approval.",
    );
  }
  if (redirectsWorkspace(command, args)) {
    return decision("denied", `${command} workspace-redirect`, "Redirecting a command outside the project workspace is denied.");
  }
  if (command === "git" && (normalizedArgs.includes("--hard") || normalizedArgs[0] === "clean" || normalizedArgs[0] === "filter-branch")) {
    return decision("denied", "git destructive-history", "Destructive Git history rewrites are denied.");
  }
  if (command === "git" && normalizedArgs[0] === "push" && (normalizedArgs.includes("-f") || normalizedArgs.some((a) => a.startsWith("--force")))) {
    return decision("denied", "git force-push", "Force-pushing rewrites published history and is denied.");
  }

  if (command === "git") {
    const subcommand = normalizedArgs[0] ?? "";
    if (subcommand === "push" && normalizedArgs.includes("--delete")) {
      return decision("approval_required", "git push-delete", "Deleting a remote ref is a material external effect and requires explicit approval.");
    }
    return decision("auto_approvable", `git ${subcommand || "command"}`, "Ordinary Git work is permitted in a trusted workspace.");
  }

  if (PACKAGE_MANAGERS.has(command)) {
    const script = normalizedArgs[0] === "run" ? normalizedArgs[1] : normalizedArgs[0];
    if (script === "publish" || script === "unpublish" || script === "deprecate") {
      return decision("approval_required", `${command} ${script}`, "Publishing or removing a package is a material external effect and requires explicit approval.");
    }
    return decision("auto_approvable", `${command} ${script || "command"}`, "Package installation, scripts, builds, and tests are ordinary trusted-workspace work.");
  }

  if (NETWORK_TRANSFER.has(command)) {
    return decision("approval_required", command, "Direct network transfer crosses the workspace boundary and requires explicit approval.");
  }

  if (SHELLS.has(command)) {
    if (isDangerousShellInvocation(args)) {
      return decision("denied", `${command} dangerous-payload`, "The shell payload is destructive, credential-seeking, opaque, chained, or escapes the workspace boundary.");
    }
    return decision("approval_required", command, "A general shell can address the whole host and requires explicit approval.");
  }

  if (command === "gh" && normalizedArgs[0] === "release") {
    return decision("approval_required", "gh release", "Creating, changing, or deleting a public release is a material external effect.");
  }
  if (command === "gh" && normalizedArgs[0] === "pr" && normalizedArgs[1] === "merge") {
    return decision("approval_required", "gh pr merge", "Merging a remote pull request is a material external effect.");
  }
  if (command === "docker" && normalizedArgs[0] === "push") {
    return decision("approval_required", "docker push", "Publishing an image is a material external effect.");
  }
  if (DEPLOY_EXECUTABLES.has(command) && normalizedArgs.some((arg) => arg === "deploy" || arg === "publish" || arg === "--prod" || arg === "--production")) {
    return decision("approval_required", `${command} deploy`, "Deploying or publishing is a material external effect.");
  }

  return decision("auto_approvable", display || "unknown", "Ordinary structured developer commands are permitted in a trusted workspace.");
}
