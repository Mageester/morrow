import type { ProviderStatus, ModelStatus, PresetStatus } from "@morrow/contracts";

/** Minimal skill shape needed to build skill commands (see SkillsControlCenter). */
export interface SlashSkill {
  id: string;
  name: string;
  description: string;
  category?: string;
}

/** Side-effecting actions a slash command can invoke. Kept as a plain interface
 *  so the command registry stays decoupled from React. */
export interface SlashActions {
  setModel: (providerId: string, model: string, label: string) => void;
  setProvider: (providerId: string, label: string) => void;
  setPreset: (presetId: string, label: string) => void;
  setMode: (mode: "agent" | "plan-only" | "inspect", label: string) => void;
  setAutonomy: (on: boolean) => void;
  insertText: (text: string) => void;
  navigate: (nav: string) => void;
  newChat: () => void;
  clearInput: () => void;
  showHelp: () => void;
}

export interface SlashCommand {
  id: string;
  /** Canonical text after the leading slash, e.g. "model openai gpt-5.4". */
  command: string;
  title: string;
  hint?: string;
  group: string;
  keywords: string[];
  /** When true the menu replaces composer text instead of running an action. */
  inserts?: boolean;
  run: (a: SlashActions) => void;
}

export interface BuildCommandsInput {
  providers: ProviderStatus[];
  models: ModelStatus[];
  presets: PresetStatus[];
  skills: SlashSkill[];
}

/**
 * Build the full slash-command catalog from live state. Only models/providers
 * that are actually available are offered, so the menu never suggests something
 * that would fail to route.
 */
export function buildSlashCommands(input: BuildCommandsInput): SlashCommand[] {
  const { providers, models, presets, skills } = input;
  const out: SlashCommand[] = [];

  // ── Models (only the live / available ones) ────────────────────────────────
  for (const m of models) {
    if (!m.available) continue;
    const { id, providerId, label, speedClass, costClass } = m.model;
    out.push({
      id: `model:${providerId}:${id}`,
      command: `model ${providerId} ${id}`,
      title: label,
      hint: `${providerId} · ${speedClass}/${costClass}`,
      group: "Model",
      keywords: [providerId, id, label, speedClass, costClass, "model", "use"],
      run: (a) => a.setModel(providerId, id, `${providerId} · ${label}`),
    });
  }

  // ── Providers (configured + available) ─────────────────────────────────────
  for (const p of providers) {
    if (!p.available || p.id === "mock") continue;
    out.push({
      id: `provider:${p.id}`,
      command: `provider ${p.id}`,
      title: p.label,
      hint: p.defaultModel ? `default: ${p.defaultModel}` : "provider",
      group: "Provider",
      keywords: [p.id, p.label, "provider"],
      run: (a) => a.setProvider(p.id, p.label),
    });
  }

  // ── Routing presets ────────────────────────────────────────────────────────
  for (const ps of presets) {
    out.push({
      id: `preset:${ps.preset.id}`,
      command: `preset ${ps.preset.id}`,
      title: ps.preset.label,
      hint: ps.available ? ps.preset.description : ps.unavailableReason ?? "unavailable",
      group: "Preset",
      keywords: [ps.preset.id, ps.preset.label, "preset", "routing"],
      run: (a) => a.setPreset(ps.preset.id, ps.preset.label),
    });
  }

  // ── Modes ──────────────────────────────────────────────────────────────────
  out.push(
    {
      id: "mode:agent",
      command: "agent",
      title: "Agent mode",
      hint: "Full tools (with approvals unless autonomy is on)",
      group: "Mode",
      keywords: ["agent", "mode", "tools", "execute"],
      run: (a) => a.setMode("agent", "Agent"),
    },
    {
      id: "mode:plan",
      command: "plan",
      title: "Plan-only mode",
      hint: "Draft a plan, run no tools",
      group: "Mode",
      keywords: ["plan", "planning", "mode", "dry-run", "read"],
      run: (a) => a.setMode("plan-only", "Plan-only"),
    },
    {
      id: "mode:inspect",
      command: "read-only",
      title: "Read-only mode",
      hint: "Inspect files, never write or execute",
      group: "Mode",
      keywords: ["read", "read-only", "inspect", "safe", "mode"],
      run: (a) => a.setMode("inspect", "Read-only"),
    },
    {
      id: "mode:yolo",
      command: "yolo",
      title: "Full autonomy on",
      hint: "Run commands & edit files without approval prompts",
      group: "Mode",
      keywords: ["yolo", "auto", "autonomy", "auto-approve", "unattended"],
      run: (a) => a.setAutonomy(true),
    },
    {
      id: "mode:safe",
      command: "safe",
      title: "Full autonomy off",
      hint: "Require approval before commands & writes",
      group: "Mode",
      keywords: ["safe", "approve", "approval", "autonomy", "off"],
      run: (a) => a.setAutonomy(false),
    },
  );

  // ── Skills (insert a reference into the prompt) ─────────────────────────────
  for (const s of skills) {
    out.push({
      id: `skill:${s.id}`,
      command: `skill ${s.id}`,
      title: s.name,
      hint: s.description?.slice(0, 80) || s.category || "skill",
      group: "Skill",
      keywords: [s.id, s.name, ...(s.category ? [s.category] : []), "skill"],
      inserts: true,
      run: (a) => a.insertText(`Use the "${s.name}" skill to `),
    });
  }

  // ── Navigation ─────────────────────────────────────────────────────────────
  const nav: Array<[string, string, string]> = [
    ["settings", "Settings", "settings"],
    ["models", "Models", "settings"],
    ["skills", "Skills", "skills"],
    ["agents", "Agents", "agents"],
    ["memory", "Memory", "memory"],
    ["approvals", "Approvals", "approvals"],
    ["runs", "Runs", "runs"],
    ["missions", "Missions", "projects"],
    ["system", "System Health", "system"],
  ];
  for (const [cmd, title, target] of nav) {
    out.push({
      id: `nav:${cmd}`,
      command: cmd,
      title: `Go to ${title}`,
      hint: "navigate",
      group: "Go to",
      keywords: [cmd, title, "go", "open", "navigate"],
      run: (a) => (cmd === "models" ? (a.navigate("settings")) : a.navigate(target)),
    });
  }

  // ── Chat utilities ─────────────────────────────────────────────────────────
  out.push(
    {
      id: "chat:new",
      command: "new",
      title: "New chat",
      hint: "Start a fresh conversation",
      group: "Chat",
      keywords: ["new", "chat", "reset", "fresh"],
      run: (a) => a.newChat(),
    },
    {
      id: "chat:clear",
      command: "clear",
      title: "Clear input",
      hint: "Empty the composer",
      group: "Chat",
      keywords: ["clear", "empty", "cancel"],
      run: (a) => a.clearInput(),
    },
    {
      id: "chat:help",
      command: "help",
      title: "Show all commands",
      hint: "List every slash command",
      group: "Chat",
      keywords: ["help", "commands", "?", "list"],
      run: (a) => a.showHelp(),
    },
  );

  return out;
}

/**
 * Rank commands against the query (the text after the leading slash). Returns the
 * best matches first. Prefix and word-start matches outrank loose subsequence
 * matches so typing "/dee" surfaces DeepSeek models before incidental hits.
 */
export function filterSlashCommands(commands: SlashCommand[], rawQuery: string): SlashCommand[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return commands.slice(0, 50);

  const scored: Array<{ c: SlashCommand; score: number }> = [];
  for (const c of commands) {
    const haystacks = [c.command.toLowerCase(), c.title.toLowerCase(), ...c.keywords.map((k) => k.toLowerCase())];
    let best = -1;
    for (const h of haystacks) {
      const s = matchScore(h, query);
      if (s > best) best = s;
    }
    if (best >= 0) scored.push({ c, score: best });
  }
  scored.sort((a, b) => b.score - a.score || a.c.command.length - b.c.command.length);
  return scored.slice(0, 50).map((s) => s.c);
}

function matchScore(haystack: string, query: string): number {
  if (haystack === query) return 100;
  if (haystack.startsWith(query)) return 80;
  const wordStart = haystack.split(/[\s/_-]+/).some((w) => w.startsWith(query));
  if (wordStart) return 60;
  const idx = haystack.indexOf(query);
  if (idx >= 0) return 40 - Math.min(idx, 20);
  // Subsequence (fuzzy): all query chars appear in order.
  let qi = 0;
  for (let i = 0; i < haystack.length && qi < query.length; i++) {
    if (haystack[i] === query[qi]) qi++;
  }
  return qi === query.length ? 10 : -1;
}
