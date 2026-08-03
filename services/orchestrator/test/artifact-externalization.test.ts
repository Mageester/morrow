import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { toolArtifactsRepository, type ToolArtifactRepository } from "../src/repositories/tool-artifacts.js";
import { externalizeToolResult, readArtifactRange, renderExternalizedForContext, DEFAULT_INLINE_BYTE_LIMIT, MAX_ARTIFACT_READ_BYTES } from "../src/execution/artifact-externalization.js";

/**
 * §3+§4 acceptance: oversized tool results are externalized to the durable
 * tool_artifacts store; the model sees ONLY metadata + excerpt + retrieval
 * hint; the full payload is preserved for inspection; identical content
 * deduplicates.
 */

let db: Database.Database;
let repo: ToolArtifactRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  repo = toolArtifactsRepository(db);
});
afterEach(() => {
  db.close();
});

describe("externalizeToolResult: inline vs artifact", () => {
  it("returns the result inline when bytes <= limit", () => {
    const text = "x".repeat(DEFAULT_INLINE_BYTE_LIMIT - 100);
    const out = externalizeToolResult(repo, text, { toolName: "read_file", kind: "tool_result" });
    expect(out.kind).toBe("inline");
    if (out.kind !== "inline") return;
    expect(out.bytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(out.text).toBe(text);
  });

  it("stores oversized results in tool_artifacts and returns a metadata ref", () => {
    const big = "A".repeat(60_000);
    const out = externalizeToolResult(repo, big, { toolName: "read_file", kind: "tool_result", contentType: "text/plain" });
    expect(out.kind).toBe("artifact");
    if (out.kind !== "artifact") return;
    expect(out.bytes).toBe(60_000);
    expect(out.contentHash).toHaveLength(64);
    expect(out.id).toMatch(/[0-9a-f-]{36}/);
    // Persisted: the artifact store has the row with the full content.
    const stored = repo.get(out.id);
    expect(stored).not.toBeNull();
    expect(stored!.bytes).toBe(60_000);
    expect(stored!.refcount).toBe(1);
    expect(stored!.toolName).toBe("read_file");
    expect(stored!.kind).toBe("tool_result");
    // The blob is the full 60 KB, not the excerpt.
    const blob = repo.getContent(out.id);
    expect(blob!.byteLength).toBe(60_000);
    // The excerpt + retrieval hint are model-facing.
    expect(out.excerpt.length).toBeLessThan(800);
    expect(out.retrieval).toEqual({ kind: "tool_artifacts.get", id: out.id });
  });

  it("does not inline the full content into the model-facing message", () => {
    const big = "Z".repeat(120_000);
    const out = externalizeToolResult(repo, big, { toolName: "run_command", kind: "tool_result" });
    const rendered = renderExternalizedForContext(out);
    // The full 120 KB must not appear in the model-facing message.
    expect(rendered).not.toContain("Z".repeat(60_000));
    // It must include the artifact id and a retrieval hint.
    expect(rendered).toContain("artifactId");
    expect(rendered).toContain("read_artifact");
    expect(rendered.length).toBeLessThan(2_000);
  });
});

describe("externalizeToolResult: dedup", () => {
  it("identical content shares a single row and increments refcount", () => {
    const big = "duplicate".repeat(5_000);
    const a = externalizeToolResult(repo, big, { toolName: "read_file", kind: "tool_result" });
    const b = externalizeToolResult(repo, big, { toolName: "read_file", kind: "tool_result" });
    expect(a.kind).toBe("artifact");
    expect(b.kind).toBe("artifact");
    if (a.kind !== "artifact" || b.kind !== "artifact") return;
    expect(a.id).toBe(b.id);
    expect(a.contentHash).toBe(b.contentHash);
    const stored = repo.get(a.id);
    expect(stored!.refcount).toBe(2);
  });

  it("different content produces different artifacts", () => {
    const a = externalizeToolResult(repo, "X".repeat(30_000), { toolName: "run_command", kind: "tool_result" });
    const b = externalizeToolResult(repo, "Y".repeat(30_000), { toolName: "run_command", kind: "tool_result" });
    expect(a.kind).toBe("artifact");
    expect(b.kind).toBe("artifact");
    if (a.kind !== "artifact" || b.kind !== "artifact") return;
    expect(a.id).not.toBe(b.id);
  });

  it("redacts oversized text at the artifact boundary before storing or returning it", () => {
    const probe = "credential sk-abcdefghijklmnop";
    const out = externalizeToolResult(repo, `${probe}\n`.repeat(2_000), { toolName: "run_command", kind: "tool_result" });
    expect(out.kind).toBe("artifact");
    if (out.kind !== "artifact") return;

    expect(JSON.stringify(repo.get(out.id))).not.toContain(probe);
    expect(repo.getContent(out.id)?.toString("utf8")).not.toContain(probe);
    const read = readArtifactRange(repo, new Set([out.id]), { id: out.id, length: MAX_ARTIFACT_READ_BYTES });
    expect(read.ok).toBe(true);
    if (read.ok) expect(JSON.stringify(read.payload)).not.toContain(probe);
  });

  it("redacts legacy artifact metadata and content on reads", () => {
    const out = externalizeToolResult(repo, "safe\n".repeat(2_000), { toolName: "run_command", kind: "tool_result" });
    expect(out.kind).toBe("artifact");
    if (out.kind !== "artifact") return;
    const probe = "credential sk-abcdefghijklmnop";
    const raw = Buffer.from(`${probe}\nlegacy output`, "utf8");
    db.prepare("UPDATE tool_artifacts SET summary=?, excerpt=?, content=?, bytes=? WHERE id=?")
      .run(probe, probe, raw, raw.byteLength, out.id);

    expect(JSON.stringify(repo.get(out.id))).not.toContain(probe);
    expect(repo.getContent(out.id)?.toString("utf8")).not.toContain(probe);
    const read = readArtifactRange(repo, new Set([out.id]), { id: out.id });
    expect(read.ok).toBe(true);
    if (read.ok) expect(JSON.stringify(read.payload)).not.toContain(probe);
  });
});
