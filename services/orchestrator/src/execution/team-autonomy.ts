/**
 * Team autonomy: one grant that lets Morrow run its team unattended.
 *
 * WHY THIS EXISTS
 * Standing trust was stored per caller/target pair, so letting a team of N
 * teammates work freely meant granting N x (N-1) separate permissions, and the
 * built-in Morrow assistant was excluded from holding any of them at all. The
 * practical result was that Morrow — the orchestrator — had to stop and ask the
 * user to approve every single hand-off, which makes walking away impossible.
 *
 * This is deliberately NOT a way to become permissive. It is one explicit,
 * bounded, revocable decision that replaces the same decision repeated dozens of
 * times. Every delegation is still recorded, still shows in the activity log,
 * and the grant can be withdrawn mid-run.
 *
 * The bounds are the part that makes "walk away" safe, so they are only ever
 * things Morrow can actually measure:
 *
 *   maxDepth      how many hand-offs deep a chain may go
 *   maxChildren   how many workers one task may start
 *   maxTotalTokens  total tokens across the whole run
 *
 * Dollars are deliberately absent. Morrow does not meter cost — no provider
 * reports one and there is no price table — so a spend limit would be a number
 * that never fires. Tokens are what is actually counted, so tokens are what is
 * actually enforced.
 *
 * Stored in the existing `settings` key/value table, following the same pattern
 * as mcp/trust.ts, so this needs no migration.
 */
import type Database from "better-sqlite3";

export interface TeamAutonomyGrant {
  /** How many hand-offs deep a delegation chain may go. */
  maxDepth: number;
  /** How many workers a single task may start. */
  maxChildren: number;
  /** Total tokens across the run before autonomy stops and asks. */
  maxTotalTokens: number;
  /** When the user turned this on. */
  grantedAt: string;
}

/** Conservative enough to walk away from, generous enough to finish real work. */
export const TEAM_AUTONOMY_DEFAULTS: Omit<TeamAutonomyGrant, "grantedAt"> = {
  maxDepth: 3,
  maxChildren: 5,
  maxTotalTokens: 2_000_000,
};

const key = (projectId: string) => `team.autonomy.${projectId}`;

function coerce(value: unknown): TeamAutonomyGrant | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const num = (field: unknown, fallback: number): number => {
    const n = typeof field === "number" ? field : Number(field);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    maxDepth: num(raw.maxDepth, TEAM_AUTONOMY_DEFAULTS.maxDepth),
    maxChildren: num(raw.maxChildren, TEAM_AUTONOMY_DEFAULTS.maxChildren),
    maxTotalTokens: num(raw.maxTotalTokens, TEAM_AUTONOMY_DEFAULTS.maxTotalTokens),
    grantedAt: typeof raw.grantedAt === "string" ? raw.grantedAt : new Date(0).toISOString(),
  };
}

export function teamAutonomyStore(db: Database.Database) {
  return {
    /** The live grant for a project, or null when the user has not turned it on. */
    get(projectId: string): TeamAutonomyGrant | null {
      const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key(projectId)) as
        | { value: string }
        | undefined;
      if (!row) return null;
      try {
        return coerce(JSON.parse(row.value));
      } catch {
        // A corrupted record must read as "not granted". Failing closed is the
        // only safe direction for a permission.
        return null;
      }
    },

    grant(
      projectId: string,
      limits: { maxDepth?: number | undefined; maxChildren?: number | undefined; maxTotalTokens?: number | undefined } = {},
    ): TeamAutonomyGrant {
      const record: TeamAutonomyGrant = {
        ...TEAM_AUTONOMY_DEFAULTS,
        ...Object.fromEntries(Object.entries(limits).filter(([, v]) => typeof v === "number" && Number.isFinite(v) && v > 0)),
        grantedAt: new Date().toISOString(),
      };
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key(projectId), JSON.stringify(record));
      return record;
    },

    revoke(projectId: string): boolean {
      return db.prepare("DELETE FROM settings WHERE key = ?").run(key(projectId)).changes > 0;
    },
  };
}

export type TeamAutonomyStore = ReturnType<typeof teamAutonomyStore>;

/**
 * Total tokens spent by a task and everything it delegated to.
 *
 * Usage is emitted per provider response as a `provider.usage` task event, so
 * the run's true cost in tokens is the sum over the whole tree — counting only
 * the root task would let a runaway fan-out spend without ever moving the
 * number the cap is checked against.
 */
export function tokensUsedInTaskTree(db: Database.Database, rootTaskId: string): number {
  const rows = db
    .prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT id FROM tasks WHERE id = ?
         UNION
         SELECT t.id FROM tasks t JOIN tree ON t.parent_task_id = tree.id
       )
       SELECT e.payload_json AS payload
         FROM task_events e
         JOIN tree ON e.task_id = tree.id
        WHERE e.type = 'provider.usage'`,
    )
    .all(rootTaskId) as Array<{ payload: string }>;

  let total = 0;
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.payload) as Record<string, unknown>;
      const tokens = payload.totalTokens;
      if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) total += tokens;
    } catch {
      // An unparseable event contributes nothing rather than aborting the count.
    }
  }
  return total;
}
