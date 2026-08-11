import type Database from "better-sqlite3";
import type { Agent, Team } from "@morrow/contracts";
import { agentsRepository } from "../repositories/agents.js";
import { teamsRepository } from "../repositories/teams.js";

/**
 * The one team preset offered in this slice: a Researcher (read-only,
 * bounded sources, no writes) and a Verifier (inspects the Researcher's
 * output, runs safe checks, writes only the approved artifact). Shared by
 * the `/teams` route and the deterministic sample-task runner so both
 * instantiate the exact same policy — never two slightly different copies.
 */
export function createResearchAndVerifyTeam(
  db: Database.Database,
  projectId: string,
  name: string | undefined,
  createId: () => string = () => crypto.randomUUID(),
): { team: Team; researcher: Agent; verifier: Agent } {
  const agents = agentsRepository(db);
  const teams = teamsRepository(db);
  const now = new Date().toISOString();

  const team = teams.create({
    id: createId(),
    projectId,
    name: name ?? "Research and verify",
    purpose: "Research a topic and verify the findings before writing anything.",
    sharedMemoryPolicy: "read",
    defaultMaxProviderCalls: 8,
    defaultMaxTokenBudget: 20000,
    defaultMaxWallClockMs: 300000,
    defaultApprovalRequired: true,
    artifactPolicy: "verified_only",
    createdAt: now,
  });

  const researcher = agents.create({
    id: createId(), projectId, name: "Researcher", role: "researcher",
    instructions: "Read and search only. Summarize findings with citations. Never write files.",
    teamId: team.id,
    memoryReadScopes: ["project", "agent"], memoryWriteScopes: ["agent"],
    maxProviderCalls: 4, maxTokenBudget: 8000, maxWallClockMs: 120000,
    approvalRequired: false,
    createdBy: "user",
  });
  agents.upsertToolPermission(researcher.id, { toolName: "read_file", effect: "allow" });
  agents.upsertToolPermission(researcher.id, { toolName: "run_command", effect: "deny", priority: 10 });
  agents.upsertToolPermission(researcher.id, { toolName: "create_file", effect: "deny", priority: 10 });

  const verifier = agents.create({
    id: createId(), projectId, name: "Verifier", role: "tester",
    instructions: "Inspect the Researcher's output, run safe checks, and write only the approved verified artifact.",
    teamId: team.id,
    memoryReadScopes: ["project", "agent", "team"], memoryWriteScopes: ["team"],
    maxProviderCalls: 4, maxTokenBudget: 8000, maxWallClockMs: 120000,
    approvalRequired: true,
    createdBy: "user",
  });
  agents.upsertToolPermission(verifier.id, { toolName: "read_file", effect: "allow" });
  agents.upsertToolPermission(verifier.id, { toolName: "create_file", effect: "allow" });
  agents.upsertToolPermission(verifier.id, { toolName: "run_command", effect: "deny", priority: 10 });

  teams.addMember(team.id, researcher.id, 0, now);
  teams.addMember(team.id, verifier.id, 1, now);
  const activated = teams.setStatus(team.id, "active", now)!;

  return { team: activated, researcher: agents.get(researcher.id)!, verifier: agents.get(verifier.id)! };
}
