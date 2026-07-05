import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import type { Mission, MissionCriterion, MissionEvidence, MissionResult } from "@morrow/contracts";
import { ensureRunning } from "../service/lifecycle.js";
import { resolveProject, shortId } from "./common.js";
import { chatCommand } from "./chat.js";
import { Context as CliContext } from "../cli/context.js";
import { flagBool, flagString } from "../cli/args.js";
import { EXIT, usageError, notFound } from "../cli/errors.js";

const STATE_GLYPH: Record<string, string> = {
  verified: "✓", failed: "✗", waived: "◦", in_progress: "…", approved: "•", proposed: "•", unverified: "⚠",
};

/**
 * `morrow mission` — Verified Missions. With an objective it runs the full
 * accountable lifecycle: criteria → approval → execution → evidence-backed
 * verification → independent review → honest grade. Subcommands inspect state.
 */
export async function missionCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();

  switch (sub) {
    case "list": return listMissions(ctx, api);
    case "show": return showMission(ctx, api, args[0]);
    case "result": return showResult(ctx, api, args[0]);
    case "criteria": return showCriteria(ctx, api, args[0]);
    case "evidence": return showEvidence(ctx, api, args[0]);
    case "failures": return showFailures(ctx, api, args[0]);
    case "checkpoints": return showCheckpoints(ctx, api, args[0]);
    default: break;
  }

  // Treat everything else as the objective text.
  const objective = [sub, ...args].filter((v): v is string => Boolean(v)).join(" ").trim();
  if (!objective) {
    ctx.out.info("Usage: morrow mission \"<objective>\"   (or: list | show | result | criteria | evidence | failures | checkpoints)");
    return EXIT.USAGE;
  }
  return runMission(ctx, api, objective);
}

async function runMission(ctx: Context, api: MorrowApi, objective: string): Promise<number> {
  const project = await resolveProject(ctx, api, { required: true, autoCreateMissing: true });
  if (!project) return EXIT.NOT_FOUND;

  const autonomous = flagBool(ctx.flags, "yolo") || flagBool(ctx.flags, "yes") || !process.stdin.isTTY;
  const projectName = project.workspacePath.split(/[\\/]/).filter(Boolean).pop() ?? project.workspacePath;
  ctx.out.diag(ctx.out.gray(`  ${projectName}  ${project.workspacePath}  ·  Mission${autonomous ? " · autonomous" : ""}`));

  // 1. Create the mission and generate measurable criteria before execution.
  const created = await api.createMission(project.id, { objective, autoApprove: autonomous });
  ctx.out.info(ctx.out.gray("Understanding the objective and drafting success criteria…"));
  const withCriteria = await api.generateMissionCriteria(created.id, summarizeRepo(project.workspacePath));

  // 2. Show the mission contract before any substantial execution.
  renderContract(ctx, withCriteria);

  // 3. Approval gate. Autonomous missions auto-approve (and persist) the contract.
  let mission = withCriteria;
  if (mission.status === "awaiting_criteria_approval") {
    if (autonomous) {
      mission = await api.approveMission(mission.id);
    } else {
      ctx.out.info("");
      ctx.out.info(`Approve these criteria to begin? Re-run with ${ctx.out.cyan("--yes")} to approve and execute autonomously,`);
      ctx.out.info(`or use ${ctx.out.cyan("/criteria")} in the interactive shell to edit them first.`);
      return EXIT.OK;
    }
  } else if (mission.status === "running") {
    // auto-approved already
  }

  // 4. Checkpoint before the agent makes multi-file changes, so a bad run is
  //    reversible without touching unrelated work.
  try {
    const ckpt = await api.createMissionCheckpoint(mission.id, "pre-execution", "before autonomous mission execution");
    ctx.out.info(ctx.out.gray(`Checkpoint captured: ${ckpt.label} (${ckpt.affectedFiles.length} files)`));
  } catch { /* nothing to checkpoint yet is fine */ }

  // 5. Execute the work with the existing agent (proven coding capability),
  //    passing the objective and criteria as explicit acceptance targets.
  ctx.out.info("");
  ctx.out.info(ctx.out.magenta("Executing…"));
  await runAgentExecution(ctx, mission);

  // 6. Verify every executable criterion with concrete evidence.
  ctx.out.info("");
  ctx.out.info(ctx.out.gray("Verifying success criteria against the workspace…"));
  mission = await api.verifyMission(mission.id);
  renderCriteria(ctx, mission.criteria, true);

  // 7. Independent review (a separate execution with isolated instructions).
  ctx.out.info("");
  ctx.out.info(ctx.out.gray("Requesting independent review…"));
  const review = await api.reviewMission(mission.id);
  ctx.out.info(`  Review verdict: ${verdictLabel(ctx, review.verdict)}`);

  // 8. Grade honestly and show the result.
  mission = await api.finalizeMission(mission.id, { tasksCompleted: 1 });
  renderResult(ctx, mission);

  // A partial/blocked/failed grade is not a CLI error, but signal non-full.
  return mission.status === "completed" ? EXIT.OK : EXIT.OK;
}

async function runAgentExecution(ctx: Context, mission: Mission): Promise<void> {
  const criteriaText = mission.criteria.map((c, i) => `${i + 1}. ${c.description}`).join("\n");
  const prompt = [
    `Mission objective: ${mission.objective}`,
    "",
    "You must satisfy ALL of these measurable success criteria:",
    criteriaText,
    "",
    "Make the minimal correct changes to satisfy them. Preserve intended behaviour.",
    "Do not change unrelated files. When done, ensure the project runs.",
  ].join("\n");
  // Reuse the existing one-shot agent path in autonomous (yolo) mode. The
  // mission flag links the agent task to this mission so tool failures land
  // in the mission failure ledger (loop detection, /failures, honest grading).
  const flags: Record<string, string | boolean> = { message: prompt, yolo: true, mission: mission.id };
  const child = new CliContext({ out: ctx.out, config: ctx.config, paths: ctx.paths, flags: { ...ctx.flags, ...flags } });
  try {
    await chatCommand(child);
  } catch (err) {
    ctx.out.diag(ctx.out.yellow(`  Execution step reported an error; continuing to verification. (${err instanceof Error ? err.message : String(err)})`));
  }
}

// ── subcommands ────────────────────────────────────────────────────────────
async function resolveMission(ctx: Context, api: MorrowApi, id?: string): Promise<Mission> {
  if (id) return api.getMission(id);
  const project = await resolveProject(ctx, api, { required: true });
  if (!project) throw notFound("No project selected.");
  const missions = await api.listMissions(project.id);
  if (missions.length === 0) throw notFound("No missions in this project yet. Start one with `morrow mission \"<objective>\"`.");
  return missions[0]!; // most recent
}

async function listMissions(ctx: Context, api: MorrowApi): Promise<number> {
  const project = await resolveProject(ctx, api, { required: true });
  if (!project) return EXIT.NOT_FOUND;
  const missions = await api.listMissions(project.id);
  if (ctx.out.json) { ctx.out.data(missions); return EXIT.OK; }
  if (missions.length === 0) { ctx.out.info("No missions yet."); return EXIT.OK; }
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("Missions"));
  for (const m of missions) {
    ctx.out.info(`  ${ctx.out.cyan(shortId(m.id.replace(/^mission-/, "")))}  ${statusLabel(ctx, m.status)}  ${m.objective.slice(0, 60)}`);
  }
  return EXIT.OK;
}

async function showMission(ctx: Context, api: MorrowApi, id?: string): Promise<number> {
  const mission = await resolveMission(ctx, api, id);
  if (ctx.out.json) { ctx.out.data(mission); return EXIT.OK; }
  renderContract(ctx, mission);
  renderCriteria(ctx, mission.criteria, true);
  if (mission.result) renderResult(ctx, mission);
  return EXIT.OK;
}

async function showResult(ctx: Context, api: MorrowApi, id?: string): Promise<number> {
  const mission = await resolveMission(ctx, api, id);
  if (ctx.out.json) { ctx.out.data({ status: mission.status, result: mission.result, finalReview: mission.finalReview }); return EXIT.OK; }
  if (!mission.result) { ctx.out.info(`Mission is ${mission.status}; no final result yet.`); return EXIT.OK; }
  renderResult(ctx, mission);
  return EXIT.OK;
}

async function showCriteria(ctx: Context, api: MorrowApi, id?: string): Promise<number> {
  const mission = await resolveMission(ctx, api, id);
  if (ctx.out.json) { ctx.out.data(mission.criteria); return EXIT.OK; }
  renderCriteria(ctx, mission.criteria, true);
  return EXIT.OK;
}

async function showEvidence(ctx: Context, api: MorrowApi, id?: string): Promise<number> {
  const mission = await resolveMission(ctx, api, id);
  if (ctx.out.json) { ctx.out.data(mission.evidence); return EXIT.OK; }
  if (mission.evidence.length === 0) { ctx.out.info("No evidence recorded yet."); return EXIT.OK; }
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("Evidence ledger"));
  for (const e of mission.evidence) {
    const g = e.status === "passed" ? ctx.out.green("✓") : e.status === "failed" ? ctx.out.red("✗") : ctx.out.yellow("⚠");
    ctx.out.info(`  ${g} ${e.summary}`);
    if (e.command) ctx.out.info(ctx.out.gray(`     ${e.command}${e.exitCode !== null ? `  → exit ${e.exitCode}` : ""}`));
    ctx.out.info(ctx.out.gray(`     recorded ${formatTime(e.recordedAt)}`));
  }
  return EXIT.OK;
}

async function showFailures(ctx: Context, api: MorrowApi, id?: string): Promise<number> {
  const mission = await resolveMission(ctx, api, id);
  if (ctx.out.json) { ctx.out.data(mission.failures); return EXIT.OK; }
  if (mission.failures.length === 0) { ctx.out.info("No failures recorded."); return EXIT.OK; }
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("Failures and recovery"));
  for (const f of mission.failures) {
    const g = f.recovered ? ctx.out.green("recovered") : ctx.out.yellow("unresolved");
    ctx.out.info(`  [${f.category}] ${f.operation.slice(0, 70)}  ${g}`);
    if (f.recoveryStrategy) ctx.out.info(ctx.out.gray(`     strategy: ${f.recoveryStrategy}  (attempt ${f.attempt})`));
  }
  return EXIT.OK;
}

async function showCheckpoints(ctx: Context, api: MorrowApi, id?: string): Promise<number> {
  const mission = await resolveMission(ctx, api, id);
  if (ctx.out.json) { ctx.out.data(mission.checkpoints); return EXIT.OK; }
  if (mission.checkpoints.length === 0) { ctx.out.info("No checkpoints."); return EXIT.OK; }
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("Checkpoints"));
  mission.checkpoints.forEach((c, i) => {
    ctx.out.info(`  ${i + 1}. ${c.label}  ${ctx.out.gray(`${c.affectedFiles.length} files · ${c.rollbackAvailable ? "rollback available" : "no rollback"}`)}`);
    ctx.out.info(ctx.out.gray(`     ${c.reason}`));
  });
  return EXIT.OK;
}

// ── rendering ────────────────────────────────────────────────────────────────
export function renderContract(ctx: Context, mission: Mission): void {
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("MISSION CONTRACT"));
  ctx.out.info("");
  ctx.out.info(ctx.out.gray("Objective"));
  ctx.out.info(`  ${mission.objective}`);
  ctx.out.info("");
  ctx.out.info(ctx.out.gray("Success criteria"));
  mission.criteria.forEach((c, i) => {
    ctx.out.info(`  ${i + 1}. ${c.description}`);
    ctx.out.info(ctx.out.gray(`     verify: ${describeVerification(c)}`));
  });
  ctx.out.info("");
  ctx.out.info(ctx.out.gray(`Status: ${mission.status}`));
}

export function renderCriteria(ctx: Context, criteria: MissionCriterion[], withState: boolean): void {
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("Criteria"));
  criteria.forEach((c, i) => {
    const glyph = colorGlyph(ctx, c.state);
    ctx.out.info(`  ${glyph} ${i + 1}. ${c.description}  ${ctx.out.gray(`[${c.state}]`)}`);
    if (c.failureReason) ctx.out.info(ctx.out.gray(`       ${c.failureReason}`));
  });
}

export function renderResult(ctx: Context, mission: Mission): void {
  const r = mission.result;
  if (!r) return;
  ctx.out.info("");
  ctx.out.info(ctx.out.bold("MISSION RESULT"));
  ctx.out.info("");
  ctx.out.info(ctx.out.gray("Status"));
  ctx.out.info(`  ${statusLabel(ctx, r.status)}`);
  ctx.out.info("");
  ctx.out.info(ctx.out.gray("Objective"));
  ctx.out.info(`  ${r.objective}`);
  ctx.out.info("");
  ctx.out.info(ctx.out.gray("Criteria"));
  ctx.out.info(`  ${r.criteriaVerified} verified · ${r.criteriaFailed} failed · ${r.criteriaUnverified} unverified · ${r.criteriaWaived} waived`);
  ctx.out.info("");
  ctx.out.info(ctx.out.gray("Review"));
  ctx.out.info(`  ${r.reviewVerdict ? verdictLabel(ctx, r.reviewVerdict) : "no independent review on record"}`);
  ctx.out.info("");
  ctx.out.info(ctx.out.gray("Execution"));
  ctx.out.info(`  ${r.tasksCompleted} task(s) · ${r.failuresRecovered}/${r.failuresTotal} failures recovered · ${r.humanInterventions} human interventions`);
  if (r.elapsedMs !== null) ctx.out.info(ctx.out.gray(`  ${formatDuration(r.elapsedMs)}${r.spentUsd !== null ? ` · $${r.spentUsd.toFixed(2)}` : ""}`));
  if (r.unresolvedRisks.length > 0) {
    ctx.out.info("");
    ctx.out.info(ctx.out.gray("Unresolved"));
    for (const risk of r.unresolvedRisks.slice(0, 10)) ctx.out.info(`  • ${risk}`);
  }
  if (r.changedFiles.length > 0) {
    ctx.out.info("");
    ctx.out.info(ctx.out.gray(`Changed files (${r.changedFiles.length})`));
    for (const f of r.changedFiles.slice(0, 12)) ctx.out.info(`  ${f}`);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function describeVerification(c: MissionCriterion): string {
  const v = c.verification;
  if (v.command) return `${v.kind}: \`${v.command}\``;
  if (v.url) return `${v.kind}: GET ${v.url}${v.expectStatus ? ` == ${v.expectStatus}` : ""}`;
  if (v.pathScope) return `${v.kind}: changes within ${v.pathScope}`;
  return v.describe ?? v.kind;
}

function colorGlyph(ctx: Context, state: string): string {
  const g = STATE_GLYPH[state] ?? "•";
  if (state === "verified") return ctx.out.green(g);
  if (state === "failed") return ctx.out.red(g);
  if (state === "unverified") return ctx.out.yellow(g);
  return ctx.out.gray(g);
}

function statusLabel(ctx: Context, status: string): string {
  const pretty = status.replace(/_/g, " ");
  if (status === "completed") return ctx.out.green(pretty);
  if (status === "completed_with_reservations") return ctx.out.yellow(pretty);
  if (status === "failed" || status === "blocked") return ctx.out.red(pretty);
  if (status === "partially_completed") return ctx.out.yellow(pretty);
  if (status === "cancelled") return ctx.out.gray(pretty);
  return ctx.out.cyan(pretty);
}

function verdictLabel(ctx: Context, verdict: string): string {
  const pretty = verdict.replace(/_/g, " ");
  if (verdict === "approved") return ctx.out.green(pretty);
  if (verdict === "approved_with_risks") return ctx.out.yellow(pretty);
  return ctx.out.red(pretty);
}

function summarizeRepo(workspacePath: string): string {
  try {
    const entries = readdirSync(workspacePath).filter((e) => !e.startsWith(".git")).slice(0, 40);
    const parts: string[] = [`Top-level entries: ${entries.join(", ")}`];
    const pkgPath = join(workspacePath, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        parts.push(`package.json scripts: ${Object.keys(pkg.scripts ?? {}).join(", ") || "(none)"}`);
      } catch { /* ignore */ }
    }
    return parts.join("\n");
  } catch {
    return "(workspace summary unavailable)";
  }
}

function formatTime(iso: string): string {
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
}
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}
