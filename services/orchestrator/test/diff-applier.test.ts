import { describe, it, expect } from "vitest";
import { parseUnifiedDiff, validatePatchPaths, applyUnifiedPatch, hashString, assertContainedRealPath, buildCreationDiff } from "../src/tools/diff-applier.js";
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

  it("fails if context lines do not match exactly and no unique recovery target exists", () => {
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

  it("applies exact-context patches successfully", () => {
    const original = "alpha\nbeta\ngamma\n";
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const patches = parseUnifiedDiff(diff);
    expect(applyUnifiedPatch(original, patches[0]!.chunks)).toBe("alpha\nBETA\ngamma\n");
  });

  it("applies a patch whose context shifted after an earlier edit", () => {
    const original = "inserted\nalpha\nbeta\ngamma\n";
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const patches = parseUnifiedDiff(diff);
    expect(applyUnifiedPatch(original, patches[0]!.chunks)).toBe("inserted\nalpha\nBETA\ngamma\n");
  });

  it("applies two sequential hunks to the same file", () => {
    const original = "one\ntwo\nthree\nfour\n";
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -1,2 +1,2 @@",
      " one",
      "-two",
      "+TWO",
      "@@ -3,2 +3,2 @@",
      " three",
      "-four",
      "+FOUR",
      "",
    ].join("\n");
    const patches = parseUnifiedDiff(diff);
    expect(applyUnifiedPatch(original, patches[0]!.chunks)).toBe("one\nTWO\nthree\nFOUR\n");
  });

  it("preserves CRLF line endings when patch input uses LF", () => {
    const original = "alpha\r\nbeta\r\ngamma\r\n";
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const patches = parseUnifiedDiff(diff);
    expect(applyUnifiedPatch(original, patches[0]!.chunks)).toBe("alpha\r\nBETA\r\ngamma\r\n");
  });

  it("inserts an insertion-only hunk at the line boundary named by the header", () => {
    const original = "one\ntwo\nthree\n";
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -1,0 +2,1 @@",
      "+inserted",
      "",
    ].join("\n");
    const patches = parseUnifiedDiff(diff);

    expect(applyUnifiedPatch(original, patches[0]!.chunks)).toBe("one\ninserted\ntwo\nthree\n");
  });

  it("tolerates harmless trailing-whitespace differences only when the target is unique", () => {
    const original = "alpha   \nbeta\t\ngamma\n";
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -1,3 +1,3 @@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "",
    ].join("\n");
    const patches = parseUnifiedDiff(diff);
    expect(applyUnifiedPatch(original, patches[0]!.chunks)).toBe("alpha\nBETA\ngamma\n");
  });

  it("does not treat changed leading whitespace as harmless context drift", () => {
    const original = "if ready:\n  run()\n";
    const diff = [
      "--- a/test.py",
      "+++ b/test.py",
      "@@ -1,2 +1,2 @@",
      " if ready:",
      "-   run()",
      "+  done()",
      "",
    ].join("\n");
    const patches = parseUnifiedDiff(diff);

    expect(() => applyUnifiedPatch(original, patches[0]!.chunks)).toThrow(/Patch conflict/);
  });

  it("rejects a shifted hunk when its full context occurs in two places", () => {
    const original = "prefix\nheading\nold target\nfooter\nseparator\nheading\nold target\nfooter\nsuffix\n";
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -20,3 +20,3 @@",
      " heading",
      "-old target",
      "+new target",
      " footer",
      "",
    ].join("\n");
    const patches = parseUnifiedDiff(diff);

    expect(() => applyUnifiedPatch(original, patches[0]!.chunks)).toThrow(/ambiguous/);
  });

  it("uses a unique changed-context target when the deletion line is unambiguous", () => {
    const original = "heading\nold target\nfooter changed\n";
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -1,3 +1,3 @@",
      " heading",
      "-old target",
      "+new target",
      " footer",
      "",
    ].join("\n");
    const patches = parseUnifiedDiff(diff);
    expect(applyUnifiedPatch(original, patches[0]!.chunks)).toBe("heading\nnew target\nfooter changed\n");
  });

  it("rejects ambiguous repeated fuzzy context", () => {
    const original = "heading\nold target\nfooter changed\nheading\nold target\nfooter changed\n";
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -1,3 +1,3 @@",
      " heading",
      "-old target",
      "+new target",
      " footer",
      "",
    ].join("\n");
    const patches = parseUnifiedDiff(diff);
    expect(() => applyUnifiedPatch(original, patches[0]!.chunks)).toThrow(/ambiguous/i);
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
    }).toThrow(/parent-traversal|Parent traversal/);

    const absolutePatches = [
      {
        oldPath: "C:\\outside.txt",
        newPath: "inside.txt",
        chunks: []
      }
    ];

    // An absolute path that cannot resolve inside the root is still rejected —
    // now naming the root and a valid value instead of just the path shape.
    expect(() => {
      validatePatchPaths("C:\\workspace", absolutePatches, []);
    }).toThrow(/outside this task's workspace root/);

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

  it("allows file creation but still rejects deletion patches", () => {
    // Creation (`--- /dev/null`) is supported: only the new side is validated.
    expect(() => validatePatchPaths("C:\\workspace", [{ oldPath: "/dev/null", newPath: "new.txt", chunks: [] }], [])).not.toThrow();
    // A created file still honors denied-name patterns on the new path.
    expect(() => validatePatchPaths("C:\\workspace", [{ oldPath: "/dev/null", newPath: ".env", chunks: [] }], ["*.env", ".env*"])).toThrow(/denied path pattern/i);
    // Deletion (`+++ /dev/null`) remains unsupported.
    expect(() => validatePatchPaths("C:\\workspace", [{ oldPath: "gone.txt", newPath: "/dev/null", chunks: [] }], [])).toThrow(/deletion is not supported/i);
  });

  it("buildCreationDiff produces a valid creation hunk for the new path", () => {
    const content = "import React from 'react';\n\nexport function App() {\n  return <div>hi</div>;\n}\n";
    const files = parseUnifiedDiff(buildCreationDiff("src/App.tsx", content));
    expect(files).toHaveLength(1);
    expect(files[0]!.oldPath).toBe("/dev/null");
    expect(files[0]!.newPath).toBe("src/App.tsx");
  });

  it("buildCreationDiff content survives a parse+apply round trip exactly (LF-normalized)", () => {
    for (const content of [
      "single line no newline",
      "a\nb\nc\n",
      "a\nb\nc",
      "line with trailing spaces   \n\tindented\n",
      "a\r\nb\r\n",
    ]) {
      const files = parseUnifiedDiff(buildCreationDiff("f.txt", content));
      const applied = applyUnifiedPatch(null, files[0]!.chunks);
      expect(applied).toBe(content.replace(/\r\n/g, "\n"));
      expect(applied).not.toContain("\r");
    }
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

  it("rejects escaping paths, traversal, and .git with an actionable message", () => {
    const ws = mkdtempSync(join(tmpdir(), "morrow-contain-"));
    try {
      expect(() => assertContainedRealPath(ws, "../escape.txt")).toThrow(/traversal/i);
      expect(() => assertContainedRealPath(ws, ".git/config")).toThrow(/\.git/);
      // An absolute path that cannot resolve inside this root stays rejected,
      // and the rejection names the root and shows a valid value.
      expect(() => assertContainedRealPath(ws, "C:\\Windows\\system32\\x")).toThrow(/outside this task's workspace root/);
      expect(() => assertContainedRealPath(ws, "/etc/passwd")).toThrow(/outside this task's workspace root/);
      expect(() => assertContainedRealPath(ws, "/etc/passwd")).toThrow(/assets\/site\.css/);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("accepts an absolute path that resolves inside the workspace", () => {
    const ws = mkdtempSync(join(tmpdir(), "morrow-contain-abs-"));
    try {
      mkdirSync(join(ws, "assets"), { recursive: true });
      // The model naming its own workspace file absolutely is ordinary, not an
      // attack. It resolves to exactly the same target as the relative form.
      expect(assertContainedRealPath(ws, join(ws, "assets", "site.css")))
        .toBe(assertContainedRealPath(ws, "assets/site.css"));
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

  /**
   * Found dogfooding: DeepSeek flash models frequently miscount the hunk
   * header (`@@ -19,7 +19,9 @@`) relative to the lines they actually wrote,
   * which used to hard-reject an otherwise perfectly applicable patch.
   *
   * Safe because the header's declared counts are never an independent
   * source of truth downstream — `oldComparableLines`/`removeLines` are
   * derived directly from the hunk body's `-`/` ` lines (the same lines this
   * repair counts), never from `chunk.oldLines`/`newLines`. Repairing the
   * header cannot change how many lines get removed or where content is
   * matched; it only decides whether an arithmetic-only mistake in the
   * header blocks an otherwise-correct patch.
   */
  it("repairs a hunk header that miscounts its own line count instead of rejecting the patch", () => {
    const original = "line 1\nline 2\nline 3\nline 4\nline 5\n";
    // Header claims 3 old / 3 new lines; the body actually carries 4 old
    // (one context + one deletion... ) — declared counts intentionally wrong.
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -2,3 +2,3 @@",
      " line 2",
      "-line 3",
      "+line three",
      " line 4",
      " line 5",
    ].join("\n");

    const patches = parseUnifiedDiff(diff);
    expect(patches[0]!.chunks[0]).toMatchObject({ oldLines: 4, newLines: 4 });
    const applied = applyUnifiedPatch(original, patches[0]!.chunks);
    expect(applied).toBe("line 1\nline 2\nline three\nline 4\nline 5\n");
  });

  it("still rejects a patch whose body content does not match the file, even with a miscounted header", () => {
    const original = "line 1\nline 2\nline mismatch\nline 4\nline 5\n";
    const diff = [
      "--- a/test.txt",
      "+++ b/test.txt",
      "@@ -2,3 +2,3 @@", // still wrong on purpose
      " line 2",
      "-line 3",
      "+line three",
      " line 4",
      " line 5",
    ].join("\n");

    const patches = parseUnifiedDiff(diff);
    expect(() => applyUnifiedPatch(original, patches[0]!.chunks)).toThrow(/Patch conflict/);
  });
});

/**
 * A hunk header with no line numbers. Models emit this constantly — several
 * diff tools accept it — and Morrow rejected the ENTIRE patch with "could not
 * parse any file hunks", so a live run burned six turns across two files
 * before giving up and rewriting a 9 KB file whole. Placement never depended
 * on the header anyway: context matching does the work.
 */
describe("headerless @@ hunks", () => {
  const original = "const a = 1;\nconst dead = null;\nconst b = 2;\n";
  const expected = "const a = 1;\nconst b = 2;\n";

  it("parses and applies a hunk with no line numbers", () => {
    const files = parseUnifiedDiff("--- a/runs.js\n+++ b/runs.js\n@@\n const a = 1;\n-const dead = null;\n const b = 2;\n");
    expect(files[0]!.chunks).toHaveLength(1);
    expect(applyUnifiedPatch(original, files[0]!.chunks)).toBe(expected);
  });

  it("accepts a trailing section label after @@", () => {
    const files = parseUnifiedDiff("--- a/runs.js\n+++ b/runs.js\n@@ cmdShow\n const a = 1;\n-const dead = null;\n const b = 2;\n");
    expect(applyUnifiedPatch(original, files[0]!.chunks)).toBe(expected);
  });

  it("leaves numbered headers behaving exactly as before", () => {
    const files = parseUnifiedDiff("--- a/runs.js\n+++ b/runs.js\n@@ -1,3 +1,2 @@\n const a = 1;\n-const dead = null;\n const b = 2;\n");
    expect(applyUnifiedPatch(original, files[0]!.chunks)).toBe(expected);
  });

  it("refuses a headerless hunk with no context rather than guessing where it goes", () => {
    const files = parseUnifiedDiff("--- a/runs.js\n+++ b/runs.js\n@@\n+const c = 3;\n");
    expect(() => applyUnifiedPatch(original, files[0]!.chunks)).toThrow(/cannot be placed/);
  });
});
