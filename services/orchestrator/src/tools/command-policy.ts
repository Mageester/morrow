import { basename, extname } from "node:path";

export type CommandRisk = "auto_approvable" | "approval_required" | "denied";
export type CommandPolicyDecision = { risk: CommandRisk; pattern: string; reason: string };

const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn"]);
const VERIFY_SCRIPTS = new Set(["test", "check", "typecheck", "lint", "build"]);
const SHELLS = new Set(["cmd", "powershell", "pwsh", "bash", "sh", "zsh", "sudo", "runas", "su"]);
const DELETE_COMMANDS = new Set(["rm", "del", "rmdir", "remove-item", "erase", "rd", "sdelete"]);
const DENIED_COMMANDS = new Set(["mimikatz", "psexec", "shutdown", "reboot", "halt", "poweroff", "init", "format"]);

function executableName(executable: string): string {
  const file = basename(executable).toLowerCase();
  const extension = extname(file);
  return extension === ".cmd" || extension === ".exe" || extension === ".bat" ? file.slice(0, -extension.length) : file;
}

function decision(risk: CommandRisk, pattern: string, reason: string): CommandPolicyDecision {
  return { risk, pattern, reason };
}

export function classifyCommand(executable: string, args: string[]): CommandPolicyDecision {
  const command = executableName(executable);
  const normalizedArgs = args.map((arg) => arg.toLowerCase());
  const display = [command, ...args].join(" ").trim();

  if (!command || SHELLS.has(command) || DELETE_COMMANDS.has(command) || DENIED_COMMANDS.has(command)) {
    return decision("denied", command || "unknown", "Shell invocation, privilege escalation, filesystem deletion, credential extraction, format, and shutdown are denied.");
  }
  if (command === "git" && (normalizedArgs[0] === "reset" || normalizedArgs.includes("--hard") || normalizedArgs[0] === "clean" || normalizedArgs[0] === "rebase" || normalizedArgs[0] === "filter-branch")) {
    return decision("denied", "git destructive-history", "Destructive Git history rewrites are denied.");
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
