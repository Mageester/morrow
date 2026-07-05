import type Database from "better-sqlite3";
import type {
  ArchitectureMap, RepositoryConvention, RepositoryCommand, ProjectRisk,
  CodeRelationship, MissionLearning, IntelligenceUncertainty, ProjectRule,
  ArchitectureDecision, DecisionStatus, IntelligenceFreshness, PlanRevision,
  ChangeImpactAnalysis, ConventionApproval,
} from "@morrow/contracts";
import { PROJECT_INTELLIGENCE_SCHEMA_VERSION } from "@morrow/contracts";

/**
 * Persistence for Morrow Cortex. Items are stored individually (not as one
 * blob) so approval, freshness, and scoped invalidation update single rows,
 * and concurrent writers never clobber unrelated knowledge.
 */

export type IntelligenceItemKind = "convention" | "command" | "risk" | "relationship" | "learning" | "uncertainty";

interface ItemRow {
  id: string; project_id: string; kind: string; payload_json: string;
  approval: string | null; freshness: string; scope: string;
  created_at: string; updated_at: string;
}

export interface IntelligenceHeader {
  projectId: string;
  schemaVersion: number;
  repositoryFingerprint: string;
  architecture: ArchitectureMap;
  generatedAt: string;
  refreshedAt: string;
}

export function intelligenceRepository(db: Database.Database) {
  const parse = <T>(row: ItemRow): T => {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    // The row's lifecycle columns are authoritative over the stored payload —
    // but only for kinds whose contract carries them (commands and
    // uncertainties have no freshness/approval fields).
    if ("freshness" in payload) payload.freshness = row.freshness;
    if (row.approval !== null && "approval" in payload) payload.approval = row.approval;
    return payload as T;
  };

  const listItems = <T>(projectId: string, kind: IntelligenceItemKind): T[] =>
    (db.prepare("SELECT * FROM intelligence_items WHERE project_id=? AND kind=? ORDER BY created_at ASC,id ASC")
      .all(projectId, kind) as ItemRow[]).map((r) => parse<T>(r));

  return {
    // ── header (fingerprint + architecture map) ────────────────────────────
    getHeader(projectId: string): IntelligenceHeader | undefined {
      const row = db.prepare("SELECT * FROM project_intelligence WHERE project_id=?").get(projectId) as
        | { project_id: string; schema_version: number; repository_fingerprint: string; architecture_json: string; generated_at: string; refreshed_at: string }
        | undefined;
      if (!row) return undefined;
      return {
        projectId: row.project_id,
        schemaVersion: row.schema_version,
        repositoryFingerprint: row.repository_fingerprint,
        architecture: JSON.parse(row.architecture_json) as ArchitectureMap,
        generatedAt: row.generated_at,
        refreshedAt: row.refreshed_at,
      };
    },
    upsertHeader(projectId: string, fingerprint: string, architecture: ArchitectureMap, generatedAt: string, refreshedAt: string): void {
      db.prepare(`INSERT INTO project_intelligence(project_id,schema_version,repository_fingerprint,architecture_json,generated_at,refreshed_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(project_id) DO UPDATE SET repository_fingerprint=excluded.repository_fingerprint,
          architecture_json=excluded.architecture_json, refreshed_at=excluded.refreshed_at`)
        .run(projectId, PROJECT_INTELLIGENCE_SCHEMA_VERSION, fingerprint, JSON.stringify(architecture), generatedAt, refreshedAt);
    },

    // ── generic items ──────────────────────────────────────────────────────
    addItem(projectId: string, kind: IntelligenceItemKind, item: { id: string; scope?: string; freshness?: string; approval?: string; createdAt?: string }): void {
      const now = new Date().toISOString();
      db.prepare("INSERT INTO intelligence_items(id,project_id,kind,payload_json,approval,freshness,scope,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(item.id, projectId, kind, JSON.stringify(item), (item as { approval?: string }).approval ?? null,
          item.freshness ?? "current", item.scope ?? ".", item.createdAt ?? now, now);
    },
    replaceItems(projectId: string, kind: IntelligenceItemKind, items: Array<{ id: string; scope?: string; freshness?: string; approval?: string; createdAt?: string }>): void {
      const tx = db.transaction(() => {
        db.prepare("DELETE FROM intelligence_items WHERE project_id=? AND kind=?").run(projectId, kind);
        for (const item of items) this.addItem(projectId, kind, item);
      });
      tx();
    },
    getItemRow(id: string): { kind: string; projectId: string } | undefined {
      const r = db.prepare("SELECT kind, project_id FROM intelligence_items WHERE id=?").get(id) as { kind: string; project_id: string } | undefined;
      return r ? { kind: r.kind, projectId: r.project_id } : undefined;
    },
    updateItemPayload(id: string, payload: Record<string, unknown>): void {
      db.prepare("UPDATE intelligence_items SET payload_json=?, updated_at=? WHERE id=?")
        .run(JSON.stringify(payload), new Date().toISOString(), id);
    },
    setItemFreshness(id: string, freshness: IntelligenceFreshness): void {
      db.prepare("UPDATE intelligence_items SET freshness=?, updated_at=? WHERE id=?").run(freshness, new Date().toISOString(), id);
    },
    setFreshnessByScope(projectId: string, scopePrefix: string, freshness: IntelligenceFreshness, kinds?: IntelligenceItemKind[]): number {
      const kindFilter = kinds && kinds.length > 0 ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
      const r = db.prepare(`UPDATE intelligence_items SET freshness=?, updated_at=? WHERE project_id=? AND (scope=? OR scope LIKE ?)${kindFilter}`)
        .run(freshness, new Date().toISOString(), projectId, scopePrefix, `${scopePrefix}/%`, ...(kinds ?? []));
      return r.changes;
    },
    setConventionApproval(id: string, approval: ConventionApproval): boolean {
      const r = db.prepare("UPDATE intelligence_items SET approval=?, updated_at=? WHERE id=? AND kind='convention'")
        .run(approval, new Date().toISOString(), id);
      return r.changes > 0;
    },
    deleteItem(id: string): boolean {
      return db.prepare("DELETE FROM intelligence_items WHERE id=?").run(id).changes > 0;
    },
    deleteAllItems(projectId: string, kind?: IntelligenceItemKind): number {
      if (kind) return db.prepare("DELETE FROM intelligence_items WHERE project_id=? AND kind=?").run(projectId, kind).changes;
      return db.prepare("DELETE FROM intelligence_items WHERE project_id=?").run(projectId).changes;
    },

    listConventions: (projectId: string) => listItems<RepositoryConvention>(projectId, "convention"),
    listCommands: (projectId: string) => listItems<RepositoryCommand>(projectId, "command"),
    listRisks: (projectId: string) => listItems<ProjectRisk>(projectId, "risk"),
    listRelationships: (projectId: string) => listItems<CodeRelationship>(projectId, "relationship"),
    listLearnings: (projectId: string) => listItems<MissionLearning>(projectId, "learning"),
    listUncertainties: (projectId: string) => listItems<IntelligenceUncertainty>(projectId, "uncertainty"),

    // ── decisions ──────────────────────────────────────────────────────────
    addDecision(projectId: string, decision: ArchitectureDecision): void {
      db.prepare("INSERT INTO architecture_decisions(id,project_id,label,payload_json,status,created_at) VALUES(?,?,?,?,?,?)")
        .run(decision.id, projectId, decision.label, JSON.stringify(decision), decision.status, decision.createdAt);
    },
    getDecision(projectId: string, idOrLabel: string): ArchitectureDecision | undefined {
      const row = db.prepare("SELECT payload_json,status FROM architecture_decisions WHERE project_id=? AND (id=? OR label=?)")
        .get(projectId, idOrLabel, idOrLabel) as { payload_json: string; status: string } | undefined;
      if (!row) return undefined;
      const d = JSON.parse(row.payload_json) as ArchitectureDecision;
      d.status = row.status as DecisionStatus;
      return d;
    },
    listDecisions(projectId: string): ArchitectureDecision[] {
      return (db.prepare("SELECT payload_json,status FROM architecture_decisions WHERE project_id=? ORDER BY created_at ASC,id ASC")
        .all(projectId) as Array<{ payload_json: string; status: string }>).map((r) => {
          const d = JSON.parse(r.payload_json) as ArchitectureDecision;
          d.status = r.status as DecisionStatus;
          return d;
        });
    },
    nextDecisionLabel(projectId: string): string {
      const n = (db.prepare("SELECT COUNT(*) c FROM architecture_decisions WHERE project_id=?").get(projectId) as { c: number }).c;
      return `D-${String(n + 1).padStart(3, "0")}`;
    },
    setDecisionStatus(projectId: string, id: string, status: DecisionStatus, supersededBy?: string | null): boolean {
      const existing = this.getDecision(projectId, id);
      if (!existing) return false;
      const updated: ArchitectureDecision = { ...existing, status, supersededBy: supersededBy ?? existing.supersededBy };
      return db.prepare("UPDATE architecture_decisions SET payload_json=?, status=? WHERE project_id=? AND id=?")
        .run(JSON.stringify(updated), status, projectId, existing.id).changes > 0;
    },

    // ── user rules ─────────────────────────────────────────────────────────
    addRule(projectId: string, rule: ProjectRule): void {
      db.prepare("INSERT INTO project_rules(id,project_id,text,scope,active,created_at) VALUES(?,?,?,?,?,?)")
        .run(rule.id, projectId, rule.text, rule.scope, rule.active ? 1 : 0, rule.createdAt);
    },
    listRules(projectId: string, activeOnly = false): ProjectRule[] {
      const rows = db.prepare(`SELECT * FROM project_rules WHERE project_id=?${activeOnly ? " AND active=1" : ""} ORDER BY created_at ASC,id ASC`)
        .all(projectId) as Array<{ id: string; text: string; scope: string; active: number; created_at: string }>;
      return rows.map((r) => ({ id: r.id, text: r.text, scope: r.scope, active: r.active === 1, createdAt: r.created_at }));
    },
    deleteRule(projectId: string, id: string): boolean {
      return db.prepare("DELETE FROM project_rules WHERE project_id=? AND id=?").run(projectId, id).changes > 0;
    },

    // ── plan revisions ─────────────────────────────────────────────────────
    addPlanRevision(revision: PlanRevision): void {
      db.prepare("INSERT INTO mission_plan_revisions(id,mission_id,revision,payload_json,created_at) VALUES(?,?,?,?,?)")
        .run(revision.id, revision.missionId, revision.revision, JSON.stringify(revision), revision.createdAt);
    },
    listPlanRevisions(missionId: string): PlanRevision[] {
      return (db.prepare("SELECT payload_json FROM mission_plan_revisions WHERE mission_id=? ORDER BY revision ASC")
        .all(missionId) as Array<{ payload_json: string }>).map((r) => JSON.parse(r.payload_json) as PlanRevision);
    },

    // ── impact analyses ────────────────────────────────────────────────────
    addImpactAnalysis(analysis: ChangeImpactAnalysis): void {
      db.prepare("INSERT INTO mission_impact_analyses(id,mission_id,payload_json,created_at) VALUES(?,?,?,?)")
        .run(analysis.id, analysis.missionId, JSON.stringify(analysis), analysis.createdAt);
    },
    listImpactAnalyses(missionId: string): ChangeImpactAnalysis[] {
      return (db.prepare("SELECT payload_json FROM mission_impact_analyses WHERE mission_id=? ORDER BY created_at ASC")
        .all(missionId) as Array<{ payload_json: string }>).map((r) => JSON.parse(r.payload_json) as ChangeImpactAnalysis);
    },
  };
}

export type IntelligenceRepository = ReturnType<typeof intelligenceRepository>;
