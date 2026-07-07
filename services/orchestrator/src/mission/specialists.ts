import type { AgentRole, Mission, MissionEvent, MissionSpecialistRole } from "@morrow/contracts";
import { MissionSpecialistRoleSchema } from "@morrow/contracts";
import type { agentsRepository } from "../repositories/agents.js";

type AgentRepo = ReturnType<typeof agentsRepository>;

type RoleTemplate = Omit<MissionSpecialistRole, "missionId" | "taskId" | "agentId" | "status"> & {
  agentRole: AgentRole;
  instructions: string;
};

const templates: RoleTemplate[] = [
  {
    id: "repository-mapper",
    name: "Cortex Repository Mapper",
    agentRole: "architect",
    objective: "Map the repository from bounded evidence before planning or editing.",
    allowedTools: ["inspect_workspace", "list_files", "read_file", "search_files", "search_text", "search_symbols", "git_status"],
    requiredInputs: ["mission objective", "project intelligence", "freshness/staleness report", "repository source references"],
    structuredOutput: "JSON object with components, boundaries, sources, confidence, stale scopes, and uncertainty.",
    budget: { maxToolCalls: 12, maxContextBytes: 120_000, maxUsd: null },
    timeoutMs: 120_000,
    completionCriteria: ["Architecture-critical evidence is read", "Stale scopes are labelled", "No unsupported repository facts are asserted"],
    storesChainOfThought: false,
    instructions: "Produce an evidence-backed repository map. Use bounded reads/searches only. Return source references, confidence, stale scopes, and uncertainties; do not include hidden reasoning.",
  },
  {
    id: "planner",
    name: "Cortex Planner",
    agentRole: "architect",
    objective: "Turn the objective and Cortex impact analysis into an auditable implementation plan.",
    allowedTools: ["read_file", "search_files", "search_text", "search_symbols", "git_status", "git_diff"],
    requiredInputs: ["mission objective", "impact analysis", "approved criteria", "rules", "decisions", "risks", "mission learnings"],
    structuredOutput: "JSON array of ordered tasks with assumptions, dependencies, verification, and replan triggers.",
    budget: { maxToolCalls: 8, maxContextBytes: 80_000, maxUsd: null },
    timeoutMs: 90_000,
    completionCriteria: ["Plan references relevant rules and decisions", "Verification is executable", "Replan triggers are explicit"],
    storesChainOfThought: false,
    instructions: "Create a bounded plan using Cortex facts, explicit rules, prior learnings, and approved criteria. Return structured tasks and verification only.",
  },
  {
    id: "implementer",
    name: "Cortex Implementer",
    agentRole: "assistant",
    objective: "Apply the smallest coherent code change that satisfies the approved plan.",
    allowedTools: ["read_file", "search_files", "search_text", "search_symbols", "git_status", "git_diff", "run_command", "propose_patch"],
    requiredInputs: ["approved plan", "affected files", "rules", "protected/generated paths", "current git status"],
    structuredOutput: "JSON object with changed files, rationale, commands run, and remaining risks.",
    budget: { maxToolCalls: 24, maxContextBytes: 180_000, maxUsd: null },
    timeoutMs: 300_000,
    completionCriteria: ["Changes stay in allowed scope", "Generated/protected paths are not edited directly", "Patch is reviewable"],
    storesChainOfThought: false,
    instructions: "Implement only the approved plan. Respect user rules and generated/protected paths. Return changed files, evidence, and risks; do not include hidden reasoning.",
  },
  {
    id: "test-engineer",
    name: "Cortex Test Engineer",
    agentRole: "tester",
    objective: "Verify the change with focused and repository-level checks.",
    allowedTools: ["read_file", "search_files", "search_text", "git_status", "git_diff", "run_command"],
    requiredInputs: ["approved criteria", "changed files", "mapped commands", "risk list", "plan revisions"],
    structuredOutput: "JSON object with commands, exit codes, evidence refs, failures, and coverage gaps.",
    budget: { maxToolCalls: 16, maxContextBytes: 120_000, maxUsd: null },
    timeoutMs: 240_000,
    completionCriteria: ["Relevant commands are run or explicitly justified", "Failures are recorded", "Evidence supports each verified criterion"],
    storesChainOfThought: false,
    instructions: "Run relevant checks and record evidence. Report command, exit code, output reference, and remaining gaps only.",
  },
  {
    id: "security-regression-reviewer",
    name: "Cortex Security Reviewer",
    agentRole: "security",
    objective: "Review security-sensitive and regression-prone changes independently from the implementer.",
    allowedTools: ["read_file", "search_files", "search_text", "search_symbols", "git_status", "git_diff"],
    requiredInputs: ["diff", "security-sensitive areas", "rules", "risks", "verification evidence"],
    structuredOutput: "JSON object with verdict, security findings, regression risks, required fixes, and evidence.",
    budget: { maxToolCalls: 10, maxContextBytes: 100_000, maxUsd: null },
    timeoutMs: 120_000,
    completionCriteria: ["Security-sensitive areas are considered", "Findings cite evidence", "No implementer claims are trusted without evidence"],
    storesChainOfThought: false,
    instructions: "Audit the diff for security and regressions. Cite evidence and return verdict/findings only. Do not rely on implementer self-claims.",
  },
  {
    id: "final-reviewer",
    name: "Cortex Final Reviewer",
    agentRole: "code-reviewer",
    objective: "Make the final mission completion judgment from criteria, evidence, failures, review findings, and diff.",
    allowedTools: ["read_file", "search_files", "search_text", "git_status", "git_diff"],
    requiredInputs: ["mission criteria", "verification evidence", "failure ledger", "security review", "diff", "known limitations"],
    structuredOutput: "JSON mission verdict with criterion judgments, missing verification, regression risks, and recommended status.",
    budget: { maxToolCalls: 8, maxContextBytes: 100_000, maxUsd: null },
    timeoutMs: 120_000,
    completionCriteria: ["Every criterion has a judgment", "Missing evidence blocks full success", "Rollback/limitation notes are explicit"],
    storesChainOfThought: false,
    instructions: "Independently grade completion from evidence, failures, and diff. Return only the structured verdict and limitations.",
  },
];

export function buildMissionSpecialists(mission: Pick<Mission, "id" | "taskTreeRootId">): MissionSpecialistRole[] {
  return templates.map((template) => {
    const { agentRole: _agentRole, instructions: _instructions, ...role } = template;
    return MissionSpecialistRoleSchema.parse({
      ...role,
      missionId: mission.id,
      taskId: mission.taskTreeRootId ?? null,
      agentId: null,
      status: "pending",
    });
  });
}

export function specialistsFromEvents(events: MissionEvent[], mission: Pick<Mission, "id" | "taskTreeRootId">): MissionSpecialistRole[] {
  const latest = [...events].reverse().find((event) => event.type === "mission.specialists_planned");
  const roles = Array.isArray(latest?.data?.roles) ? latest.data.roles : null;
  if (!roles) return buildMissionSpecialists(mission);
  return roles.map((role) => MissionSpecialistRoleSchema.parse(role));
}

export function ensureCortexSpecialistAgents(projectId: string, agents: AgentRepo) {
  const existing = agents.listByProject(projectId);
  const ensured = [];
  for (const template of templates) {
    const current = existing.find((agent) => agent.name === template.name);
    const instructions = renderInstructions(template);
    const agent = current
      ? agents.update(current.id, projectId, { role: template.agentRole, instructions, enabled: true })!
      : agents.create({ id: crypto.randomUUID(), projectId, name: template.name, role: template.agentRole, instructions });
    for (const toolName of template.allowedTools) {
      agents.upsertToolPermission(agent.id, { toolName, effect: "allow", priority: 10 });
    }
    ensured.push(agent);
  }
  return ensured;
}

function renderInstructions(template: RoleTemplate): string {
  return [
    `Objective: ${template.objective}`,
    `Allowed tools: ${template.allowedTools.join(", ")}`,
    `Required inputs: ${template.requiredInputs.join("; ")}`,
    `Structured output: ${template.structuredOutput}`,
    `Budget: ${template.budget.maxToolCalls} tool calls, ${template.budget.maxContextBytes} context bytes, timeout ${template.timeoutMs}ms`,
    `Completion criteria: ${template.completionCriteria.join("; ")}`,
    "Do not store or reveal chain-of-thought. Exchange structured artifacts, evidence, and concise rationale only.",
    template.instructions,
  ].join("\n");
}
