/**
 * Command taxonomy.
 *
 * Seventy-one slash commands printed as one alphabetical run is the same
 * failure the chat transcript had: everything at equal weight, so nothing is
 * findable. Grouping is not decoration — it is what lets someone who wants to
 * undo a change find `/undo` without reading sixty-eight other words.
 *
 * Order matters and is by frequency of real use, not alphabet. `session` and
 * `work` are what people reach for constantly; `intelligence` and `advanced`
 * are things you go looking for deliberately.
 */
export type CommandGroup =
  | "session"
  | "work"
  | "inspect"
  | "route"
  | "intelligence"
  | "safety"
  | "advanced";

export const GROUP_TITLES: Record<CommandGroup, string> = {
  session: "Session",
  work: "Work",
  inspect: "Inspect",
  route: "Model & routing",
  intelligence: "Repository intelligence",
  safety: "Safety",
  advanced: "Advanced",
};

export const GROUP_ORDER: CommandGroup[] = [
  "session",
  "work",
  "inspect",
  "route",
  "safety",
  "intelligence",
  "advanced",
];

/** Every command's home. A command missing here lands in `advanced`, so a new
 * command is never dropped from the menu — only filed conservatively. */
const GROUPS: Record<string, CommandGroup> = {
  help: "session", new: "session", resume: "session", sessions: "session",
  clear: "session", exit: "session", history: "session", export: "session",
  share: "session", shortcuts: "session", theme: "session", fork: "session",

  plan: "work", diff: "work", undo: "work", checkpoint: "work", changes: "work",
  tasks: "work", result: "work", revisions: "work", stash: "work", tree: "work",
  branch: "work", worktrees: "work", integrate: "work",

  status: "inspect", stats: "inspect", inspect: "inspect", activity: "inspect",
  details: "inspect", output: "inspect", failures: "inspect", evidence: "inspect",
  criteria: "inspect", checkpoints: "inspect", impact: "inspect", cost: "inspect",
  context: "inspect", audit: "inspect", ps: "inspect", search: "inspect",
  project: "inspect", bugs: "inspect", versions: "inspect", bench: "inspect",

  model: "route", provider: "route", preset: "route", reasoning: "route",
  mode: "route", capabilities: "route", connect: "route",

  yolo: "safety", permissions: "safety", tools: "safety", panic: "safety",
  pause: "safety", stop: "safety", continue: "safety",

  cortex: "intelligence", map: "intelligence", conventions: "intelligence",
  decisions: "intelligence", risks: "intelligence", learnings: "intelligence",
  rules: "intelligence", agents: "intelligence", memory: "intelligence",
  "memory-search": "intelligence", "skill-search": "intelligence",
  compact: "intelligence",
};

export function commandGroup(name: string): CommandGroup {
  return GROUPS[name] ?? "advanced";
}

export function groupCommands<T extends { name: string }>(commands: readonly T[]): Array<{
  group: CommandGroup;
  title: string;
  commands: T[];
}> {
  const buckets = new Map<CommandGroup, T[]>();
  for (const command of commands) {
    const group = commandGroup(command.name);
    buckets.set(group, [...(buckets.get(group) ?? []), command]);
  }
  return GROUP_ORDER.flatMap((group) => {
    const items = buckets.get(group);
    return items && items.length > 0 ? [{ group, title: GROUP_TITLES[group], commands: items }] : [];
  });
}
