import type Database from "better-sqlite3";
import {
  SearchHitSchema,
  SearchResponseSchema,
  type SearchHit,
  type SearchKind,
  type SearchResponse,
} from "@morrow/contracts";

const ALL_KINDS: SearchKind[] = ["conversation", "message", "task", "memory"];

export interface SearchOptions {
  kinds?: SearchKind[];
  conversationId?: string;
  limit?: number;
}

/**
 * Turn arbitrary user input into a safe FTS5 MATCH expression. We keep only
 * letter/number runs (Unicode-aware), wrap each as a quoted prefix term, and AND
 * them together. This makes the search forgiving (prefix matching) while making
 * it impossible for FTS5 special characters (`"`, `*`, `(`, `:`, `^`, `-`) to
 * trigger a syntax error or column filter the caller did not intend. Returns
 * null when the query carries no searchable tokens.
 */
export function buildMatchQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  return tokens
    .slice(0, 16)
    .map((t) => `"${t.replace(/"/g, '""')}"*`)
    .join(" ");
}

/**
 * Project-scoped full-text search over conversations, messages, tasks, and
 * memory. The `search_index` FTS5 table is maintained by triggers (see
 * migration 10), so reads are always current. Results never cross a project
 * boundary: `project_id` is an enforced filter on every query.
 */
export function searchRepository(db: Database.Database) {
  return {
    search(projectId: string, query: string, opts: SearchOptions = {}): SearchResponse {
      const match = buildMatchQuery(query);
      const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
      const kinds = opts.kinds && opts.kinds.length > 0 ? opts.kinds : ALL_KINDS;

      let hits: SearchHit[] = [];
      if (match) {
        const placeholders = kinds.map(() => "?").join(",");
        const params: unknown[] = [projectId, match, ...kinds];
        let convFilter = "";
        if (opts.conversationId) {
          convFilter = " AND conversation_id = ?";
          params.push(opts.conversationId);
        }
        params.push(limit);

        const rows = db
          .prepare(
            `SELECT kind, ref_id, project_id, conversation_id, title, created_at,
                    snippet(search_index, 5, '[', ']', '…', 12) AS snip,
                    bm25(search_index) AS rank
             FROM search_index
             WHERE project_id = ? AND search_index MATCH ?
               AND kind IN (${placeholders})${convFilter}
             ORDER BY rank ASC, created_at DESC
             LIMIT ?`
          )
          .all(...params) as Array<{
          kind: string;
          ref_id: string;
          project_id: string;
          conversation_id: string | null;
          title: string | null;
          created_at: string;
          snip: string | null;
          rank: number | null;
        }>;

        hits = rows.map((r) =>
          SearchHitSchema.parse({
            kind: r.kind,
            refId: r.ref_id,
            projectId: r.project_id,
            conversationId: r.conversation_id ?? null,
            title: r.title ?? "",
            snippet: r.snip && r.snip.length > 0 ? r.snip : r.title ?? "",
            createdAt: r.created_at,
            score: typeof r.rank === "number" ? r.rank : 0,
          })
        );
      }

      return SearchResponseSchema.parse({
        version: 1,
        query,
        projectId,
        total: hits.length,
        hits,
      });
    },
  };
}
