import type Database from "better-sqlite3";
import { TeammateTrustGrantSchema, type TeammateTrustGrant } from "@morrow/contracts";

function mapGrant(row: Record<string, unknown>): TeammateTrustGrant {
  return TeammateTrustGrantSchema.parse({
    version: 1,
    id: row.id,
    projectId: row.project_id,
    callerAgentId: row.caller_agent_id ?? null,
    targetAgentId: row.target_agent_id,
    targetProfileHash: row.target_profile_hash,
    maxDepth: Number(row.max_depth),
    maxChildren: Number(row.max_children),
    createdAt: row.created_at,
    revokedAt: row.revoked_at ?? null,
  });
}

export interface CreateTeammateTrustGrantRow {
  id: string;
  projectId: string;
  callerAgentId: string | null;
  targetAgentId: string;
  targetProfileHash: string;
  maxDepth: number;
  maxChildren: number;
  createdAt: string;
}

export function teammateTrustRepository(db: Database.Database) {
  return {
    /**
     * Record a grant. Re-granting the same pair supersedes the live row rather
     * than stacking a second one, so "what is permitted" always has exactly one
     * answer per pair and a re-grant after a profile change is the natural way
     * to re-bind a drifted fingerprint.
     */
    grant(input: CreateTeammateTrustGrantRow): TeammateTrustGrant {
      const revokeExisting = input.callerAgentId === null
        ? db.prepare(
          "UPDATE teammate_trust_grants SET revoked_at=? WHERE project_id=? AND target_agent_id=? AND caller_agent_id IS NULL AND revoked_at IS NULL",
        )
        : db.prepare(
          "UPDATE teammate_trust_grants SET revoked_at=? WHERE project_id=? AND target_agent_id=? AND caller_agent_id=? AND revoked_at IS NULL",
        );
      const write = db.transaction(() => {
        if (input.callerAgentId === null) {
          revokeExisting.run(input.createdAt, input.projectId, input.targetAgentId);
        } else {
          revokeExisting.run(input.createdAt, input.projectId, input.targetAgentId, input.callerAgentId);
        }
        db.prepare(
          `INSERT INTO teammate_trust_grants
             (id, schema_version, project_id, caller_agent_id, target_agent_id,
              target_profile_hash, max_depth, max_children, created_at, revoked_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        ).run(
          input.id, input.projectId, input.callerAgentId, input.targetAgentId,
          input.targetProfileHash, input.maxDepth, input.maxChildren, input.createdAt,
        );
      });
      write();
      return mapGrant(db.prepare("SELECT * FROM teammate_trust_grants WHERE id=?").get(input.id) as Record<string, unknown>);
    },

    /**
     * The live grant that permits `caller` to ask `target`, if one exists.
     *
     * A grant naming this exact caller wins over a project-wide grant, so a
     * narrower decision is never silently widened by a broader one that was
     * made earlier. The profile hash is deliberately NOT matched here: the
     * caller compares it and reports drift as a distinct outcome, because
     * "you never granted this" and "the teammate changed since you granted"
     * are different answers and only the second should re-prompt.
     */
    find(projectId: string, callerAgentId: string, targetAgentId: string): TeammateTrustGrant | undefined {
      const row = db.prepare(
        `SELECT * FROM teammate_trust_grants
          WHERE project_id=? AND target_agent_id=? AND revoked_at IS NULL
            AND (caller_agent_id=? OR caller_agent_id IS NULL)
          ORDER BY caller_agent_id IS NULL
          LIMIT 1`,
      ).get(projectId, targetAgentId, callerAgentId) as Record<string, unknown> | undefined;
      return row ? mapGrant(row) : undefined;
    },

    listForProject(projectId: string): TeammateTrustGrant[] {
      const rows = db.prepare(
        "SELECT * FROM teammate_trust_grants WHERE project_id=? AND revoked_at IS NULL ORDER BY created_at",
      ).all(projectId) as Array<Record<string, unknown>>;
      return rows.map(mapGrant);
    },

    revoke(projectId: string, id: string, revokedAt: string): boolean {
      const result = db.prepare(
        "UPDATE teammate_trust_grants SET revoked_at=? WHERE id=? AND project_id=? AND revoked_at IS NULL",
      ).run(revokedAt, id, projectId);
      return result.changes > 0;
    },
  };
}
