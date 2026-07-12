/**
 * The slash-command registry. A single source of truth for in-session commands
 * so the help text, the completion menu, and the dispatcher can't drift apart.
 */
export interface SlashCommand {
  name: string;
  /** Optional argument hint shown in the menu, e.g. "[on|off]". */
  arg?: string;
  /** First-position argument values offered by slash completion. */
  subcommands?: string[];
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "show available commands" },
  { name: "new", arg: "[title]", description: "start a new conversation" },
  { name: "resume", description: "review session freshness — repo & Cortex drift — before continuing" },
  { name: "sessions", description: "list recent conversations" },
  { name: "search", arg: "<query>", description: "full-text search across this project" },
  { name: "project", description: "show the active project" },
  { name: "branch", description: "show the current Git branch, dirty state, and ahead/behind" },
  { name: "changes", description: "show staged, modified, and untracked files" },
  { name: "provider", arg: "[id]", description: "show or set the active provider" },
  { name: "model", arg: "[id]", description: "show or set the active model" },
  { name: "preset", arg: "[id]", description: "show or set the active preset" },
  { name: "mode", arg: "[ask|plan|build|mission]", subcommands: ["ask", "plan", "build", "mission"], description: "show or set the product mode" },
  { name: "yolo", arg: "[on|off|status|policy]", subcommands: ["on", "off", "status", "policy"], description: "manage workspace-autonomous mode" },
  { name: "tools", description: "list available read-only tools" },
  { name: "permissions", description: "show the permission profile" },
  { name: "status", description: "show service and session status" },
  { name: "stats", description: "show detailed session statistics (tokens, context, cost, tools)" },
  { name: "history", description: "show full conversation history" },
  { name: "inspect", description: "run a safe workspace inspection" },
  { name: "diff", description: "show the latest Morrow-owned applied change" },
  { name: "undo", description: "roll back the latest Morrow-owned change" },
  { name: "checkpoint", arg: "[save|list|restore|delete] [name]", subcommands: ["save", "list", "restore", "delete"], description: "named workspace checkpoints (snapshot & restore files)" },
  { name: "ps", arg: "[kill <id>]", subcommands: ["kill"], description: "list or terminate background processes" },
  { name: "worktrees", arg: "[show|remove <id>]", subcommands: ["show", "remove"], description: "list or inspect isolated agent worktrees" },
  { name: "integrate", arg: "[check|show|apply]", subcommands: ["check", "show", "apply"], description: "review and apply worktree branch integrations" },
  { name: "tree", description: "show the current mission task tree" },
  { name: "result", description: "show final evidence and next action" },
  { name: "criteria", description: "show the active mission's success criteria and states" },
  { name: "evidence", description: "show the active mission's evidence ledger" },
  { name: "failures", description: "show the active mission's failures and recovery" },
  { name: "checkpoints", description: "show the active mission's checkpoints" },
  { name: "cortex", description: "show Morrow's persistent understanding of this repository" },
  { name: "capabilities", description: "what this build can actually do right now" },
  { name: "map", description: "show the project architecture map" },
  { name: "conventions", arg: "[approve|reject <id>]", subcommands: ["approve", "reject"], description: "inspect or approve inferred repository conventions" },
  { name: "decisions", description: "show the architecture decision ledger" },
  { name: "risks", description: "show known project risks" },
  { name: "learnings", description: "show evidence-backed mission learnings" },
  { name: "rules", arg: "[add <text>|remove <id>]", subcommands: ["add", "remove"], description: "explicit repository rules (outrank inferred conventions)" },
  { name: "agents", description: "show persistent project agents and active subagents" },
  { name: "activity", description: "expand grouped tool activity, tools, and agents for this session" },
  { name: "details", description: "alias for /activity — expanded inspection of session work" },
  { name: "impact", description: "show the active mission's change-impact analysis" },
  { name: "plan", description: "show the active mission's plan and impact analysis" },
  { name: "revisions", description: "show the active mission's plan revision history" },
  { name: "context", description: "show model context usage and compaction status" },
  { name: "panic", description: "cancel active work and disable YOLO" },
  { name: "pause", description: "pause the running task after its current step; resume with /continue" },
  { name: "stop", description: "cancel the running task and report what was preserved" },
  { name: "continue", description: "resume the latest paused task" },
  { name: "memory", description: "toggle memory for this session" },
  { name: "compact", description: "summarize history into a memory note" },
  { name: "export", arg: "[file]", description: "export a sanitized task report" },
  { name: "clear", description: "clear the screen" },
  { name: "exit", description: "quit" },

  // ── New commands (CLI overhaul) ────────────────────────────────────────────
  { name: "tasks", arg: "[limit]", description: "list running and recent tasks" },
  { name: "memory-search", arg: "<query>", description: "search project memory entries" },
  { name: "audit", arg: "[limit]", description: "show recent audit log entries" },
  { name: "cost", description: "show estimated cost of current session" },
  { name: "skill-search", arg: "<query>", description: "search available skills by name or description" },
  { name: "fork", arg: "[title]", description: "fork this conversation into a new one" },
  { name: "stash", arg: "<name>", description: "save current session as a named checkpoint" },
  { name: "bench", description: "run a quick provider latency benchmark" },
  { name: "versions", description: "show installed tool versions (node, pnpm, morrow)" },
  { name: "bugs", description: "open the issue tracker" },
  { name: "theme", arg: "[name]", description: "switch terminal theme (dawn, midnight, forest, ocean, mono)" },
  { name: "connect", arg: "<provider>", description: "quick-connect a model provider" },
  { name: "share", arg: "[format]", description: "export session as markdown or html" },
  { name: "shortcuts", description: "show keyboard shortcuts reference" },
  { name: "output", arg: "[full|failures] [task-id]", subcommands: ["full", "failures"], description: "show the durable task report (latest task, or by id)" },
];
