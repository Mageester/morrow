import type { ToolArtifactRepository } from "../repositories/tool-artifacts.js";
import { redactSecrets } from "../provider/credentials.js";

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
 * Text is sanitized before the inline/artifact split, and the repository
 * repeats that protection at its durable boundary for direct callers and
 * legacy reads.
 */

// A compacted request keeps its most recent tool group. Keeping multiple
// 24 KiB observations inline can still exceed smaller free-route windows,
// even after older history is summarized. Eight KiB keeps enough immediate
// evidence while preserving the complete output in the artifact store.
export const DEFAULT_INLINE_BYTE_LIMIT = 8 * 1024;

/** Largest slice one `read_artifact` call may return to the model. */
export const MAX_ARTIFACT_READ_BYTES = 16 * 1024;

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
  const safeText = redactSecrets(text);
  const bytes = Buffer.byteLength(safeText, "utf8");
  const inlineByteLimit = options.inlineByteLimit ?? DEFAULT_INLINE_BYTE_LIMIT;
  if (bytes <= inlineByteLimit) {
    return { kind: "inline", text: safeText, bytes };
  }
  const artifact = repo.create({
    taskId: options.taskId ?? null,
    toolName: options.toolName,
    kind: options.kind,
    contentType: options.contentType ?? "text/plain",
    content: safeText,
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

/** Every artifact id this run has actually handed to the model. */
export function collectOfferedArtifactIds(renderedToolResults: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const rendered of renderedToolResults) {
    if (!rendered || !rendered.includes("artifactId")) continue;
    for (const match of rendered.matchAll(/"artifactId"\s*:\s*"([^"]+)"/g)) {
      if (match[1]) ids.add(match[1]);
    }
  }
  return ids;
}

export type ArtifactReadResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; error: string };

/**
 * Serve one bounded range of an artifact the model was already given a
 * reference to.
 *
 * `renderExternalizedForContext` tells the model to call `read_artifact`, so
 * the tool has to exist — otherwise a compliant model hits the runtime's
 * `Forbidden tool` branch, which is what produced the observed
 * `Forbidden tool: read_artifact` failures. Adding it grants no new reach:
 * artifacts are Morrow's own already-captured tool output, and `offeredIds`
 * restricts a task to the exact ids it was shown. A task can never enumerate
 * the artifact store or read another task's captured output, and the response
 * is capped so a large artifact cannot be pulled back inline in one call.
 */
export function readArtifactRange(
  repo: Pick<ToolArtifactRepository, "get" | "getContent">,
  offeredIds: ReadonlySet<string>,
  input: { id?: unknown; offset?: unknown; length?: unknown },
): ArtifactReadResult {
  const id = typeof input.id === "string" ? input.id.trim() : "";
  if (!id) return { ok: false, error: "read_artifact requires the string \"id\" of an artifact referenced in an earlier tool result." };
  if (!offeredIds.has(id)) {
    return { ok: false, error: `Artifact ${id} was not referenced in this task's tool results. Only artifact ids Morrow reported back to you can be read.` };
  }
  const row = repo.get(id);
  const content = repo.getContent(id);
  if (!row || !content) return { ok: false, error: `Artifact ${id} is no longer stored.` };

  const rawOffset = typeof input.offset === "number" ? input.offset : 0;
  if (!Number.isFinite(rawOffset) || rawOffset < 0) return { ok: false, error: "\"offset\" must be a non-negative byte offset." };
  const totalBytes = content.byteLength;
  const offset = Math.min(Math.floor(rawOffset), totalBytes);
  const rawLength = typeof input.length === "number" ? input.length : MAX_ARTIFACT_READ_BYTES;
  if (!Number.isFinite(rawLength) || rawLength <= 0) return { ok: false, error: "\"length\" must be a positive byte count." };
  const length = Math.min(Math.floor(rawLength), MAX_ARTIFACT_READ_BYTES);
  const end = Math.min(offset + length, totalBytes);

  return {
    ok: true,
    payload: {
      artifactId: row.id,
      toolName: row.toolName,
      contentType: row.contentType,
      totalBytes,
      offset,
      returnedBytes: end - offset,
      truncated: end < row.bytes,
      ...(end < row.bytes ? { nextOffset: end } : {}),
      content: content.subarray(offset, end).toString("utf8"),
    },
  };
}
