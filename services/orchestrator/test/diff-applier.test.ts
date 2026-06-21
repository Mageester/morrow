import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, validatePatchPaths, applyUnifiedPatch, hashString, assertContainedRealPath } from "../src/tools/diff-applier.js";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Unified Diff Parser & Applier", () => {
  it("parses and applies a standard unified diff correctly", () => {
    const original = "line 1\nline 2\nline 3\nline 4\nline 5";
    const diff = `
--- a/test.txt
+++ b/test.txt
@@ -2,3 +2,3 @@
 line 2
-line 3
+line three
 line 4
`;
    const patches = parseUnifiedDiff(diff.trim());
    expect(patches.length).toBe(1);
    expect(patches[0]!.oldPath).toBe("test.txt");
    expect(patches[0]!.newPath).toBe("test.txt");

    const applied = applyUnifiedPatch(original, patches[0]!.chunks);
    expect(applied).toBe("line 1\nline 2\nline three\nline 4\nline 5");
  });

  it("fails if context lines do not match exactly (rejects best-effort)", () => {
    const original = "line 1\nline 2\nline mismatch\nline 4\nline 5";
    const diff = `
--- a/test.txt
+++ b/test.txt
@@ -2,3 +2,3 @@
 line 2
-line 3
+line three
 line 4
`;
    const patches = parseUnifiedDiff(diff.trim());
    expect(() => {
      applyUnifiedPatch(original, patches[0]!.chunks);
    }).toThrow(/Patch conflict/);
  });

  it("rejects forbidden features (mode changes, binary files, renames)", () => {
    const diffWithRename = `
--- a/old.txt
+++ b/new.txt
rename from old.txt
rename to new.txt
`;
    expect(() => parseUnifiedDiff(diffWithRename)).toThrow(/Unsupported diff feature/);

    const diffWithBinary = `
Binary files a/img.png and b/img.png differ
`;
    expect(() => parseUnifiedDiff(diffWithBinary)).toThrow(/Unsupported diff feature/);
  });

  it("validates workspace path containment and rejects escapes", () => {
    const patches = [
      {
        oldPath: "../outside.txt",
        newPath: "inside.txt",
        chunks: []
      }
    ];

    expect(() => {
      validatePatchPaths("C:\\workspace", patches, []);
    }).toThrow(/Parent traversal/);

    const absolutePatches = [
      {
        oldPath: "C:\\outside.txt",
        newPath: "inside.txt",
        chunks: []
      }
    ];

    expect(() => {
      validatePatchPaths("C:\\workspace", absolutePatches, []);
    }).toThrow(/Absolute paths/);

    const secretPatches = [
      {
        oldPath: "my-secret-key.txt",
        newPath: "inside.txt",
        chunks: []
      }
    ];

    expect(() => {
      validatePatchPaths("C:\\workspace", secretPatches, ["*secret*"]);
    }).toThrow(/denied path pattern/);
  });

  it("rejects file creation and deletion patches", () => {
    expect(() => validatePatchPaths("C:\\workspace", [{ oldPath: "/dev/null", newPath: "new.txt", chunks: [] }], [])).toThrow(/creation is not supported/i);
    expect(() => validatePatchPaths("C:\\workspace", [{ oldPath: "gone.txt", newPath: "/dev/null", chunks: [] }], [])).toThrow(/deletion is not supported/i);
  });
});

describe("assertContainedRealPath (symlink-aware containment)", () => {
  it("resolves a contained path (including not-yet-existing files)", () => {
    const ws = mkdtempSync(join(tmpdir(), "morrow-contain-"));
    try {
      mkdirSync(join(ws, "src"), { recursive: true });
      const resolved = assertContainedRealPath(ws, "src/new-file.ts");
      expect(resolved.endsWith("new-file.ts")).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths, traversal, and .git", () => {
    const ws = mkdtempSync(join(tmpdir(), "morrow-contain-"));
    try {
      expect(() => assertContainedRealPath(ws, "../escape.txt")).toThrow(/traversal/i);
      expect(() => assertContainedRealPath(ws, ".git/config")).toThrow(/\.git/);
      expect(() => assertContainedRealPath(ws, "C:\\Windows\\system32\\x")).toThrow(/Absolute/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("rejects a symlink that escapes the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "morrow-contain-"));
    const ws = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "secret.txt"), "top secret");
    let symlinkCreated = false;
    try {
      symlinkSync(join(outside, "secret.txt"), join(ws, "link.txt"), "file");
      symlinkCreated = true;
    } catch {
      // Symlink creation needs privileges on Windows; skip the assertion if so.
    }
    try {
      if (symlinkCreated) {
        expect(() => assertContainedRealPath(ws, "link.txt")).toThrow(/escapes the workspace/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
