import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { normalizeWorkspacePath } from "../src/workspace/path-boundary.js";

/**
 * Live evidence (nemotron-3.5-lightning, task a5196a7c) drove this seam.
 *
 * The model repeatedly passed the workspace's OWN absolute path to
 * `list_files` / `search_files` / `search_text` and was told "Workspace path is
 * outside configured workspace" — a claim that was both false and unactionable.
 * It never recovered.
 *
 * The rule this pins: an absolute path that genuinely resolves inside the
 * workspace is an ordinary way to name a workspace file and is normalized to
 * its relative form. Anything that does NOT resolve inside stays hard-rejected,
 * and the rejection has to say what was wrong and show a valid example.
 */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "morrow-pathnorm-"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html>");
  writeFileSync(join(root, "assets", "site.css"), "body{}");
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

describe("workspace path normalization", () => {
  it("normalizes workspace-contained absolute paths to their relative form", () => {
    const item = workspace();
    try {
      expect(normalizeWorkspacePath(item.root, item.root)).toEqual({ ok: true, path: "." });
      expect(normalizeWorkspacePath(item.root, `${item.root}${sep}`)).toEqual({ ok: true, path: "." });
      expect(normalizeWorkspacePath(item.root, join(item.root, "assets"))).toEqual({ ok: true, path: "assets" });
      expect(normalizeWorkspacePath(item.root, join(item.root, "assets", "site.css"))).toEqual({ ok: true, path: "assets/site.css" });
      // A path that does not exist yet is still a valid write target.
      expect(normalizeWorkspacePath(item.root, join(item.root, "assets", "new.js"))).toEqual({ ok: true, path: "assets/new.js" });
    } finally { item.remove(); }
  });

  it("leaves ordinary relative paths untouched", () => {
    const item = workspace();
    try {
      for (const value of ["", ".", "assets", "assets/site.css", "./assets/site.css"]) {
        const result = normalizeWorkspacePath(item.root, value);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.path).toBe(value);
      }
    } finally { item.remove(); }
  });

  it("still rejects absolute paths outside the workspace, and says so actionably", () => {
    const item = workspace();
    const outside = `${item.root}-other`;
    try {
      mkdirSync(outside);
      for (const value of [outside, join(outside, "escape.txt"), "/etc/passwd", "/", "C:\\Windows\\System32"]) {
        const result = normalizeWorkspacePath(item.root, value);
        expect(result.ok, `${value} must be rejected`).toBe(false);
        if (result.ok) continue;
        expect(result.code).toBe("path_outside_workspace");
        // The model must learn what was wrong AND what a valid value looks like.
        expect(result.message).toMatch(/outside/i);
        expect(result.message).toContain(item.root);
        expect(result.example).toMatch(/assets\/site\.css|\./);
      }
    } finally { item.remove(); rmSync(outside, { recursive: true, force: true }); }
  });

  it("rejects parent traversal even when it lands back inside the workspace", () => {
    const item = workspace();
    try {
      const result = normalizeWorkspacePath(item.root, "assets/../index.html");
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe("path_traversal");
      expect(result.message).toMatch(/\.\./);
      expect(result.example).toBeTruthy();
    } finally { item.remove(); }
  });

  it("does not let a sibling directory sharing the root's name prefix look contained", () => {
    const item = workspace();
    const sibling = `${item.root}-sibling`;
    try {
      mkdirSync(sibling);
      const result = normalizeWorkspacePath(item.root, join(sibling, "a.txt"));
      expect(result.ok).toBe(false);
    } finally { item.remove(); rmSync(sibling, { recursive: true, force: true }); }
  });
});
