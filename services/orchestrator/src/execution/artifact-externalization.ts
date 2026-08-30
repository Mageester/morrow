import type { ToolArtifactRepository } from "../repositories/tool-artifacts.js";
import { redactSecrets } from "../provider/credentials.js";

/**
 * Artifact-backed externalization for oversized tool results (§3+§4).
 *
 * The contract:
 * - Inputs at or below `inlineByteLimit` are returned inline as `{kind:"inline", text}`.
 * - Inputs above the limit are stored in the artifact store and the call site
 *   receives `{kind:"artifact", id, …metadata…}` referencing the durable blob.
 *   Ordinary results expose only metadata, a small excerpt, and a retrieval
 *   hint; successful read results expose a separate bounded exact-content
 *   projection so the model does not need to reason about storage.
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

/** Bytes of read content reserved for the model-facing bounded projection. */
const MODEL_READ_CONTENT_BYTES = 6 * 1024;

export interface ReadPresentation {
  path?: string;
  offset: number;
  size: number;
  eof: boolean;
  content: string;
}

interface ArtifactPagePresentation {
  id: string;
  offset: number;
  totalBytes: number;
  truncated: boolean;
  content: string;
}

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
      /** Ephemeral source data used only to build a bounded read projection. */
      readPresentation?: ReadPresentation;
      /** Ephemeral page data used only to avoid recursive read_artifact externalization. */
      artifactPagePresentation?: ArtifactPagePresentation;
    };

export interface ExternalizeOptions {
  toolName: string;
  kind: string;
  contentType?: string;
  inlineByteLimit?: number;
  taskId?: string | null;
  now?: string;
  /** `null` disables the read inference for a known failed read result. */
  readPresentation?: ReadPresentation | null;
}

function utf8Prefix(input: string, maxBytes: number): { text: string; bytes: number; truncated: boolean } {
  const buffer = Buffer.from(input, "utf8");
  let end = Math.min(buffer.byteLength, maxBytes);
  while (end > 0 && end < buffer.byteLength && (buffer[end]! & 0xc0) === 0x80) end--;
  return {
    text: buffer.subarray(0, end).toString("utf8"),
    bytes: end,
    truncated: end < buffer.byteLength,
  };
}

function parseJsonObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Recover the structured read metadata emitted by `readWorkspaceFile`, while
 * treating an ordinary file whose contents happen to be JSON as plain text.
 * The live agent supplies the authoritative metadata directly; this parser is
 * for legacy rows and direct externalizer callers.
 */
export function readFilePresentationFromResult(
  result: string,
  input: { path?: unknown; offset?: unknown } = {},
): ReadPresentation | null {
  const parsed = parseJsonObject(result);
  const isStructuredRead = Boolean(parsed)
    && typeof parsed!.content === "string"
    && typeof parsed!.path === "string"
    && typeof parsed!.size === "number"
    && typeof parsed!.offset === "number"
    && typeof parsed!.nextOffset === "number"
    && typeof parsed!.eof === "boolean"
    && typeof parsed!.truncated === "boolean";
  if (isStructuredRead) {
    const content = parsed!.content as string;
    const offset = typeof parsed!.offset === "number" && Number.isSafeInteger(parsed!.offset) && parsed!.offset >= 0
      ? parsed!.offset
      : typeof input.offset === "number" && Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
    const size = typeof parsed!.size === "number" && Number.isSafeInteger(parsed!.size) && parsed!.size >= offset
      ? parsed!.size
      : offset + Buffer.byteLength(content, "utf8");
    return {
      ...(typeof parsed!.path === "string" ? { path: parsed!.path } : typeof input.path === "string" ? { path: input.path } : {}),
      offset,
      size,
      eof: parsed!.eof === true,
      content,
    };
  }

  // A successful `read_file` with no structured envelope is the raw file
  // content (the common offset=0, non-truncated path). Keep that content
  // authoritative when reconstructing a legacy durable row as well as when a
  // caller invokes this helper directly.
  const content = result;
  const offset = typeof input.offset === "number" && Number.isSafeInteger(input.offset) && input.offset >= 0 ? input.offset : 0;
  return {
    ...(typeof input.path === "string" ? { path: input.path } : {}),
    offset,
    size: offset + Buffer.byteLength(content, "utf8"),
    eof: true,
    content,
  };
}

function parseArtifactPagePresentation(result: string): ArtifactPagePresentation | null {
  const parsed = parseJsonObject(result);
  if (!parsed || typeof parsed.artifactId !== "string" || typeof parsed.content !== "string") return null;
  const offset = typeof parsed.offset === "number" && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0 ? parsed.offset : 0;
  const totalBytes = typeof parsed.totalBytes === "number" && Number.isSafeInteger(parsed.totalBytes) && parsed.totalBytes >= offset
    ? parsed.totalBytes
    : offset + Buffer.byteLength(parsed.content, "utf8");
  return {
    id: parsed.artifactId,
    offset,
    totalBytes,
    truncated: parsed.truncated === true,
    content: parsed.content,
  };
}

function readContinuation(
  tool: "read_file" | "read_artifact",
  args: Record<string, unknown>,
): { tool: string; arguments: Record<string, unknown> } {
  return { tool, arguments: args };
}

function renderBoundedReadPayload(
  content: string,
  build: (visible: { text: string; bytes: number; truncated: boolean }) => Record<string, unknown>,
): string {
  const safeContent = redactSecrets(content);
  const visible = utf8Prefix(safeContent, MODEL_READ_CONTENT_BYTES);
  const rendered = JSON.stringify(build(visible));
  if (Buffer.byteLength(rendered, "utf8") <= DEFAULT_INLINE_BYTE_LIMIT) return rendered;

  // Escaping source text for JSON can expand a valid UTF-8 page substantially
  // (quotes, backslashes, and newlines are all escaped). Find the largest
  // exact prefix that still fits the context bound instead of assuming raw
  // content bytes equal serialized JSON bytes.
  let low = 0;
  let high = visible.bytes;
  let best: string | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = utf8Prefix(safeContent, middle);
    const candidateRendered = JSON.stringify(build(candidate));
    if (Buffer.byteLength(candidateRendered, "utf8") <= DEFAULT_INLINE_BYTE_LIMIT) {
      best = candidateRendered;
      low = candidate.bytes + 1;
    } else {
      high = candidate.bytes - 1;
    }
  }
  return best ?? JSON.stringify(build(utf8Prefix(safeContent, 0)));
}

function renderReadPresentation(read: ReadPresentation, artifactId?: string): string {
  const target = typeof read.path === "string" && read.path ? redactSecrets(read.path) : "the requested file";
  return renderBoundedReadPayload(read.content, (visible) => {
    const nextOffset = read.offset + visible.bytes;
    const complete = read.eof && !visible.truncated;
    const payload: Record<string, unknown> = {
      read_succeeded: true,
      ...(read.path ? { path: target } : {}),
      offset: read.offset,
      size: read.size,
      content: visible.text,
      content_bytes: visible.bytes,
      content_complete: !visible.truncated,
      eof: complete,
      note: complete
        ? `read_file succeeded. The content field is the exact content of ${target}. Treat it as authoritative; do not rewrite the file to inspect it.`
        : `read_file succeeded. The content field is the exact content shown for ${target} from byte ${read.offset}; more content remains. Continue at next_offset and do not rewrite the file to inspect it.`,
    };
    if (!complete) {
      payload.next_offset = nextOffset;
      payload.next_action = read.path
        ? readContinuation("read_file", { path: target, offset: nextOffset })
        : readContinuation("read_artifact", { id: artifactId ?? "", offset: nextOffset, length: MAX_ARTIFACT_READ_BYTES });
    }
    return payload;
  });
}

function renderArtifactPagePresentation(page: ArtifactPagePresentation): string {
  return renderBoundedReadPayload(page.content, (visible) => {
    const nextOffset = page.offset + visible.bytes;
    const complete = !page.truncated && !visible.truncated;
    const payload: Record<string, unknown> = {
      read_succeeded: true,
      offset: page.offset,
      total_bytes: page.totalBytes,
      content: visible.text,
      content_bytes: visible.bytes,
      content_complete: !visible.truncated,
      eof: complete,
      note: complete
        ? "The content field is the exact content returned for this range and is ready to use."
        : "The content field is the exact content returned for this range. Use next_action for the next bounded range if more is needed.",
    };
    if (!complete) {
      payload.next_offset = nextOffset;
      payload.next_action = readContinuation("read_artifact", { id: page.id, offset: nextOffset, length: MAX_ARTIFACT_READ_BYTES });
    }
    return payload;
  });
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
  const readPresentation = options.readPresentation === null
    ? undefined
    : options.readPresentation ?? (options.toolName === "read_file" ? readFilePresentationFromResult(safeText) : undefined);
  const artifactPagePresentation = options.toolName === "read_artifact"
    ? parseArtifactPagePresentation(safeText)
    : null;
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
    ...(readPresentation ? { readPresentation } : {}),
    ...(artifactPagePresentation ? { artifactPagePresentation } : {}),
  };
}

/**
 * Render an externalized result as a JSON-serializable string suitable for
 * embedding in a tool-result message that the model will see on its next
 * turn. Ordinary oversized results see only metadata + excerpt + retrieval
 * hint. Successful reads are different: they see a bounded exact content
 * prefix and an explicit next action, so the model never has to infer whether
 * a file read succeeded from Morrow's storage vocabulary.
 */
export function renderExternalizedForContext(
  result: ExternalizedToolResult,
  options: { readPresentation?: ReadPresentation } = {},
): string {
  if (result.kind === "inline") return result.text;
  if (result.artifactPagePresentation) return renderArtifactPagePresentation(result.artifactPagePresentation);
  const readPresentation = options.readPresentation ?? result.readPresentation;
  if (readPresentation) return renderReadPresentation(readPresentation, result.id);
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
    hint: `The result is larger than this context window. Call read_artifact with ${JSON.stringify({ id: result.id, offset: 0, length: MAX_ARTIFACT_READ_BYTES })} to fetch the next bounded section; its content field is directly usable.`,
  });
}

/**
 * Keep a bounded `read_artifact` page usable when materializing legacy rows or
 * when a caller has not gone through `externalizeToolResult` first.
 */
export function renderReadArtifactPageForContext(result: string): string | null {
  if (Buffer.byteLength(result, "utf8") <= DEFAULT_INLINE_BYTE_LIMIT) return null;
  const page = parseArtifactPagePresentation(result);
  return page ? renderArtifactPagePresentation(page) : null;
}

/** Every artifact id this run has actually handed to the model. */
export function collectOfferedArtifactIds(renderedToolResults: Iterable<string>): Set<string> {
  const ids = new Set<string>();
  for (const rendered of renderedToolResults) {
    if (!rendered) continue;
    try {
      const parsed = JSON.parse(rendered) as Record<string, unknown>;
      if (typeof parsed.artifactId === "string" && parsed.artifactId) ids.add(parsed.artifactId);
      const action = parsed.next_action;
      if (action && typeof action === "object" && !Array.isArray(action)) {
        const actionRecord = action as Record<string, unknown>;
        const args = actionRecord.arguments;
        if (actionRecord.tool === "read_artifact" && args && typeof args === "object" && !Array.isArray(args)) {
          const id = (args as Record<string, unknown>).id;
          if (typeof id === "string" && id) ids.add(id);
        }
      }
    } catch {
      // Non-JSON legacy tool results can still carry the old artifactId marker.
      for (const match of rendered.matchAll(/"artifactId"\s*:\s*"([^"]+)"/g)) {
        if (match[1]) ids.add(match[1]);
      }
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
  let end = Math.min(offset + length, totalBytes);

  // Never split a UTF-8 sequence. If the byte immediately after the proposed
  // page boundary is a continuation byte, move the boundary back to the lead
  // byte and let the next page begin there.
  while (end < totalBytes && end > offset && (content[end]! & 0xc0) === 0x80) end--;

  return {
    ok: true,
    payload: {
      artifactId: row.id,
      toolName: row.toolName,
      contentType: row.contentType,
      totalBytes,
      offset,
      returnedBytes: end - offset,
      // Truncation is measured against the bytes actually served, never the
      // stored `bytes` column. A legacy artifact written before content
      // sanitization carries a pre-redaction byte count, and redaction shrinks
      // what `getContent` returns — mixing the two reported `truncated` at the
      // true end of the content and handed back a `nextOffset` that yielded
      // zero further bytes, so a compliant model paginated forever.
      truncated: end < totalBytes,
      ...(end < totalBytes ? { nextOffset: end } : {}),
      content: content.subarray(offset, end).toString("utf8"),
    },
  };
}
