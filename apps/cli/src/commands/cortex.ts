import type { Context } from "../cli/context.js";
import type { Output } from "../cli/output.js";
import type { MorrowApi } from "../client/api.js";
import type {
  ProjectIntelligence, RepositoryConvention, ArchitectureDecision,
  ChangeImpactAnalysis, PlanRevision, ProjectRule,
} from "@morrow/contracts";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject, shortId } from "./common.js";
import { EXIT, usageError } from "../cli/errors.js";

/**
 * `morrow cortex` - inspect, refresh, correct, and forget Morrow's persistent
 * understanding of the repository. Stale knowledge is always labelled; inferred
 * conventions are visibly distinct from approved ones; user rules outrank
 * everything inferred.
 */
export function printCortexHelp(out: Output): number {
  const help = [
    "Morrow Cortex",
    "",
    "Usage:",
    "  morrow cortex status",
    "  morrow cortex map",
    "  morrow cortex refresh",
    "  morrow cortex conventions [show <id> | approve <id> | reject <id>]",
    "  morrow cortex decisions [show <id>]",
    "  morrow cortex risks",
    "  morrow cortex learnings",
    "  morrow cortex rules [add \"<rule text>\" | remove <id>]",
    "  morrow cortex forget [--all]",
    "  morrow cortex explain <component | topic>",
    "",
    "Cortex stores repository intelligence: architecture, commands, conventions, decisions, risks, rules, and mission learnings.",
  ].join("\n");
  if (out.json) out.data({ help });
  else out.print(help);
  return EXIT.OK;
}

export async function cortexCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  if (sub === "help") return printCortexHelp(ctx.out);

  await ensureRunning(ctx);
  const api = ctx.api();
  const project = await resolveProject(ctx, api, { required: true, autoCreateMissing: true });
  if (!project) return EXIT.NOT_FOUND;

  switch (sub ?? "status") {
    case "status": return status(ctx, api, project.id);
    case "map": return showMap(ctx, api, project.id);
    case "refresh": return refresh(ctx, api, project.id);
    case "conventions": return conventions(ctx, api, project.id, args);
    case "decisions": return decisions(ctx, api, project.id, args);
    case "risks": return risks(ctx, api, project.id);
    case "learnings": return learnings(ctx, api, project.id);
    case "rules": return rules(ctx, api, project.id, args);
    case "forget": return forget(ctx, api, project.id, args);
    case "explain": return explain(ctx, api, project.id, args);
    default:
      throw usageError(`Unknown cortex subcommand: ${sub}`,
        "Use: status | map | refresh | conventions | decisions | risks | learnings | rules | forget | explain <topic>");
  }
}

async function loadIntelligence(ctx: Context, api: MorrowApi, projectId: string): Promise<ProjectIntelligence | null> {
  try {
    return await api.getIntelligence(projectId);
  } catch {
    ctx.out.info("No project intelligence yet. Run `morrow cortex refresh` to map this repository.");
    return null;
  }
}

function freshnessLabel(ctx: Context, freshness: string): string {
  if (freshness === "current") return ctx.out.green("current");
  if (freshness === "possibly_stale") return ctx.out.yellow("possibly stale");
  return ctx.out.red(freshness.replace(/_/g, " "));
}

async function status(ctx: Context, api: MorrowApi, projectId: string): Promise<number> {
  const staleness = await api.intelligenceStaleness(projectId).catch(() => null);
  const intelligence = await loadIntelligence(ctx, api, projectId);
  if (!intelligence) return EXIT.OK;
  if (ctx.out.json) { ctx.out.data(intelligence); return EXIT.OK; }

  const conventions = intelligence.conventions;
  const approved = conventions.filter((c) => c.approval === "approved").length;
  const inferred = conventions.filter((c) => c.approval === "inferred").length;
  const activeDecisions = intelligence.decisions.filter((d) => d.status === "accepted").length;
  const staleItems = [...conventions, ...intelligence.missionLearnings, ...intelligence.risks]
    .filter((i) => i.freshness !== "current").length + (intelligence.architecture.freshness !== "current" ? 1 : 0);

  ctx.out.info("");
  ctx.out.info(ctx.out.bold("MORROW CORTEX"));
  ctx.out.info("");
  const row = (label: string, value: string) => ctx.out.info(`  ${label.padEnd(24)}${value}`);
  row("Architecture", freshnessLabel(ctx, intelligence.architecture.freshness));
  row("Components", String(intelligence.architecture.components.length));
  row("Commands", String(intelligence.commands.length));
  row("Conventions", `${approved} approved / ${inferred} inferred`);
  row("Decisions", `${activeDecisions} active`);
  row("Known risks", String(intelligence.risks.length));
  row("Mission learnings", String(intelligence.missionLearnings.length));
  row("User rules", String(intelligence.userRules.filter((r) => r.active).length));
  row("Stale items", staleItems > 0 ? ctx.out.yellow(String(staleItems)) : "0");
  if (staleness && staleness.changedScopes.length > 0) {
    row("Changed since refresh", ctx.out.yellow(staleness.changedScopes.join(", ")));
  }
  row("Last refresh", formatAgo(intelligence.refreshedAt));
  if (intelligence.uncertainties.length > 0) {
    ctx.out.info("");
    ctx.out.info(ctx.out.gray("Uncertain about"));
    for (const u of intelligence.uncertainties.slice(0, 5)) ctx.out.info(ctx.out.gray(`  - ${u.description}`));
  }
  return EXIT.OK;
}

async function showMap(ctx: Context, api: MorrowApi, projectId: string): Promise<number> {
  const intelligence = await loadIntelligence(ctx, api, projectId);
  if (!intelligence) return EXIT.OK;
  const arch = intelligence.architecture;
  if (ctx.out.json) { ctx.out.data(arch); return EXIT.OK; }

  ctx.out.info("");
  ctx.out.info(ctx.out.bold("PROJECT ARCHITECTURE") + (arch.freshness !== "current" ? `  ${ctx.out.yellow(`! ${arch.freshness.replace("_", " ")}`)}` : ""));
  if (arch.languages.length > 0) {
    ctx.out.info("");
    ctx.out.info(ctx.out.gray("Languages"));
    ctx.out.info(`  ${arch.languages.map((l) => `${l.language} (${l.files})`).join(" / ")}`);
  }
  const byKind: Record<string, string[]> = {};
  for (const c of arch.components) (byKind[c.kind] ??= []).push(`${c.path}${c.description ? ctx.out.gray(` - ${c.description}`) : ""}`);
  for (const [kind, list] of Object.entries(byKind)) {
    ctx.out.info("");
    ctx.out.info(ctx.out.gray(kind === "application" ? "Applications" : kind === "library" ? "Shared packages" : kind === "service" ? "Services" : `${kind[0]!.toUpperCase()}${kind.slice(1)}s`));
    for (const line of list) ctx.out.info(`  - ${line}`);
  }
  if (arch.generatedPaths.length > 0) {
    ctx.out.info("");
    ctx.out.info(ctx.out.gray("Generated / protected areas"));
    for (const g of arch.generatedPaths.slice(0, 8)) ctx.out.info(`  - ${g}`);
  }
  const validation = intelligence.commands.filter((c) => ["test", "build", "check", "e2e"].includes(c.role) && c.cwd === ".");
  if (validation.length > 0) {
    ctx.out.info("");
    ctx.out.info(ctx.out.gray("Validation"));
    for (const c of validation) ctx.out.info(`  - ${c.command}${c.lastVerifiedAt ? ctx.out.green("  verified") : ""}`);
  }
  return EXIT.OK;
}

async function refresh(ctx: Context, api: MorrowApi, projectId: string): Promise<number> {
  ctx.out.info(ctx.out.gray("Mapping repository from evidence..."));
  const intelligence = await api.refreshIntelligence(projectId);
  if (ctx.out.json) { ctx.out.data(intelligence); return EXIT.OK; }
  ctx.out.success(`Cortex refreshed: ${intelligence.architecture.components.length} component(s), ${intelligence.commands.length} command(s), ${intelligence.conventions.length} convention(s).`);
  return EXIT.OK;
}

async function conventions(ctx: Context, api: MorrowApi, projectId: string, args: string[]): Promise<number> {
  const [action, id] = args;
  if (action === "approve" || action === "reject") {
    if (!id) throw usageError(`Usage: morrow cortex conventions ${action} <id>`);
    const list = await api.listConventions(projectId);
    const target = resolveDisplayedId(list, id, "convention");
    const updated = await api.patchConvention(projectId, target.id, action === "approve" ? "approved" : "rejected");
    if (ctx.out.json) { ctx.out.data(updated); return EXIT.OK; }
    ctx.out.success(`Convention ${action === "approve" ? "approved" : "rejected"}: ${updated.description}`);
    return EXIT.OK;
  }
  const list = await api.listConventions(projectId);
  if (action === "show") {
    if (!id) throw usageError("Usage: morrow cortex conventions show <id>");
    const target = resolveDisplayedId(list, id, "convention");
    if (ctx.out.json) { ctx.out.data(target); return EXIT.OK; }
    renderConvention(ctx, target, true);
    return EXIT.OK;
  }
  if (ctx.out.json) { ctx.out.data(list); return EXIT.OK; }
  if (list.length === 0) { ctx.out.info("No conventions recorded. Run `morrow cortex refresh`."); return EXIT.OK; }
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("Repository conventions"));
  for (const c of list) renderConvention(ctx, c, false);
  ctx.out.info("");
  ctx.out.info(ctx.out.gray("Approve or reject inferred conventions: morrow cortex conventions approve <id>"));
  return EXIT.OK;
}

function renderConvention(ctx: Context, c: RepositoryConvention, detailed: boolean): void {
  const approval = c.approval === "approved" ? ctx.out.green("approved") : c.approval === "rejected" ? ctx.out.red("rejected") : ctx.out.yellow("inferred");
  const stale = c.freshness !== "current" ? `  ${ctx.out.yellow(`! ${c.freshness.replace("_", " ")}`)}` : "";
  ctx.out.info(`  ${ctx.out.cyan(shortId(c.id.replace(/^conv-/, "")))}  [${approval}]  ${c.description}${stale}`);
  if (detailed) {
    ctx.out.info(ctx.out.gray(`     confidence ${(c.confidence * 100).toFixed(0)}% / scope ${c.scope} / first observed ${formatAgo(c.firstObservedAt)}`));
    for (const s of c.sources) ctx.out.info(ctx.out.gray(`     source: ${s.reference}${s.note ? ` (${s.note})` : ""}`));
  }
}

async function decisions(ctx: Context, api: MorrowApi, projectId: string, args: string[]): Promise<number> {
  const list = await api.listDecisions(projectId);
  const [action, id] = args;
  if (action === "show") {
    const target = list.find((d) => d.id === id || d.label === id || d.label === `D-${id}` || d.id.includes(id ?? ""));
    if (!target) { ctx.out.warn(`No decision matching "${id}".`); return EXIT.NOT_FOUND; }
    if (ctx.out.json) { ctx.out.data(target); return EXIT.OK; }
    renderDecision(ctx, target, true);
    return EXIT.OK;
  }
  if (ctx.out.json) { ctx.out.data(list); return EXIT.OK; }
  if (list.length === 0) { ctx.out.info("No architecture decisions recorded yet. Missions record them as they settle questions."); return EXIT.OK; }
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("Architecture decisions"));
  for (const d of list) renderDecision(ctx, d, false);
  return EXIT.OK;
}

function renderDecision(ctx: Context, d: ArchitectureDecision, detailed: boolean): void {
  const status = d.status === "accepted" ? ctx.out.green(d.status) : d.status === "superseded" || d.status === "obsolete" ? ctx.out.gray(d.status) : ctx.out.yellow(d.status);
  ctx.out.info(`  ${ctx.out.cyan(d.label)}  [${status}]  ${d.statement}`);
  if (detailed) {
    if (d.context) ctx.out.info(ctx.out.gray(`     Reason: ${d.context}`));
    for (const c of d.consequences) ctx.out.info(ctx.out.gray(`     - ${c}`));
    if (d.missionId) ctx.out.info(ctx.out.gray(`     Source: mission ${shortId(d.missionId.replace(/^mission-/, ""))}`));
    if (d.supersededBy) ctx.out.info(ctx.out.gray(`     Superseded by ${d.supersededBy}`));
  }
}

async function risks(ctx: Context, api: MorrowApi, projectId: string): Promise<number> {
  const list = await api.listRisks(projectId);
  if (ctx.out.json) { ctx.out.data(list); return EXIT.OK; }
  if (list.length === 0) { ctx.out.info("No recorded risks."); return EXIT.OK; }
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("Known risks"));
  for (const r of list) {
    const sev = r.severity === "high" ? ctx.out.red(r.severity) : r.severity === "medium" ? ctx.out.yellow(r.severity) : ctx.out.gray(r.severity);
    ctx.out.info(`  [${sev}] ${r.description}  ${ctx.out.gray(r.area)}`);
  }
  return EXIT.OK;
}

async function learnings(ctx: Context, api: MorrowApi, projectId: string): Promise<number> {
  const list = await api.listLearnings(projectId);
  if (ctx.out.json) { ctx.out.data(list); return EXIT.OK; }
  if (list.length === 0) { ctx.out.info("No mission learnings yet. Learnings are extracted after each verified mission."); return EXIT.OK; }
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("Mission learnings"));
  for (const l of list) {
    const stale = l.freshness !== "current" ? `  ${ctx.out.yellow(`! ${l.freshness.replace("_", " ")}`)}` : "";
    ctx.out.info(`  [${l.type.replace(/_/g, " ")}] ${l.statement}${stale}`);
    ctx.out.info(ctx.out.gray(`     confidence ${(l.confidence * 100).toFixed(0)}% / mission ${shortId(l.missionId.replace(/^mission-/, ""))}`));
  }
  return EXIT.OK;
}

async function rules(ctx: Context, api: MorrowApi, projectId: string, args: string[]): Promise<number> {
  const [action, ...rest] = args;
  if (action === "add") {
    const text = rest.join(" ").trim();
    if (!text) throw usageError("Usage: morrow cortex rules add \"<rule text>\"");
    const rule = await api.addRule(projectId, text);
    if (ctx.out.json) { ctx.out.data(rule); return EXIT.OK; }
    ctx.out.success(`Rule added: ${rule.text}`);
    return EXIT.OK;
  }
  if (action === "remove" || action === "delete") {
    const id = rest[0];
    if (!id) throw usageError("Usage: morrow cortex rules remove <id>");
    const target = resolveDisplayedId(await api.listRules(projectId), id, "rule");
    await api.deleteRule(projectId, target.id);
    if (ctx.out.json) { ctx.out.data({ deleted: true, id: target.id }); return EXIT.OK; }
    ctx.out.success("Rule removed.");
    return EXIT.OK;
  }
  const list = await api.listRules(projectId);
  if (ctx.out.json) { ctx.out.data(list); return EXIT.OK; }
  if (list.length === 0) { ctx.out.info("No repository rules. Add one: morrow cortex rules add \"Never modify generated files.\""); return EXIT.OK; }
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("Repository rules") + ctx.out.gray("  (explicit rules outrank inferred conventions)"));
  for (const r of list) ctx.out.info(`  ${ctx.out.cyan(shortId(r.id.replace(/^rule-/, "")))}  ${r.text}`);
  return EXIT.OK;
}

async function forget(ctx: Context, api: MorrowApi, projectId: string, args: string[]): Promise<number> {
  const includeDurable = args.includes("--all");
  await api.forgetIntelligence(projectId, includeDurable);
  ctx.out.success(includeDurable
    ? "All project intelligence forgotten, including rules and decisions."
    : "Project intelligence forgotten. Rules and decision history retained (use `forget --all` to drop those too).");
  return EXIT.OK;
}

async function explain(ctx: Context, api: MorrowApi, projectId: string, args: string[]): Promise<number> {
  const topic = args.join(" ").toLowerCase().trim();
  if (!topic) throw usageError("Usage: morrow cortex explain <component | topic>");
  const intelligence = await loadIntelligence(ctx, api, projectId);
  if (!intelligence) return EXIT.OK;

  const component = intelligence.architecture.components.find((c) => c.path.toLowerCase().includes(topic) || c.name.toLowerCase().includes(topic));
  const relevantDecisions = intelligence.decisions.filter((d) => d.statement.toLowerCase().includes(topic) || d.affectedComponents.some((a) => a.toLowerCase().includes(topic)));
  const relevantLearnings = intelligence.missionLearnings.filter((l) => l.statement.toLowerCase().includes(topic) || l.scope.toLowerCase().includes(topic));
  const relevantConventions = intelligence.conventions.filter((c) => c.description.toLowerCase().includes(topic));

  if (!component && relevantDecisions.length === 0 && relevantLearnings.length === 0 && relevantConventions.length === 0) {
    ctx.out.info(`Cortex has no recorded knowledge about "${topic}". That itself is worth knowing - nothing will be invented.`);
    return EXIT.OK;
  }
  ctx.out.info("");
  ctx.out.info(ctx.out.bold(`What Cortex knows about "${topic}"`));
  if (component) {
    ctx.out.info("");
    ctx.out.info(`  ${component.path} (${component.kind})${component.description ? ` - ${component.description}` : ""}`);
    if (component.dependsOn.length > 0) ctx.out.info(ctx.out.gray(`  depends on: ${component.dependsOn.join(", ")}`));
    if (component.entryPoints.length > 0) ctx.out.info(ctx.out.gray(`  entry points: ${component.entryPoints.join(", ")}`));
  }
  for (const d of relevantDecisions) renderDecision(ctx, d, false);
  for (const c of relevantConventions) renderConvention(ctx, c, false);
  for (const l of relevantLearnings.slice(0, 8)) ctx.out.info(`  [learning] ${l.statement}`);
  return EXIT.OK;
}

// Mission-facing renderers shared with `morrow mission`.

export function renderImpact(ctx: Context, impact: ChangeImpactAnalysis): void {
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("CHANGE IMPACT"));
  const section = (label: string, items: string[], glyph = "-") => {
    if (items.length === 0) return;
    ctx.out.info("");
    ctx.out.info(ctx.out.gray(label));
    for (const item of items.slice(0, 8)) ctx.out.info(`  ${glyph} ${item}`);
  };
  section("Likely affected", [...impact.likelyComponents, ...impact.likelyFiles.slice(0, 4)]);
  section("Interfaces at risk", impact.interfacesAtRisk);
  section("Relevant history", [...impact.relevantDecisions, ...impact.relevantFailures]);
  section("Repository rules", impact.relevantRules);
  section("Possible regressions", impact.possibleRegressions);
  section("Required verification", impact.requiredVerification);
  section("Uncertain", impact.uncertainty, "!");
}

export function renderRevisions(ctx: Context, revisions: PlanRevision[]): void {
  if (revisions.length === 0) { ctx.out.info("No plan revisions - the original plan held."); return; }
  for (const r of revisions) {
    ctx.out.info("");
    ctx.out.info(ctx.out.bold(`PLAN REVISION ${r.revision}`) + ctx.out.gray(`  ${r.trigger.replace(/_/g, " ")}`));
    if (r.triggerDetail) ctx.out.info(ctx.out.gray(`  Trigger: ${r.triggerDetail}`));
    if (r.invalidatedAssumption) ctx.out.info(ctx.out.gray(`  Invalidated: ${r.invalidatedAssumption}`));
    for (const t of r.tasksRemoved) ctx.out.info(`  ${ctx.out.red("-")} ${t}`);
    for (const t of r.tasksAdded) ctx.out.info(`  ${ctx.out.green("+")} ${t}`);
    for (const v of r.verificationChanges) ctx.out.info(`  ${ctx.out.cyan("~")} ${v}`);
  }
}

function formatAgo(iso: string): string {
  try {
    const ms = Date.now() - Date.parse(iso);
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
    return `${Math.round(hours / 24)} days ago`;
  } catch {
    return iso;
  }
}

function resolveDisplayedId<T extends RepositoryConvention | ProjectRule>(items: T[], ref: string, label: string): T {
  const clean = ref.trim();
  const lowered = clean.toLowerCase();
  const matches = items.filter((item) => {
    const id = item.id.toLowerCase();
    const withoutPrefix = id.replace(/^(conv|rule)-/, "");
    return id === lowered || id.startsWith(lowered) || withoutPrefix === lowered || withoutPrefix.startsWith(lowered);
  });
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw usageError(
      `Ambiguous ${label} id "${ref}" - it matches ${matches.length} records.`,
      `Use a longer id: ${matches.map((item) => shortId(item.id.replace(/^(conv|rule)-/, ""))).join(", ")}`,
    );
  }
  throw usageError(`No ${label} matching "${ref}".`);
}
