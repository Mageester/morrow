/**
 * The contract between the terminal surface and the Morrow runtime.
 *
 * `SessionBackend` is the only way the shell reaches the orchestrator: send a
 * message, subscribe to its events, cancel it, and read the project-scoped
 * facts the commands need. Nothing in the terminal opens a socket or builds a
 * URL of its own, which is what makes the whole surface testable against a
 * fake and what stops a second execution path from growing here.
 *
 * These types lived inside the 2,300-line legacy session class, so importing
 * them dragged in the entire frame painter. They are their own module now.
 */
import type { AgentMode, ReasoningConfiguration } from "@morrow/contracts";
import type { RawTaskEvent } from "./task-event-adapter.js";
import type { ReportKind } from "./output-report.js";

export interface SendOptions {
  mode: AgentMode;
  autoApprove: boolean;
  provider?: string | undefined;
  model?: string | undefined;
  preset: string;
  useMemory: boolean;
  reasoning?: ReasoningConfiguration | undefined;
}

export interface ApprovalView {
  id: string;
  kind: "command" | "change_set";
  details: Record<string, unknown>;
  projectId: string;
}

export interface SessionRouting {
  provider: string;
  model: string;
  preset: string;
  fallback: boolean;
  overridden: boolean;
  privacy: string;
  /** The reasoning selection frozen into this route at send time. Absent
   *  means Auto (the route's own default) — never inferred otherwise. */
  reasoning?: ReasoningConfiguration | undefined;
}

export interface SessionBackend {
  send(text: string, opts: SendOptions): Promise<{ taskId: string; routing?: SessionRouting }>;
  subscribe(taskId: string, signal: AbortSignal, after?: number): AsyncIterable<RawTaskEvent>;
  cancel(taskId: string): Promise<void>;
  resume(taskId: string): Promise<void>;
  compact?(taskId: string | null, settings: SendOptions): Promise<{
    compacted: boolean;
    summary: { id: string; method: "deterministic" | "fallback"; sourceMessageCount: number; createdAt: string };
    routing: SessionRouting;
    context: { effectiveRequestLimitTokens: number; effectiveLimitSource: string };
  }>;
  getApproval(id: string): Promise<ApprovalView>;
  resolveApproval(id: string, decision: string, trustPattern?: string): Promise<void>;
  getPlan(taskId: string): Promise<Array<{ id: string; title: string; status: string }>>;
  getTask(taskId: string): Promise<import("../client/api.js").TaskAggregate>;
  getFinalAnswer?(taskId: string): Promise<string | null>;
  exportReport?(taskId: string, kind: ReportKind, finalAnswer: string | null, requestedName?: string): Promise<string>;
  getTaskTree(taskId: string): Promise<import("../client/api.js").TaskTreeNode>;
  getTaskDiff?(taskId: string): Promise<{ diff: string | null; files: string[] }>;
  undoTask?(taskId: string): Promise<{ status: string; restoredFiles: string[] }>;
  search?(query: string): Promise<Array<{ kind: string; title: string; snippet: string }>>;
  recordSkillUse?(skillId: string): Promise<void>;
  /** Most recent mission for the active project, or null. Powers the mission
   *  status area and the /criteria|/evidence|/failures|/checkpoints commands. */
  getLatestMission?(): Promise<import("@morrow/contracts").Mission | null>;
  /** Cortex: persistent project intelligence for /cortex /map /conventions
   *  /decisions /risks /learnings /rules; null when not yet mapped. */
  getIntelligence?(): Promise<import("@morrow/contracts").ProjectIntelligence | null>;
  patchConvention?(conventionId: string, approval: "approved" | "rejected"): Promise<void>;
  addRule?(text: string): Promise<void>;
  removeRule?(ruleId: string): Promise<void>;
  getMissionImpact?(missionId: string): Promise<import("@morrow/contracts").ChangeImpactAnalysis[]>;
  getMissionRevisions?(missionId: string): Promise<import("@morrow/contracts").PlanRevision[]>;
  listAgents?(): Promise<import("@morrow/contracts").Agent[]>;
  /** Live capability report for /capabilities — what this build can do now. */
  getCapabilities?(): Promise<import("../commands/capabilities.js").CapabilityReport>;
  /** Known model registry for the /model picker (facts, not guesses). */
  listModels?(): Promise<import("@morrow/contracts").ModelStatus[]>;
  /** Canonical per-model budget view for the /model detail panel — the same
   *  resolveModelBudget() computation every agent execution path uses. */
  getModelBudgets?(): Promise<import("@morrow/contracts").ModelBudgetView[]>;
  /** Configured-provider status (for the picker's default-model marker and
   *  auth/configuration state — never re-derived independently). */
  listProviders?(): Promise<import("@morrow/contracts").ProviderStatus[]>;
  /** Read-only categorized Git status for /branch, /changes, and resume digest. */
  getGitStatus?(): Promise<import("../cli/gitinfo.js").GitStatus | null>;
  /** Recent tasks for the active project — powers /tasks and /output <task-id>. */
  listTasks?(): Promise<import("@morrow/contracts").Task[]>;
  /** Cortex staleness for the resume freshness check. */
  getCortexStaleness?(): Promise<import("./resume.js").ResumeStaleness | null>;

  // ── Surface the command layer needs ──────────────────────────────────────
  // Everything below is thin delegation to the orchestrator HTTP API. It lives
  // on the backend contract rather than in the command handlers so the whole
  // command surface stays testable against one fake, and so no command can
  // reach for a URL or a second client of its own.

  /** Service health, for /status and /doctor. */
  health?(): Promise<import("@morrow/contracts").Health>;
  /** Recent conversations in this project, newest first. */
  listConversations?(): Promise<import("@morrow/contracts").Conversation[]>;
  /** Start a new conversation and make it active. */
  newConversation?(title?: string): Promise<import("@morrow/contracts").Conversation>;
  /** Switch the active conversation, replaying nothing. */
  switchConversation?(id: string): Promise<import("@morrow/contracts").Conversation>;
  /** Messages in the active conversation, oldest first. */
  listMessages?(): Promise<import("@morrow/contracts").ConversationMessage[]>;

  /** Named workspace checkpoints. */
  listCheckpoints?(): Promise<Array<{ id: string; name: string; taskId: string | null; fileCount: number; createdAt: string }>>;
  saveCheckpoint?(name: string): Promise<{ name: string; fileCount: number }>;
  restoreCheckpoint?(name: string): Promise<{ restoredFiles: string[]; deletedFiles: string[] }>;
  deleteCheckpoint?(name: string): Promise<void>;

  /** Background processes started by the agent. */
  listProcesses?(): Promise<import("../client/api.js").ProcessRecord[]>;
  killProcess?(id: string, force?: boolean): Promise<void>;

  /** Isolated worktrees and their integration attempts. */
  listWorktrees?(): Promise<import("../client/api.js").WorktreeRecord[]>;
  inspectWorktree?(id: string): Promise<import("../client/api.js").WorktreeStatusReport>;
  removeWorktree?(id: string, preserve?: boolean): Promise<void>;
  listIntegrations?(): Promise<import("../client/api.js").IntegrationAttempt[]>;
  checkIntegration?(worktreeId: string): Promise<import("../client/api.js").IntegrationAttempt>;
  applyIntegration?(id: string): Promise<import("../client/api.js").IntegrationAttempt>;

  /** Project memory entries. */
  listMemory?(): Promise<import("@morrow/contracts").MemoryEntry[]>;
  addMemory?(content: string): Promise<import("@morrow/contracts").MemoryEntry>;
  forgetMemory?(id: string): Promise<void>;

  /** Observability. */
  listTools?(): Promise<import("@morrow/contracts").ToolSpec[]>;
  permissions?(): Promise<import("@morrow/contracts").PermissionProfile>;
  audit?(limit?: number): Promise<import("@morrow/contracts").AuditEntry[]>;
  listPresets?(): Promise<import("@morrow/contracts").PresetStatus[]>;

  /** Missions in this project, newest first. */
  listMissions?(): Promise<import("@morrow/contracts").Mission[]>;
  getMissionResult?(missionId: string): Promise<unknown>;

  /** Re-run the most recent task with the same input. */
  retryTask?(taskId: string): Promise<{ taskId: string }>;

  /** Locally discovered skills, for /skills. */
  listSkills?(): Promise<Array<{ id: string; description: string; risk?: string }>>;
}
