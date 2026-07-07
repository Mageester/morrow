import { randomUUID } from "node:crypto";
import type {
  ProjectIntelligence, ArchitectureMap, ArchitectureDecision, ProjectRule,
  RepositoryConvention, IntelligenceFreshness, CreateProjectRuleInput,
  MissionLearning, ChangeImpactAnalysis, PlanRevision, PlanRevisionTrigger,
} from "@morrow/contracts";
import { PROJECT_INTELLIGENCE_SCHEMA_VERSION, MAX_PLAN_REVISIONS } from "@morrow/contracts";
import type { IntelligenceRepository } from "../repositories/intelligence.js";
import { generateArchitectureMap } from "./mapper.js";
import { computeScopeFingerprints, computeRepositoryFingerprint, diffScopes } from "./fingerprint.js";

export class CortexError extends Error {
  constructor(message: string, public readonly code: "not_found" | "conflict" | "no_workspace" | "validation" | "limit" = "validation") {
    super(message);
    this.name = "CortexError";
  }
}

export interface CortexServiceDeps {
  repo: IntelligenceRepository;
  getWorkspacePath: (projectId: string) => string | undefined;
  now?: () => string;
}

/** Knowledge scopes → which intelligence kinds a change there can invalidate. */
const SCOPE_INVALIDATIONS: Record<string, { architecture: boolean; kinds: Array<"convention" | "command" | "risk" | "relationship" | "learning"> }> = {
  manifests: { architecture: true, kinds: ["command", "relationship"] },
  lockfiles: { architecture: false, kinds: ["command"] },
  workspaces: { architecture: true, kinds: ["command", "relationship", "convention"] },
  entry_points: { architecture: true, kinds: ["relationship", "learning"] },
  build_config: { architecture: true, kinds: ["command", "convention"] },
  test_config: { architecture: false, kinds: ["command", "learning"] },
  ci: { architecture: false, kinds: ["command"] },
  database: { architecture: false, kinds: ["risk", "learning"] },
  rules: { architecture: false, kinds: [] },
};

/**
 * CortexService owns the project-intelligence lifecycle: deterministic
 * mapping, scoped staleness detection, incremental refresh, convention
 * approval, user rules, the decision ledger, mission learnings, impact
 * analysis, and bounded plan revisions. Facts come from repository evidence;
 * this service never fabricates knowledge and never presents stale items as
 * current.
 */
export class CortexService {
  private readonly now: () => string;

  constructor(private readonly deps: CortexServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  private workspace(projectId: string): string {
    const ws = this.deps.getWorkspacePath(projectId);
    if (!ws) throw new CortexError("Project workspace not found", "no_workspace");
    return ws;
  }

  /** Build (or fully rebuild) intelligence from repository evidence. */
  build(projectId: string): ProjectIntelligence {
    const ws = this.workspace(projectId);
    const timestamp = this.now();
    const generated = generateArchitectureMap(ws, this.now);
    const fingerprint = computeRepositoryFingerprint(generated.architecture.scopeFingerprints);

    const existing = this.deps.repo.getHeader(projectId);
    this.deps.repo.upsertHeader(projectId, fingerprint, generated.architecture, existing?.generatedAt ?? timestamp, timestamp);

    // Regenerating deterministic knowledge replaces prior deterministic items;
    // mission learnings, decisions, and user rules are durable and untouched.
    // Approved conventions survive a rebuild: re-inference must not silently
    // discard an explicit human approval.
    const priorConventions = this.deps.repo.listConventions(projectId);
    const approvedByDescription = new Map(priorConventions.filter((c) => c.approval !== "inferred").map((c) => [c.description, c]));
    const merged = generated.conventions.map((c) => {
      const prior = approvedByDescription.get(c.description);
      return prior ? { ...c, id: prior.id, approval: prior.approval, firstObservedAt: prior.firstObservedAt } : c;
    });
    // Approved conventions whose evidence vanished stay, marked possibly_stale.
    for (const prior of priorConventions) {
      if (prior.approval === "approved" && !merged.some((c) => c.id === prior.id)) {
        merged.push({ ...prior, freshness: "possibly_stale", lastConfirmedAt: prior.lastConfirmedAt });
      }
    }
    this.deps.repo.replaceItems(projectId, "convention", merged);
    this.deps.repo.replaceItems(projectId, "command", generated.architecture.commands);
    this.deps.repo.replaceItems(projectId, "uncertainty", generated.uncertainties);

    return this.get(projectId);
  }

  /** The full canonical aggregate. Never invents; missing intelligence is an error. */
  get(projectId: string): ProjectIntelligence {
    const header = this.deps.repo.getHeader(projectId);
    if (!header) throw new CortexError("No project intelligence yet — run a Cortex mapping first", "not_found");
    return {
      projectId,
      repositoryFingerprint: header.repositoryFingerprint,
      architecture: header.architecture,
      conventions: this.deps.repo.listConventions(projectId),
      commands: this.deps.repo.listCommands(projectId),
      decisions: this.deps.repo.listDecisions(projectId),
      risks: this.deps.repo.listRisks(projectId),
      relationships: this.deps.repo.listRelationships(projectId),
      missionLearnings: this.deps.repo.listLearnings(projectId),
      userRules: this.deps.repo.listRules(projectId),
      uncertainties: this.deps.repo.listUncertainties(projectId),
      generatedAt: header.generatedAt,
      refreshedAt: header.refreshedAt,
      schemaVersion: PROJECT_INTELLIGENCE_SCHEMA_VERSION,
    };
  }

  has(projectId: string): boolean {
    return this.deps.repo.getHeader(projectId) !== undefined;
  }

  /**
   * Staleness check: recompute scoped fingerprints and compare with stored
   * ones. Changed scopes mark the affected knowledge possibly_stale (items)
   * and the architecture map itself when a structural scope moved. Unrelated
   * changes invalidate nothing.
   */
  detectStaleness(projectId: string): { changedScopes: string[]; itemsMarked: number; architectureStale: boolean } {
    const header = this.deps.repo.getHeader(projectId);
    if (!header) throw new CortexError("No project intelligence yet", "not_found");
    const ws = this.workspace(projectId);
    const current = computeScopeFingerprints(ws);
    const changed = diffScopes(header.architecture.scopeFingerprints, current);

    let itemsMarked = 0;
    let architectureStale = false;
    for (const scope of changed) {
      const rule = SCOPE_INVALIDATIONS[scope];
      if (!rule) continue;
      if (rule.architecture) architectureStale = true;
      if (rule.kinds.length > 0) {
        itemsMarked += this.deps.repo.setFreshnessByScope(projectId, ".", "possibly_stale", rule.kinds);
      }
    }
    if (architectureStale && header.architecture.freshness === "current") {
      const arch: ArchitectureMap = { ...header.architecture, freshness: "possibly_stale" };
      this.deps.repo.upsertHeader(projectId, header.repositoryFingerprint, arch, header.generatedAt, header.refreshedAt);
    }
    return { changedScopes: changed, itemsMarked, architectureStale };
  }

  /**
   * Incremental refresh: regenerate deterministic knowledge and restore
   * `current` freshness. Because deterministic mapping is cheap and derives
   * only from architecture-critical files, a scoped refresh regenerates the
   * map but preserves durable knowledge (learnings/decisions/rules) exactly
   * like build(); items whose supporting scope changed get re-derived.
   */
  refresh(projectId: string): ProjectIntelligence {
    return this.build(projectId);
  }

  /** Forget deterministic + learned knowledge (rules and decisions survive unless full). */
  forget(projectId: string, options: { includeDurable?: boolean } = {}): void {
    this.deps.repo.deleteAllItems(projectId);
    if (options.includeDurable) {
      for (const d of this.deps.repo.listDecisions(projectId)) this.deps.repo.setDecisionStatus(projectId, d.id, "obsolete");
      for (const r of this.deps.repo.listRules(projectId)) this.deps.repo.deleteRule(projectId, r.id);
    }
  }

  // ── conventions ────────────────────────────────────────────────────────────
  approveConvention(projectId: string, conventionId: string): RepositoryConvention {
    return this.patchConvention(projectId, conventionId, "approved");
  }
  rejectConvention(projectId: string, conventionId: string): RepositoryConvention {
    return this.patchConvention(projectId, conventionId, "rejected");
  }
  private patchConvention(projectId: string, conventionId: string, approval: "approved" | "rejected"): RepositoryConvention {
    const convention = this.deps.repo.listConventions(projectId).find((c) => c.id === conventionId || c.id.startsWith(conventionId));
    if (!convention) throw new CortexError(`Convention ${conventionId} not found`, "not_found");
    this.deps.repo.setConventionApproval(convention.id, approval);
    return { ...convention, approval };
  }

  // ── user rules ─────────────────────────────────────────────────────────────
  addRule(projectId: string, input: CreateProjectRuleInput): ProjectRule {
    const rule: ProjectRule = {
      id: `rule-${randomUUID()}`,
      text: input.text,
      scope: input.scope ?? ".",
      active: true,
      createdAt: this.now(),
    };
    this.deps.repo.addRule(projectId, rule);
    return rule;
  }
  removeRule(projectId: string, ruleId: string): void {
    const rule = this.deps.repo.listRules(projectId).find((r) => r.id === ruleId || r.id.startsWith(ruleId));
    if (!rule) throw new CortexError(`Rule ${ruleId} not found`, "not_found");
    this.deps.repo.deleteRule(projectId, rule.id);
  }

  // ── decision ledger ────────────────────────────────────────────────────────
  recordDecision(projectId: string, input: {
    statement: string; context?: string; alternatives?: string[]; consequences?: string[];
    affectedComponents?: string[]; missionId?: string | null;
    sources?: ArchitectureDecision["sources"]; supersedes?: string;
  }): ArchitectureDecision {
    const decision: ArchitectureDecision = {
      id: `dec-${randomUUID()}`,
      label: this.deps.repo.nextDecisionLabel(projectId),
      statement: input.statement,
      context: input.context ?? "",
      alternatives: input.alternatives ?? [],
      consequences: input.consequences ?? [],
      affectedComponents: input.affectedComponents ?? [],
      sources: input.sources ?? [],
      missionId: input.missionId ?? null,
      status: "accepted",
      supersededBy: null,
      freshness: "current",
      createdAt: this.now(),
    };
    this.deps.repo.addDecision(projectId, decision);
    if (input.supersedes) {
      const old = this.deps.repo.getDecision(projectId, input.supersedes);
      if (old) this.deps.repo.setDecisionStatus(projectId, old.id, "superseded", decision.id);
    }
    return decision;
  }

  // ── mission learnings ──────────────────────────────────────────────────────
  addLearnings(projectId: string, learnings: MissionLearning[]): MissionLearning[] {
    for (const learning of learnings) {
      if (learning.sources.length === 0) {
        throw new CortexError("A learning without supporting evidence cannot become project memory", "validation");
      }
      this.deps.repo.addItem(projectId, "learning", learning);
    }
    return learnings;
  }

  // ── impact analysis persistence ────────────────────────────────────────────
  recordImpactAnalysis(analysis: ChangeImpactAnalysis): ChangeImpactAnalysis {
    this.deps.repo.addImpactAnalysis(analysis);
    return analysis;
  }
  listImpactAnalyses(missionId: string): ChangeImpactAnalysis[] {
    return this.deps.repo.listImpactAnalyses(missionId);
  }

  // ── bounded plan revisions ─────────────────────────────────────────────────
  recordPlanRevision(missionId: string, input: {
    trigger: PlanRevisionTrigger; triggerDetail?: string; invalidatedAssumption?: string | null;
    tasksRemoved?: string[]; tasksAdded?: string[]; dependenciesChanged?: string[];
    verificationChanges?: string[]; budgetImpact?: string | null;
  }): PlanRevision {
    const existing = this.deps.repo.listPlanRevisions(missionId);
    if (existing.length >= MAX_PLAN_REVISIONS) {
      throw new CortexError(`Plan revision limit reached (${MAX_PLAN_REVISIONS}); the mission must complete, block, or be re-scoped by a human`, "limit");
    }
    const revision: PlanRevision = {
      id: `rev-${randomUUID()}`,
      missionId,
      revision: existing.length + 1,
      trigger: input.trigger,
      triggerDetail: input.triggerDetail ?? "",
      invalidatedAssumption: input.invalidatedAssumption ?? null,
      tasksRemoved: input.tasksRemoved ?? [],
      tasksAdded: input.tasksAdded ?? [],
      dependenciesChanged: input.dependenciesChanged ?? [],
      verificationChanges: input.verificationChanges ?? [],
      budgetImpact: input.budgetImpact ?? null,
      createdAt: this.now(),
    };
    this.deps.repo.addPlanRevision(revision);
    return revision;
  }
  listPlanRevisions(missionId: string): PlanRevision[] {
    return this.deps.repo.listPlanRevisions(missionId);
  }

  /** Convenience for status rendering: freshness census across all items. */
  freshnessSummary(projectId: string): Record<IntelligenceFreshness, number> {
    const intelligence = this.get(projectId);
    const summary: Record<IntelligenceFreshness, number> = { current: 0, possibly_stale: 0, stale: 0, invalidated: 0 };
    const all = [
      ...intelligence.conventions, ...intelligence.commands.map((c) => ({ freshness: "current" as const, ...c })),
      ...intelligence.risks, ...intelligence.relationships, ...intelligence.missionLearnings,
    ];
    for (const item of all) {
      const f = (item as { freshness?: IntelligenceFreshness }).freshness ?? "current";
      summary[f]++;
    }
    summary[intelligence.architecture.freshness]++;
    return summary;
  }
}
