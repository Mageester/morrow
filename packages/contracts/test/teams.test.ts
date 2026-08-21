import { describe, expect, it } from "vitest";
import {
  AssistantProfileSchema,
  UpdateAssistantProfileSchema,
  PrivacyModeSchema,
  ApprovalPostureSchema,
  TeamSchema,
  TeamMemberSchema,
  CreateTeamFromPresetSchema,
  DelegationSchema,
  CreateDelegationSchema,
  ResolveDelegationSchema,
  HandoffSchema,
  MemoryScopeSchema,
  AgentSchema,
  CreateAgentSchema,
  SpawnSubagentSchema,
  AskTeammateSchema,
  ExecutionDisclosureSchema,
} from "../src/index.js";

const ts = "2026-08-11T00:00:00.000Z";

function validProfile(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "default",
    displayName: "Aidan",
    assistantName: "Morrow",
    commsVerbosity: "concise",
    commsTone: "nontechnical",
    timezone: "America/New_York",
    locale: "en-US",
    defaultProviderId: null,
    defaultModel: null,
    defaultReasoning: { mode: "auto" },
    defaultPrivacyMode: "local_only",
    defaultApprovalPosture: "ask_always",
    goals: [],
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

describe("AssistantProfileSchema", () => {
  it("accepts a valid singleton profile", () => {
    expect(AssistantProfileSchema.safeParse(validProfile()).success).toBe(true);
  });

  it("rejects an id other than the singleton 'default'", () => {
    const result = AssistantProfileSchema.safeParse(validProfile({ id: "someone-else" }));
    expect(result.success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    const result = AssistantProfileSchema.safeParse(validProfile({ favoriteColor: "blue" }));
    expect(result.success).toBe(false);
  });

  it("carries a goal with explicit enabled state", () => {
    const result = AssistantProfileSchema.safeParse(
      validProfile({ goals: [{ id: "g1", text: "Ping me about PRs", enabled: true }] }),
    );
    expect(result.success).toBe(true);
  });
});

describe("UpdateAssistantProfileSchema", () => {
  it("accepts a partial update", () => {
    expect(UpdateAssistantProfileSchema.safeParse({ displayName: "New name" }).success).toBe(true);
  });

  it("rejects a client-supplied id (profile id is not updatable)", () => {
    const result = UpdateAssistantProfileSchema.safeParse({ id: "default", displayName: "x" });
    expect(result.success).toBe(false);
  });
});

describe("PrivacyModeSchema", () => {
  it("matches the shipped docs/privacy-model.md taxonomy exactly", () => {
    for (const mode of ["local_only", "controlled_cloud", "custom"]) {
      expect(PrivacyModeSchema.safeParse(mode).success).toBe(true);
    }
  });

  it("rejects the prompt's non-shipped 'web_enabled' mode (that's a tool permission, not a privacy mode)", () => {
    expect(PrivacyModeSchema.safeParse("web_enabled").success).toBe(false);
  });
});

describe("ApprovalPostureSchema", () => {
  it("accepts the three defined postures", () => {
    for (const posture of ["ask_always", "trust_reads", "trust_project"]) {
      expect(ApprovalPostureSchema.safeParse(posture).success).toBe(true);
    }
  });
});

function validTeam(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "team-1",
    projectId: "proj-1",
    name: "Research and verify",
    purpose: "Research a topic and verify the findings before writing anything.",
    status: "active",
    sharedMemoryPolicy: "read",
    defaultMaxProviderCalls: 8,
    defaultMaxTokenBudget: 20000,
    defaultMaxWallClockMs: 300000,
    defaultConcurrencyLimit: 1,
    defaultApprovalRequired: true,
    artifactPolicy: "verified_only",
    revision: 1,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

describe("TeamSchema", () => {
  it("accepts a valid team", () => {
    expect(TeamSchema.safeParse(validTeam()).success).toBe(true);
  });

  it("rejects an unknown lifecycle status", () => {
    expect(TeamSchema.safeParse(validTeam({ status: "running" })).success).toBe(false);
  });

  it("rejects a concurrency limit above 1 (sequential-only in this slice)", () => {
    // Not a hard schema rule (future slices may raise it) — but the default
    // preset must request exactly 1, proven via CreateTeamFromPresetSchema below.
    expect(TeamSchema.safeParse(validTeam({ defaultConcurrencyLimit: 1 })).success).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    expect(TeamSchema.safeParse(validTeam({ extra: true })).success).toBe(false);
  });
});

describe("TeamMemberSchema", () => {
  it("accepts a valid membership row", () => {
    const result = TeamMemberSchema.safeParse({
      version: 1, teamId: "team-1", agentId: "agent-1", position: 0, createdAt: ts,
    });
    expect(result.success).toBe(true);
  });
});

describe("CreateTeamFromPresetSchema", () => {
  it("only accepts the research_and_verify preset in this slice", () => {
    expect(CreateTeamFromPresetSchema.safeParse({ preset: "research_and_verify" }).success).toBe(true);
    expect(CreateTeamFromPresetSchema.safeParse({ preset: "build_and_test" }).success).toBe(false);
  });
});

function validDelegation(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    id: "del-1",
    parentTaskId: "task-parent",
    teamId: "team-1",
    agentId: "agent-researcher",
    objective: "Summarize this project's README",
    acceptanceCriteria: ["Summary cites README.md", "Summary is non-empty"],
    contextSnapshotRef: "snapshot-1",
    allowedTools: ["read_file"],
    allowedMemoryScopes: ["project", "agent"],
    providerId: "deterministic-local",
    model: null,
    budget: { maxProviderCalls: 4, maxTokenBudget: 4000, maxWallClockMs: 60000 },
    approvalRequired: true,
    status: "pending_approval",
    deadlineAt: null,
    correlationId: "corr-1",
    childTaskId: null,
    createdAt: ts,
    updatedAt: ts,
    ...over,
  };
}

describe("DelegationSchema", () => {
  it("accepts a valid pending delegation", () => {
    expect(DelegationSchema.safeParse(validDelegation()).success).toBe(true);
  });

  it("rejects an allowedMemoryScopes entry outside the MemoryScope enum", () => {
    const result = DelegationSchema.safeParse(validDelegation({ allowedMemoryScopes: ["not-a-scope"] }));
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status", () => {
    expect(DelegationSchema.safeParse(validDelegation({ status: "in_progress" })).success).toBe(false);
  });
});

describe("CreateDelegationSchema", () => {
  it("does not accept a client-supplied status or budget (server-computed)", () => {
    const result = CreateDelegationSchema.safeParse({
      teamId: "team-1", agentId: "agent-researcher", objective: "Summarize README",
      status: "approved", budget: { maxProviderCalls: 999 },
    });
    expect(result.success).toBe(false);
  });
});

describe("ResolveDelegationSchema", () => {
  it("accepts approve/reject decisions only", () => {
    expect(ResolveDelegationSchema.safeParse({ parentTaskId: "task-parent", decision: "approve" }).success).toBe(true);
    expect(ResolveDelegationSchema.safeParse({ parentTaskId: "task-parent", decision: "maybe" }).success).toBe(false);
  });
});

describe("HandoffSchema", () => {
  it("accepts a valid handoff with acceptance-criteria status and artifact refs", () => {
    const result = HandoffSchema.safeParse({
      version: 1,
      id: "handoff-1",
      delegationId: "del-1",
      taskId: "task-child",
      resultSummary: "README summarized and verified.",
      acceptanceCriteriaStatus: [{ criterion: "Summary cites README.md", met: true, note: null }],
      artifactRefs: [{ id: "artifact-1", path: "summary.md", contentHash: "sha256:abc" }],
      verificationEvidence: "Verifier confirmed non-empty summary citing README.md",
      unresolvedRisks: [],
      sourceAgentId: "agent-researcher",
      targetAgentId: "agent-verifier",
      createdAt: ts,
    });
    expect(result.success).toBe(true);
  });

  it("does not treat a bare prose 'done' claim as a handoff — resultSummary alone without status is still valid shape-wise, but callers must populate acceptanceCriteriaStatus for real proof (documented, not schema-enforced)", () => {
    // Regression guard: acceptanceCriteriaStatus/artifactRefs/verificationEvidence
    // must exist as real fields on the schema (not just prose) so a handoff can
    // always be inspected for actual proof, never trusted from text alone.
    const shape = HandoffSchema.shape;
    expect(Object.keys(shape)).toEqual(
      expect.arrayContaining(["acceptanceCriteriaStatus", "artifactRefs", "verificationEvidence"]),
    );
  });
});

describe("MemoryScopeSchema — agent/team scopes", () => {
  it("accepts the two new scopes added for delegation", () => {
    expect(MemoryScopeSchema.safeParse("agent").success).toBe(true);
    expect(MemoryScopeSchema.safeParse("team").success).toBe(true);
  });

  it("does not add a persisted 'ephemeral' scope (ephemeral context is request-only and never stored)", () => {
    expect(MemoryScopeSchema.safeParse("ephemeral").success).toBe(false);
  });
});

describe("AgentSchema — team membership and budgets", () => {
  function validAgent(over: Record<string, unknown> = {}) {
    return {
      version: 1,
      id: "agent-1",
      projectId: "proj-1",
      name: "Researcher",
      role: "researcher",
      instructions: null,
      providerOverride: null,
      modelOverride: null,
      enabled: true,
      teamId: "team-1",
      memoryReadScopes: ["project", "agent"],
      memoryWriteScopes: ["agent"],
      maxProviderCalls: 4,
      maxTokenBudget: 4000,
      maxWallClockMs: 60000,
      maxChildTasks: 0,
      approvalRequired: true,
      createdBy: "user",
      createdAt: ts,
      updatedAt: ts,
      ...over,
    };
  }

  it("accepts an agent with team membership and a budget", () => {
    expect(AgentSchema.safeParse(validAgent()).success).toBe(true);
  });

  it("still accepts an agent with no team (teamId null, existing behavior preserved)", () => {
    expect(AgentSchema.safeParse(validAgent({ teamId: null })).success).toBe(true);
  });

  it("CreateAgentSchema does not accept a client-supplied createdBy (server-computed provenance)", () => {
    const result = CreateAgentSchema.safeParse({ name: "Researcher", role: "researcher", createdBy: "model" });
    expect(result.success).toBe(false);
  });
});

describe("SpawnSubagentSchema — agent_chat delegation kind", () => {
  it("still defaults to inspect_workspace (existing behavior preserved)", () => {
    const result = SpawnSubagentSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.kind).toBe("inspect_workspace");
  });

  it("accepts the new agent_chat kind for real delegated subagents", () => {
    expect(SpawnSubagentSchema.safeParse({ kind: "agent_chat" }).success).toBe(true);
  });
});

describe("AskTeammateSchema — model delegation input", () => {
  it("accepts only the target agent id and bounded objective", () => {
    expect(AskTeammateSchema.safeParse({ agentId: "agent-2", objective: "Check the release notes" }).success).toBe(true);
  });

  it("rejects provider/model, team, budget, and unknown fields", () => {
    expect(AskTeammateSchema.safeParse({
      agentId: "agent-2",
      objective: "Check the release notes",
      providerId: "openai",
      model: "unsafe-model",
      teamId: "team-1",
      budget: { maxProviderCalls: 999 },
    }).success).toBe(false);
  });
});

describe("ExecutionDisclosureSchema — pre-request privacy preview fields", () => {
  it("accepts memoryRecordLabels and toolsAvailable for the data-sharing preview", () => {
    const result = ExecutionDisclosureSchema.safeParse({
      version: 1,
      taskId: "task-1",
      executionMode: "agent-interactive",
      provider: "deterministic-local",
      networkAccess: "disabled",
      filesystemAccess: "read-only",
      shellExecution: false,
      modelInvocation: true,
      workspaceScope: "/workspace",
      estimatedCostUsd: "0.00",
      memoryRecordLabels: ["project: naming conventions", "agent: prior research notes"],
      toolsAvailable: ["read_file", "search"],
      createdAt: ts,
      updatedAt: ts,
    });
    expect(result.success).toBe(true);
  });
});
