import type { ToolArtifactRepository } from "../repositories/tool-artifacts.js";

/**
 * Artifact-backed externalization for oversized tool results (§3+§4).
 *
 * The contract:
 * - Inputs at or below `inlineByteLimit` are returned inline as `{kind:"inline", text}`.
 * - Inputs above the limit are stored in the artifact store and the call site
 *   receives `{kind:"artifact", id, …metadata…}` referencing the durable blob.
 *   Full content is never injected into the next provider request — only the
 *   metadata, a small excerpt, and a retrieval hint.
 * - Deduplication is by `(content_hash, kind, contentType)` so identical
 *   artifacts (e.g. the same build log captured twice) share one row and
 *   increment its refcount.
 *
 * No secrets are stripped here. The agent must apply redaction BEFORE this
 * function is called if the content carries credentials. (The artifact store
 * itself is opaque bytes; the agent's redaction layer is upstream.)
 */

// A compacted request keeps its most recent tool group. Keeping multiple
// 24 KiB observations inline can still exceed smaller free-route windows,
// even after older history is summarized. Eight KiB keeps enough immediate
// evidence while preserving the complete output in the artifact store.
export const DEFAULT_INLINE_BYTE_LIMIT = 8 * 1024;

export type ExternalizedToolResult =
  | { kind: "inline"; text: string; bytes: number }
  | {
      kind: "artifact";
      id: string;
      toolName: string;
      contentType: string;
      bytes: number;
      contentHash: string;
      summary: string;
      excerpt: string;
      refcount: number;
      retrieval: { kind: "tool_artifacts.get"; id: string };
    };

export interface ExternalizeOptions {
  toolName: string;
  kind: string;
  contentType?: string;
  inlineByteLimit?: number;
  taskId?: string | null;
  now?: string;
}

export function externalizeToolResult(
  repo: ToolArtifactRepository,
  text: string,
  options: ExternalizeOptions
): ExternalizedToolResult {
  const bytes = Buffer.byteLength(text, "utf8");
  const inlineByteLimit = options.inlineByteLimit ?? DEFAULT_INLINE_BYTE_LIMIT;
  if (bytes <= inlineByteLimit) {
    return { kind: "inline", text, bytes };
  }
  const artifact = repo.create({
    taskId: options.taskId ?? null,
    toolName: options.toolName,
    kind: options.kind,
    contentType: options.contentType ?? "text/plain",
    content: text,
  });
  return {
    kind: "artifact",
    id: artifact.id,
    toolName: artifact.toolName,
    contentType: artifact.contentType,
    bytes: artifact.bytes,
    contentHash: artifact.contentHash,
    summary: artifact.summary,
    excerpt: artifact.excerpt,
    refcount: artifact.refcount,
    retrieval: { kind: "tool_artifacts.get", id: artifact.id },
  };
}

/**
 * Render an externalized result as a JSON-serializable string suitable for
 * embedding in a tool-result message that the model will see on its next
 * turn. The model sees ONLY the metadata + excerpt + retrieval hint — never
 * the full content. This is the new compact output of the agent's
 * `capToolResult` path.
 */
export function renderExternalizedForContext(result: ExternalizedToolResult): string {
  if (result.kind === "inline") return result.text;
  return JSON.stringify({
    truncatedForContext: true,
    artifactId: result.id,
    contentType: result.contentType,
    bytes: result.bytes,
    contentHash: result.contentHash,
    summary: result.summary,
    excerpt: result.excerpt,
    refcount: result.refcount,
    retrieval: result.retrieval,
    hint: `Full content (${result.bytes} bytes) is stored as artifact ${result.id}. Use read_artifact with id=${result.id} (or a byte range) to fetch specific sections; do not request the full payload unless you genuinely need it.`,
  });
}
