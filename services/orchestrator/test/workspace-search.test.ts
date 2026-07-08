import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceSearchError, searchFiles, searchText } from "../src/workspace/search.js";

describe("workspace search", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), "morrow-search-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "export const needle = 'visible';\n");
    writeFileSync(join(root, "notes.md"), "needle appears here too\n");
    writeFileSync(join(root, ".env"), "TOKEN=needle\n");
    writeFileSync(join(root, "credentials.txt"), "needle should stay hidden\n");
    return root;
  }

  it("searches safe text files with deterministic capped results", () => {
    const result = searchText(fixture(), "needle", { maxResults: 1 });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({ path: "notes.md", line: 1, preview: "needle appears here too" });
    expect(result.truncatedByCount).toBe(true);
    expect(result.matches.some((match) => match.path.includes(".env") || match.path.includes("credential"))).toBe(false);
  });

  it("searches safe filenames without exposing secret paths", () => {
    const result = searchFiles(fixture(), "app");

    expect(result.matches.map((match) => match.path)).toEqual(["src/app.ts"]);
    expect(searchFiles(fixture(), "credential").matches).toEqual([]);
  });

  it("searches inside a single file when path points to a file, not a directory", () => {
    // Regression: passing a concrete file path as the search scope previously
    // failed with "Workspace start path must be a directory".
    const root = fixture();
    const text = searchText(root, "needle", { path: "src/app.ts" });
    expect(text.matches.map((match) => match.path)).toEqual(["src/app.ts"]);
    expect(text.scannedFiles).toBe(1);

    const files = searchFiles(root, "app", { path: "src/app.ts" });
    expect(files.matches.map((match) => match.path)).toEqual(["src/app.ts"]);
  });

  it("stops immediately when cancelled", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => searchText(fixture(), "needle", { signal: controller.signal })).toThrow(WorkspaceSearchError);
  });
});
