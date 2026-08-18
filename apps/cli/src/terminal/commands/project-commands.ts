/**
 * Commands over Morrow's durable understanding of a project: Cortex, rules,
 * memory, skills, agents, and missions.
 *
 * These were previously fifteen separate top-level commands — `/map`,
 * `/decisions`, `/risks`, `/learnings`, `/conventions`, `/criteria`,
 * `/evidence`, `/failures`, `/checkpoints`, `/impact`, `/revisions`, `/tree`,
 * `/result`, `/memory-search`, `/skill-search` — most of which printed "run
 * morrow X in your terminal". They are five commands with subcommands now, and
 * every subcommand reads real state.
 */
import { report } from "../report.js";
import { errorText, relativeTime, shortId, summarizeList } from "./format.js";
import type { Command, CommandContext, CommandResult } from "./registry.js";

const unavailable = (what: string): CommandResult => ({
  notice: { level: "warn", text: `${what} is not available from this session.` },
});

const CORTEX_VIEWS = ["overview", "map", "conventions", "decisions", "risks", "learnings", "commands"] as const;

export const cortexCommand: Command = {
  name: "cortex",
  summary: "what Morrow has learned about this repository",
  usage: "[overview|map|conventions|decisions|risks|learnings|commands]",
  category: "project",
  subcommands: [...CORTEX_VIEWS],
  details:
    "Cortex is the persistent, evidence-backed model of the repository: its architecture, its conventions, the decisions behind it, and the risks worth knowing. Every entry carries the sources it was derived from.",
  complete: (prefix) => CORTEX_VIEWS.filter((view) => view.startsWith(prefix)),
  async run(args, ctx) {
    if (!ctx.backend.getIntelligence) return unavailable("Cortex");
    let intelligence;
    try {
      intelligence = await ctx.backend.getIntelligence();
    } catch (error) {
      return { notice: { level: "error", text: `Could not read Cortex: ${errorText(error)}` } };
    }
    if (!intelligence) {
      return {
        notice: {
          level: "info",
          text: "Cortex has not mapped this repository yet. Run `morrow cortex refresh` to build it.",
        },
      };
    }

    const view = args.sub || "overview";
    const freshness = `mapped ${relativeTime(intelligence.generatedAt)}, refreshed ${relativeTime(intelligence.refreshedAt)}`;

    switch (view) {
      case "overview": {
        const architecture = intelligence.architecture;
        return {
          report: report("Cortex")
            .subtitle(freshness)
            .fields([
              {
                label: "Languages",
                value: summarizeList(architecture.languages.map((entry) => `${entry.language} (${entry.files})`), 4),
              },
              { label: "Package managers", value: summarizeList(architecture.packageManagers, 3) },
              { label: "Components", value: String(architecture.components.length) },
              { label: "Conventions", value: String(intelligence.conventions.length) },
              { label: "Decisions", value: String(intelligence.decisions.length) },
              { label: "Risks", value: String(intelligence.risks.length) },
              { label: "Learnings", value: String(intelligence.missionLearnings.length) },
              { label: "Your rules", value: String(intelligence.userRules.filter((rule) => rule.active).length) },
              {
                label: "Open uncertainties",
                value: intelligence.uncertainties.length > 0 ? String(intelligence.uncertainties.length) : null,
                tone: "warning",
              },
            ])
            .hint("/cortex map · conventions · decisions · risks · learnings · commands")
            .build(),
        };
      }

      case "map": {
        const architecture = intelligence.architecture;
        const builder = report("Architecture").subtitle(freshness);
        builder.table(
          ["Component", "Kind", "Path"],
          architecture.components.slice(0, 40).map((component) => [component.name, component.kind, component.path]),
        );
        if (architecture.boundaries.length > 0) {
          builder.heading("Boundaries");
          builder.list(architecture.boundaries.slice(0, 15).map((boundary) => ({ text: JSON.stringify(boundary), marker: "·" })));
        }
        if (architecture.generatedPaths.length > 0) {
          builder.heading("Generated — do not hand-edit");
          builder.list(architecture.generatedPaths.slice(0, 15).map((path) => ({ text: path, tone: "warning" as const, marker: "!" })));
        }
        return { report: builder.build() };
      }

      case "commands": {
        const commands = intelligence.commands.length > 0 ? intelligence.commands : intelligence.architecture.commands;
        if (commands.length === 0) return { notice: { level: "info", text: "Cortex found no project commands." } };
        return {
          report: report("Project commands")
            .subtitle(freshness)
            .list(commands.slice(0, 30).map((command) => ({ text: JSON.stringify(command), marker: "·" })))
            .build(),
        };
      }

      case "conventions": {
        if (intelligence.conventions.length === 0) {
          return { notice: { level: "info", text: "Cortex has inferred no conventions yet." } };
        }
        return {
          report: report("Conventions")
            .subtitle(freshness)
            .table(
              ["Approval", "Scope", "Convention"],
              intelligence.conventions
                .slice(0, 40)
                .map((convention) => [convention.approval, convention.scope, convention.description]),
              intelligence.conventions
                .slice(0, 40)
                .map((convention) => (convention.approval === "approved" ? "success" : undefined)),
            )
            .hint("/rules add <text> records an explicit rule, which outranks anything inferred")
            .build(),
        };
      }

      case "decisions": {
        if (intelligence.decisions.length === 0) {
          return { notice: { level: "info", text: "No architecture decisions recorded." } };
        }
        const builder = report("Decisions").subtitle(freshness);
        for (const decision of intelligence.decisions.slice(0, 25)) {
          builder.list([{ text: `${decision.label}  ${decision.statement}`, marker: "·", detail: decision.status }]);
          if (decision.consequences.length > 0) {
            builder.text(`    consequences: ${summarizeList(decision.consequences, 2)}`, "muted");
          }
        }
        return { report: builder.build() };
      }

      case "risks": {
        if (intelligence.risks.length === 0) return { notice: { level: "info", text: "No project risks recorded." } };
        return {
          report: report("Risks")
            .subtitle(freshness)
            .table(
              ["Severity", "Area", "Risk"],
              intelligence.risks.slice(0, 30).map((risk) => [risk.severity, risk.area, risk.description]),
              intelligence.risks
                .slice(0, 30)
                .map((risk) => (risk.severity === "high" ? "danger" : risk.severity === "medium" ? "warning" : undefined)),
            )
            .build(),
        };
      }

      case "learnings": {
        if (intelligence.missionLearnings.length === 0) {
          return { notice: { level: "info", text: "No evidence-backed learnings recorded yet." } };
        }
        return {
          report: report("Learnings")
            .subtitle(freshness)
            .list(
              intelligence.missionLearnings.slice(0, 25).map((learning) => ({
                text: learning.statement,
                marker: "·",
                detail: `${learning.type} · ${learning.sources.length} source${learning.sources.length === 1 ? "" : "s"}`,
              })),
            )
            .build(),
        };
      }

      default:
        return {
          notice: { level: "warn", text: `Unknown view "${view}". Try: ${CORTEX_VIEWS.join(", ")}` },
        };
    }
  },
};

export const rulesCommand: Command = {
  name: "rules",
  summary: "explicit repository rules you set",
  usage: "[list|add <text>|remove <id>]",
  category: "project",
  subcommands: ["list", "add", "remove"],
  details: "Rules you write outrank anything Cortex inferred, and are included in every agent request for this project.",
  complete: (prefix) => ["list", "add", "remove"].filter((value) => value.startsWith(prefix)),
  async run(args, ctx) {
    const action = args.sub || "list";
    try {
      if (action === "add") {
        if (!args.rest) return { notice: { level: "warn", text: 'Usage: /rules add "always run pnpm check before pushing"' } };
        if (!ctx.backend.addRule) return unavailable("Adding a rule");
        await ctx.backend.addRule(args.rest);
        return { notice: { level: "info", text: "Rule added." } };
      }
      if (action === "remove") {
        if (!args.rest) return { notice: { level: "warn", text: "Usage: /rules remove <id>" } };
        if (!ctx.backend.removeRule) return unavailable("Removing a rule");
        await ctx.backend.removeRule(args.rest);
        return { notice: { level: "info", text: "Rule removed." } };
      }
      if (!ctx.backend.getIntelligence) return unavailable("Rules");
      const intelligence = await ctx.backend.getIntelligence();
      const rules = (intelligence?.userRules ?? []).filter((rule) => rule.active);
      if (rules.length === 0) {
        return { notice: { level: "info", text: 'No rules yet. /rules add "…" records one.' } };
      }
      return {
        report: report("Rules")
          .table(["Id", "Scope", "Rule"], rules.map((rule) => [shortId(rule.id), rule.scope, rule.text]))
          .hint("/rules remove <id>")
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Rules ${action} failed: ${errorText(error)}` } };
    }
  },
};

export const memoryCommand: Command = {
  name: "memory",
  summary: "project memory, and whether this session uses it",
  usage: "[on|off|list|add <text>|search <query>|forget <id>]",
  category: "project",
  subcommands: ["on", "off", "list", "add", "search", "forget"],
  complete: (prefix) => ["on", "off", "list", "add", "search", "forget"].filter((value) => value.startsWith(prefix)),
  async run(args, ctx) {
    const action = args.sub;

    if (!action || action === "on" || action === "off") {
      if (action) ctx.settings.useMemory = action === "on";
      else ctx.settings.useMemory = !ctx.settings.useMemory;
      return {
        notice: {
          level: "info",
          text: `Memory ${ctx.settings.useMemory ? "on — recalled entries are included in requests" : "off for this session"}.`,
        },
      };
    }

    try {
      if (action === "add") {
        if (!args.rest) return { notice: { level: "warn", text: "Usage: /memory add <text>" } };
        if (!ctx.backend.addMemory) return unavailable("Adding a memory");
        await ctx.backend.addMemory(args.rest);
        return { notice: { level: "info", text: "Saved to project memory." } };
      }
      if (action === "forget") {
        if (!args.rest) return { notice: { level: "warn", text: "Usage: /memory forget <id>" } };
        if (!ctx.backend.forgetMemory) return unavailable("Forgetting a memory");
        await ctx.backend.forgetMemory(args.rest);
        return { notice: { level: "info", text: "Memory removed." } };
      }
      if (!ctx.backend.listMemory) return unavailable("Memory");
      const entries = await ctx.backend.listMemory();
      const query = action === "search" ? args.rest.toLowerCase() : "";
      const kept = query ? entries.filter((entry) => entry.content.toLowerCase().includes(query)) : entries;
      if (kept.length === 0) {
        return {
          notice: { level: "info", text: query ? `No memory matching "${args.rest}".` : "No project memory recorded yet." },
        };
      }
      return {
        report: report("Memory")
          .subtitle(query ? `${kept.length} matching "${args.rest}"` : `${kept.length} entries · session use ${ctx.settings.useMemory ? "on" : "off"}`)
          .list(
            kept.slice(0, 25).map((entry) => ({
              text: entry.content.replace(/\s+/g, " ").slice(0, 160),
              marker: entry.pinned ? "★" : "·",
              tone: entry.enabled ? undefined : ("muted" as const),
              detail: `${shortId(entry.id)} · ${entry.scope} · ${entry.staleness}`,
            })),
          )
          .hint("/memory forget <id>")
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Memory ${action} failed: ${errorText(error)}` } };
    }
  },
};

export const skillsCommand: Command = {
  name: "skills",
  summary: "skills available to this session",
  usage: "[query]",
  category: "project",
  details:
    "A skill is a verified instruction bundle Morrow can apply. Run one directly with /skill:<id>, optionally followed by what to apply it to.",
  async run(args, ctx) {
    if (!ctx.backend.listSkills) return unavailable("Skills");
    try {
      const skills = await ctx.backend.listSkills();
      const query = args.raw.toLowerCase();
      const kept = query
        ? skills.filter((skill) => skill.id.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query))
        : skills;
      if (kept.length === 0) {
        return { notice: { level: "info", text: query ? `No skill matching "${args.raw}".` : "No skills installed." } };
      }
      return {
        report: report("Skills")
          .subtitle(query ? `${kept.length} matching "${args.raw}"` : `${kept.length} installed`)
          .list(
            kept.slice(0, 40).map((skill) => ({
              text: `/skill:${skill.id}`,
              marker: " ",
              detail: skill.description.replace(/\s+/g, " ").slice(0, 90),
            })),
          )
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not list skills: ${errorText(error)}` } };
    }
  },
};

export const agentsCommand: Command = {
  name: "agents",
  summary: "persistent agents configured for this project",
  category: "project",
  async run(_args, ctx) {
    if (!ctx.backend.listAgents) return unavailable("Agents");
    try {
      const agents = await ctx.backend.listAgents();
      if (agents.length === 0) return { notice: { level: "info", text: "No project agents configured." } };
      return {
        report: report("Agents")
          .table(["Name", "Role", "Id"], agents.map((agent) => [agent.name, agent.role ?? "—", shortId(agent.id)]))
          .build(),
      };
    } catch (error) {
      return { notice: { level: "error", text: `Could not list agents: ${errorText(error)}` } };
    }
  },
};

const MISSION_VIEWS = ["status", "criteria", "evidence", "failures", "checkpoints", "tree", "result"] as const;

export const missionCommand: Command = {
  name: "mission",
  summary: "the active verified mission and its evidence",
  usage: "[status|criteria|evidence|failures|checkpoints|tree|result]",
  category: "project",
  subcommands: [...MISSION_VIEWS],
  details:
    "A mission is an objective with explicit success criteria that Morrow must verify before claiming completion. These views read the mission's durable record.",
  complete: (prefix) => MISSION_VIEWS.filter((view) => view.startsWith(prefix)),
  async run(args, ctx) {
    if (!ctx.backend.getLatestMission) return unavailable("Missions");
    let mission;
    try {
      mission = await ctx.backend.getLatestMission();
    } catch (error) {
      return { notice: { level: "error", text: `Could not read the mission: ${errorText(error)}` } };
    }
    if (!mission) {
      return { notice: { level: "info", text: "No mission in this project. Start one with `morrow mission \"<objective>\"`." } };
    }

    const view = args.sub || "status";
    const header = `${mission.status} · started ${relativeTime(mission.startedAt ?? mission.createdAt)}`;

    switch (view) {
      case "status": {
        const met = mission.criteria.filter((criterion) => criterion.state === "verified").length;
        return {
          report: report("Mission")
            .subtitle(header)
            .text(mission.objective)
            .fields([
              { label: "Criteria verified", value: `${met} of ${mission.criteria.length}` },
              { label: "Evidence", value: String(mission.evidence.length) },
              { label: "Failures", value: String(mission.failures.length), tone: mission.failures.length > 0 ? "warning" : undefined },
              { label: "Checkpoints", value: String(mission.checkpoints.length) },
              { label: "Auto-approve", value: mission.autoApprove ? "on" : "off" },
            ])
            .hint("/mission criteria · evidence · failures · checkpoints · result")
            .build(),
        };
      }
      case "criteria": {
        if (mission.criteria.length === 0) return { notice: { level: "info", text: "This mission has no criteria yet." } };
        return {
          report: report("Success criteria")
            .subtitle(header)
            .table(
              ["State", "Criterion"],
              mission.criteria.map((criterion) => [criterion.state, criterion.description]),
              mission.criteria.map((criterion) =>
                criterion.state === "verified" ? "success" : criterion.state === "failed" ? "danger" : undefined,
              ),
            )
            .build(),
        };
      }
      case "evidence": {
        if (mission.evidence.length === 0) return { notice: { level: "info", text: "No evidence recorded yet." } };
        return {
          report: report("Evidence")
            .subtitle(header)
            .table(
              ["Status", "Type", "Summary", "Recorded"],
              mission.evidence
                .slice(-30)
                .map((entry) => [entry.status, entry.type, entry.summary, relativeTime(entry.recordedAt)]),
              mission.evidence.slice(-30).map((entry) => (entry.status === "failed" ? "danger" : "success")),
            )
            .build(),
        };
      }
      case "failures": {
        if (mission.failures.length === 0) {
          return { notice: { level: "info", text: "No failures recorded — nothing to recover from." } };
        }
        return {
          report: report("Failures")
            .subtitle(header)
            .table(
              ["Recovered", "Category", "Operation", "Message"],
              mission.failures
                .slice(-25)
                .map((failure) => [
                  failure.recovered ? "yes" : "no",
                  failure.category,
                  failure.operation.slice(0, 40),
                  failure.message.slice(0, 60),
                ]),
              mission.failures.slice(-25).map((failure) => (failure.recovered ? undefined : "danger")),
            )
            .build(),
        };
      }
      case "checkpoints": {
        if (mission.checkpoints.length === 0) return { notice: { level: "info", text: "No mission checkpoints." } };
        return {
          report: report("Mission checkpoints")
            .subtitle(header)
            .table(
              ["Label", "Rollback", "Files", "Created"],
              mission.checkpoints.map((checkpoint) => [
                checkpoint.label,
                checkpoint.rollbackAvailable ? "available" : "—",
                String(checkpoint.affectedFiles.length),
                relativeTime(checkpoint.createdAt),
              ]),
            )
            .build(),
        };
      }
      case "tree": {
        if (!mission.taskTreeRootId || !ctx.backend.getTaskTree) {
          return { notice: { level: "info", text: "This mission has no task tree yet." } };
        }
        try {
          const tree = await ctx.backend.getTaskTree(mission.taskTreeRootId);
          const lines: Array<{ text: string; marker: string }> = [];
          const walk = (node: import("../../client/api.js").TaskTreeNode, depth: number) => {
            lines.push({
              text: `${"  ".repeat(depth)}${node.task.kind} · ${node.task.status}`,
              marker: depth === 0 ? "▸" : "·",
            });
            for (const child of node.children ?? []) walk(child, depth + 1);
          };
          walk(tree, 0);
          return { report: report("Task tree").subtitle(header).list(lines).build() };
        } catch (error) {
          return { notice: { level: "error", text: `Could not read the task tree: ${errorText(error)}` } };
        }
      }
      case "result": {
        if (!mission.result) {
          return { notice: { level: "info", text: `Mission is ${mission.status} — no final result recorded yet.` } };
        }
        return {
          report: report("Mission result")
            .subtitle(header)
            .code(JSON.stringify(mission.result, null, 2), "json")
            .build(),
        };
      }
      default:
        return { notice: { level: "warn", text: `Unknown view "${view}". Try: ${MISSION_VIEWS.join(", ")}` } };
    }
  },
};

export const PROJECT_COMMANDS: Command[] = [
  cortexCommand,
  rulesCommand,
  memoryCommand,
  skillsCommand,
  agentsCommand,
  missionCommand,
];
