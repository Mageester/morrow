/**
 * Pure expanded-activity view for `/activity` (and its `/details` alias).
 *
 * The live region only shows the last few grouped activities; this view unfolds
 * the whole session's observable work: every activity group as a stage heading
 * with a one-line summary, then completed/failed tool cards with their real
 * durations and outcomes, then agents with their roles, tasks, and states.
 *
 * It renders only *observable* actions — files read, patches applied, tests run,
 * agent roles/states. Internal chain-of-thought is never an activity and never
 * appears here. Pure and snapshot-testable.
 */
import type { Output } from "../cli/output.js";
import type { AgentInfo } from "./events.js";
import type { TerminalState } from "./state.js";
import { glyphs, groupActivities, stageLabel, toolCardLines, type ActivityGroup } from "./view.js";

/** One-line summary of a group's observable outcome (counts + a few targets). */
export function activityGroupSummary(group: ActivityGroup): string {
  const parts: string[] = [];
  const total = group.counts.reduce((s, c) => s + c, 0);
  if (total > 0) {
    const noun = group.kind === "searching" ? "result" : group.kind === "reading" ? "file" : group.kind === "applying_patch" ? "file" : "item";
    parts.push(`${total} ${noun}${total === 1 ? "" : "s"}`);
  }
  if (group.targets.length > 0) {
    const shown = group.targets.slice(0, 3).join(", ");
    parts.push(group.targets.length > 3 ? `${shown} +${group.targets.length - 3} more` : shown);
  }
  return parts.join(" · ");
}

/** Role/task/state line for one agent; only asserts what the state model knows. */
export function agentDetailLine(agent: AgentInfo, out: Output): string {
  const state =
    agent.status === "completed"
      ? out.green(agent.status)
      : agent.status === "failed" || agent.status === "cancelled"
        ? out.red(agent.status)
        : agent.status === "running"
          ? out.cyan(agent.status)
          : out.gray(agent.status);
  const bits = [out.bold(agent.name), out.gray(`[${agent.role}]`), state];
  if (agent.taskId) bits.push(out.gray(`task ${agent.taskId.slice(0, 8)}`));
  return "  " + bits.join(" ");
}

export function activityDetailLines(state: TerminalState, out: Output, unicode: boolean, workspace?: string): string[] {
  const g = glyphs(unicode);
  const lines: string[] = [];

  const groups = groupActivities(state.activity);
  if (groups.length > 0) {
    lines.push(out.bold("Activity"));
    for (const group of groups) {
      lines.push(`  ${out.cyan(g.run)} ${stageLabel(group.stage)}`);
      const summary = activityGroupSummary(group);
      if (summary) lines.push(`      ${out.gray(summary)}`);
    }
    lines.push("");
  }

  const finished = state.tools.filter((t) => t.status !== "running");
  const running = state.tools.filter((t) => t.status === "running");
  if (finished.length > 0 || running.length > 0) {
    lines.push(out.bold(`Tools (${state.tools.length})`));
    for (const card of running) for (const l of toolCardLines(card, out, unicode, 0, workspace)) lines.push(l);
    for (const card of finished) for (const l of toolCardLines(card, out, unicode, 0, workspace)) lines.push(l);
    lines.push("");
  }

  if (state.agents.length > 0) {
    lines.push(out.bold(`Agents (${state.agents.length})`));
    for (const agent of state.agents) lines.push(agentDetailLine(agent, out));
    lines.push("");
  }

  if (state.processes.length > 0) {
    const running = state.processes.filter((p) => p.status === "running");
    lines.push(out.bold(`Processes (${running.length} running / ${state.processes.length})`));
    for (const p of state.processes) {
      const mark = p.status === "running" ? out.cyan("●") : p.status === "exited" ? out.gray("○") : out.red("×");
      lines.push(`  ${mark} ${p.name}${p.exitCode !== undefined ? out.gray(` · exit ${p.exitCode}`) : ""}`);
    }
    lines.push("");
  }

  if (lines.length === 0) {
    lines.push(out.gray("No activity yet in this session. Ask a question or start a task to see grouped work here."));
  } else if (state.status === "streaming") {
    lines.push(out.gray("Working…"));
  }
  return lines;
}
