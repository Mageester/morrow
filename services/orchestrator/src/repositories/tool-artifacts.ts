import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { redactSecrets } from "../provider/credentials.js";

/**
 * Artifact-backed externalization for oversized tool results.
 *
 * When a tool result exceeds the inline byte limit, the agent stores the
 * complete content in `tool_artifacts` (durable, hash-indexed for dedup) and
 * references it by id in the next provider request. The agent no longer
 * inlines a 24 KB head/tail fragment into every future turn; instead the
 * model sees a small metadata ref and can request targeted range retrieval.
 *
 * Security: tool output crosses this repository boundary before it can become
 * durable or be returned by `read_artifact`. Text and JSON are sanitized here
 * so callers cannot accidentally bypass the privacy boundary; reads sanitize
 * legacy rows written before this guard existed.
 */

export interface ToolArtifactRow {
  id: string;
  taskId: string | null;
  toolName: string;
  kind: string;
  contentType: string;
  bytes: number;
  contentHash: string;
  summary: string;
  excerpt: string;
  refcount: number;
  createdAt: string;
}

export interface CreateArtifactInput {
  taskId: string | null;
  toolName: string;
  kind: string;
  contentType?: string;
  content: string | Buffer;
  /** Caller-supplied short summary; generated from excerpt if absent. */
  summary?: string;
}

interface PersistedRow {
  id: string;
  task_id: string | null;
  tool_name: string;
  kind: string;
  content_type: string;
  bytes: number;
  content_hash: string;
  summary: string;
  excerpt: string;
  refcount: number;
  created_at: string;
}

function rowToArtifact(row: PersistedRow): ToolArtifactRow {
  return {
    id: row.id,
    taskId: row.task_id,
    toolName: row.tool_name,
    kind: row.kind,
    contentType: row.content_type,
    bytes: row.bytes,
    contentHash: row.content_hash,
    summary: redactSecrets(row.summary),
    excerpt: redactSecrets(row.excerpt),
    refcount: row.refcount,
    createdAt: row.created_at,
  };
}

function sanitizeContent(content: Buffer, contentType: string): Buffer {
  // Artifact callers currently store text/plain and application/json. Keep
  // opaque binary artifacts byte-for-byte intact while protecting every text
  // representation that can be shown to a model or operator.
  const textual = contentType.startsWith("text/") || /(?:json|javascript|xml|yaml|csv|sql)/i.test(contentType);
  return textual ? Buffer.from(redactSecrets(content.toString("utf8")), "utf8") : content;
}

function makeExcerpt(content: string, maxChars = 480): string {
  if (content.length <= maxChars) return content;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${content.slice(0, head)}\n…\n${content.slice(content.length - tail)}`;
}

export interface ToolArtifactRepository {
  create(input: CreateArtifactInput, now?: string): ToolArtifactRow;
  /** Increment the refcount and return the new value; idempotent semantics. */
  incrementRefcount(id: string): number;
  get(id: string): ToolArtifactRow | null;
  /** Read the stored blob verbatim. Range retrieval is on the caller. */
  getContent(id: string): Buffer | null;
  findByHashAndKindAndContentType(contentHash: string, kind: string, contentType: string): ToolArtifactRow | null;
}

export function toolArtifactsRepository(db: Database.Database): ToolArtifactRepository {
  const recordTaskReference = (artifactId: string, taskId: string | null, createdAt: string): void => {
    if (!taskId) return;
    // The mapping has a task FK, while tool_artifacts.task_id predates that
    // constraint and still accepts legacy/synthetic callers. Only create an
    // ownership edge when the producing task is durable.
    const taskExists = db.prepare("SELECT 1 FROM tasks WHERE id=?").get(taskId);
    if (!taskExists) return;
    db.prepare(`INSERT INTO tool_artifact_task_refs(artifact_id,task_id,created_at)
      VALUES(?,?,?) ON CONFLICT(artifact_id,task_id) DO NOTHING`).run(artifactId, taskId, createdAt);
  };

  return {
    create(input, now) {
      const createdAt = now ?? new Date().toISOString();
      const contentType = input.contentType ?? "text/plain";
      const rawBuffer = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content, "utf8");
      const buffer = sanitizeContent(rawBuffer, contentType);
      const contentHash = createHash("sha256").update(buffer).digest("hex");
      // Dedup by (hash, kind, contentType) — same exact bytes already stored.
      const existing = db
        .prepare("SELECT * FROM tool_artifacts WHERE content_hash = ? AND kind = ? AND content_type = ? ORDER BY created_at ASC LIMIT 1")
        .get(contentHash, input.kind, contentType) as PersistedRow | undefined;
      if (existing) {
        db.prepare("UPDATE tool_artifacts SET refcount = refcount + 1 WHERE id = ?").run(existing.id);
        recordTaskReference(existing.id, input.taskId, createdAt);
        const updated = db.prepare("SELECT * FROM tool_artifacts WHERE id = ?").get(existing.id) as PersistedRow;
        return rowToArtifact(updated);
      }
      const id = randomUUID();
      const text = buffer.toString("utf8");
      const excerpt = makeExcerpt(text);
      const summary = redactSecrets(input.summary?.trim() || excerpt.split(/\n/, 1)[0]!.slice(0, 160));
      // A newly created artifact has been referenced by the caller exactly
      // once. refcount starts at 1 so `get(id).refcount === 1` immediately
      // after `create()`, and dedup hits become >= 2.
      db.prepare(`INSERT INTO tool_artifacts (id, task_id, tool_name, kind, content_type, bytes, content_hash, summary, excerpt, content, refcount, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,?)`).run(
        id,
        input.taskId,
        input.toolName,
        input.kind,
        contentType,
        buffer.byteLength,
        contentHash,
        summary,
        excerpt,
        buffer,
        createdAt
      );
      recordTaskReference(id, input.taskId, createdAt);
      const inserted = db.prepare("SELECT * FROM tool_artifacts WHERE id = ?").get(id) as PersistedRow;
      return rowToArtifact(inserted);
    },
    incrementRefcount(id) {
      db.prepare("UPDATE tool_artifacts SET refcount = refcount + 1 WHERE id = ?").run(id);
      const row = db.prepare("SELECT refcount FROM tool_artifacts WHERE id = ?").get(id) as { refcount: number } | undefined;
      return row?.refcount ?? 0;
    },
    get(id) {
      const row = db.prepare("SELECT * FROM tool_artifacts WHERE id = ?").get(id) as PersistedRow | undefined;
      return row ? rowToArtifact(row) : null;
    },
    getContent(id) {
      const row = db.prepare("SELECT content, content_type FROM tool_artifacts WHERE id = ?").get(id) as { content: Buffer; content_type: string } | undefined;
      return row ? sanitizeContent(row.content, row.content_type) : null;
    },
    findByHashAndKindAndContentType(contentHash, kind, contentType) {
      const row = db
        .prepare("SELECT * FROM tool_artifacts WHERE content_hash = ? AND kind = ? AND content_type = ? ORDER BY created_at ASC LIMIT 1")
        .get(contentHash, kind, contentType) as PersistedRow | undefined;
      return row ? rowToArtifact(row) : null;
    },
  };
}
