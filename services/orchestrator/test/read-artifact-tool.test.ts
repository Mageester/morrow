import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { openDatabase } from "../src/database.js";
import { toolArtifactsRepository, type ToolArtifactRepository } from "../src/repositories/tool-artifacts.js";
import {
  collectOfferedArtifactIds,
  externalizeToolResult,
  MAX_ARTIFACT_READ_BYTES,
  readArtifactRange,
  renderExternalizedForContext,
} from "../src/execution/artifact-externalization.js";
import { IMPLEMENTED_TOOL_NAMES, getTool } from "../src/tools/catalog.js";

/**
 * Regression coverage for `Forbidden tool: read_artifact`.
 *
 * `renderExternalizedForContext` tells the model, in the tool result itself,
 * to call `read_artifact`. The tool was never in the catalog and never
 * dispatched, so a model that followed the instruction hit the runtime's
 * `Forbidden tool` branch and lost the turn. The fix authorizes the tool
 * through the existing read-only boundary rather than loosening anything, so
 * these tests pin both halves: the tool exists, and it only ever serves
 * artifact ids this task was actually shown.
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

describe("model-facing hints only name dispatchable tools", () => {
  it("advertises read_artifact as an implemented tool", () => {
    expect(IMPLEMENTED_TOOL_NAMES).toContain("read_artifact");
    expect(getTool("read_artifact")).toBeDefined();
    expect(getTool("read_artifact")!.sideEffect).toBe("read-only");
  });

  it("names no tool in the externalization hint that the runtime cannot dispatch", () => {
    const rendered = renderExternalizedForContext(
      externalizeToolResult(repo, "A".repeat(60_000), { toolName: "run_command", kind: "tool_result" }),
    );
    const hint = JSON.parse(rendered).hint as string;
    const named = [...hint.matchAll(/\b([a-z][a-z0-9_]{3,})\b/g)]
      .map((match) => match[1]!)
      .filter((word) => IMPLEMENTED_TOOL_NAMES.some((tool) => tool === word) || word === "read_artifact");
    expect(named.length).toBeGreaterThan(0);
    for (const tool of named) {
      expect(IMPLEMENTED_TOOL_NAMES, `hint names "${tool}" but the runtime does not implement it`).toContain(tool);
    }
  });
});

describe("collectOfferedArtifactIds", () => {
  it("recovers every artifact id from durable tool results so a restart keeps the permission", () => {
    const rendered = renderExternalizedForContext(
      externalizeToolResult(repo, "A".repeat(60_000), { toolName: "run_command", kind: "tool_result" }),
    );
    const other = renderExternalizedForContext(
      externalizeToolResult(repo, "B".repeat(60_000), { toolName: "read_file", kind: "tool_result" }),
    );
    const ids = collectOfferedArtifactIds([rendered, other, "", '{"exitCode":0}']);
    expect(ids.size).toBe(2);
    expect([...ids].every((id) => repo.get(id) !== null)).toBe(true);
  });

  it("returns nothing for results that reference no artifact", () => {
    expect(collectOfferedArtifactIds(['{"exitCode":0,"stdout":"ok"}']).size).toBe(0);
  });
});

describe("readArtifactRange", () => {
  function store(content: string, toolName = "run_command") {
    const out = externalizeToolResult(repo, content, { toolName, kind: "tool_result", contentType: "text/plain" });
    if (out.kind !== "artifact") throw new Error("expected artifact");
    return out;
  }

  it("returns a bounded range of an artifact the task was shown", () => {
    const artifact = store("0123456789".repeat(6_000));
    const result = readArtifactRange(repo, new Set([artifact.id]), { id: artifact.id, offset: 10, length: 20 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.content).toBe("0123456789".repeat(2));
    expect(result.payload.offset).toBe(10);
    expect(result.payload.totalBytes).toBe(60_000);
    expect(result.payload.truncated).toBe(true);
    expect(result.payload.nextOffset).toBe(30);
  });

  it("caps a single read so an artifact cannot be pulled back inline in one call", () => {
    const artifact = store("z".repeat(200_000));
    const result = readArtifactRange(repo, new Set([artifact.id]), { id: artifact.id, length: 999_999 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.returnedBytes).toBe(MAX_ARTIFACT_READ_BYTES);
    expect(result.payload.nextOffset).toBe(MAX_ARTIFACT_READ_BYTES);
  });

  it("pages to the exact end without over-reading", () => {
    const artifact = store("q".repeat(30_000));
    const result = readArtifactRange(repo, new Set([artifact.id]), { id: artifact.id, offset: 29_990 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.returnedBytes).toBe(10);
    expect(result.payload.truncated).toBe(false);
    expect(result.payload.nextOffset).toBeUndefined();
  });

  it("refuses an artifact this task was never shown, even though it exists", () => {
    const other = store("secret build log".repeat(4_000), "run_command");
    const result = readArtifactRange(repo, new Set(["some-other-id"]), { id: other.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("was not referenced in this task");
  });

  it("refuses a missing id, a blank id, and a non-string id", () => {
    for (const input of [{}, { id: "   " }, { id: 42 }]) {
      const result = readArtifactRange(repo, new Set<string>(), input);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses negative offsets and non-positive lengths", () => {
    const artifact = store("m".repeat(40_000));
    const offered = new Set([artifact.id]);
    expect(readArtifactRange(repo, offered, { id: artifact.id, offset: -1 }).ok).toBe(false);
    expect(readArtifactRange(repo, offered, { id: artifact.id, length: 0 }).ok).toBe(false);
  });

  it("reports an artifact that is no longer stored instead of throwing", () => {
    const result = readArtifactRange(repo, new Set(["gone"]), { id: "gone" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("no longer stored");
  });
});
