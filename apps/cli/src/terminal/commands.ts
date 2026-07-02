/**
 * The slash-command registry. A single source of truth for in-session commands
 * so the help text, the completion menu, and the dispatcher can't drift apart.
 */
export interface SlashCommand {
  name: string;
  /** Optional argument hint shown in the menu, e.g. "[on|off]". */
  arg?: string;
  description: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help", description: "show available commands" },
  { name: "new", arg: "[title]", description: "start a new conversation" },
  { name: "resume", arg: "[id]", description: "list or resume a conversation" },
  { name: "sessions", description: "list recent conversations" },
  { name: "search", arg: "<query>", description: "full-text search across this project" },
  { name: "project", description: "show the active project" },
  { name: "provider", arg: "[id]", description: "show or set the active provider" },
  { name: "model", arg: "[id]", description: "show or set the active model" },
  { name: "preset", arg: "[id]", description: "show or set the active preset" },
  { name: "mode", arg: "[agent|inspect|plan]", description: "show or set the capability mode" },
  { name: "yolo", arg: "[on|off|status|policy]", description: "manage project-scoped autonomy" },
  { name: "tools", description: "list available read-only tools" },
  { name: "permissions", description: "show the permission profile" },
  { name: "status", description: "show service and session status" },
  { name: "history", description: "show full conversation history" },
  { name: "inspect", description: "run a safe workspace inspection" },
  { name: "diff", description: "show the latest Morrow-owned applied change" },
  { name: "undo", description: "roll back the latest Morrow-owned change" },
  { name: "checkpoint", arg: "[save|list|restore|delete] [name]", description: "named workspace checkpoints (snapshot & restore files)" },
  { name: "ps", arg: "[kill <id>]", description: "list or terminate background processes" },
  { name: "tree", description: "show the current mission task tree" },
  { name: "result", description: "show final evidence and next action" },
  { name: "panic", description: "cancel active work and disable YOLO" },
  { name: "continue", description: "resume the latest paused task" },
  { name: "memory", description: "toggle memory for this session" },
  { name: "compact", description: "summarize history into a memory note" },
  { name: "export", arg: "[file]", description: "export the conversation as text" },
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
  { name: "output", arg: "[tool-id]", description: "view last command output" },
];
