import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { inspectWorkspace, WorkspaceInspectionError } from "../src/workspace/inspector.js";
import { validateWorkspace, WorkspaceValidationError } from "../src/workspace/validator.js";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "morrow-workspace-"));
  return { root, remove: () => rmSync(root, { recursive: true, force: true }) };
}

describe("workspace validation", () => {
  it("returns canonical absolute directory paths", () => {
    const item = workspace();
    try { expect(validateWorkspace(join(item.root, ".")).canonicalPath).toBe(resolve(item.root)); } finally { item.remove(); }
  });
  it("rejects missing paths and regular files without host details", () => {
    const item = workspace();
    try {
      const file = join(item.root, "file.txt"); writeFileSync(file, "x");
      expect(() => validateWorkspace(join(item.root, "missing"))).toThrow(WorkspaceValidationError);
      expect(() => validateWorkspace(file)).toThrow("Workspace path must be an accessible directory");
    } finally { item.remove(); }
  });
  it("resolves dot and dot-dot path components", () => {
    const item = workspace();
    try { mkdirSync(join(item.root, "nested")); expect(validateWorkspace(join(item.root, "nested", "..", ".")).canonicalPath).toBe(resolve(item.root)); } finally { item.remove(); }
  });
});

describe("workspace inspector", () => {
  it("returns normalized deterministic nested paths", () => {
    const item = workspace();
    try {
      mkdirSync(join(item.root, "nested")); writeFileSync(join(item.root, "z.txt"), "z"); writeFileSync(join(item.root, "nested", "a.txt"), "a");
      expect(inspectWorkspace(item.root, { maxDepth: 8, maxResults: 10 }).entries.map((entry) => entry.path)).toEqual(["nested/a.txt", "z.txt"]);
    } finally { item.remove(); }
  });
  it("reports depth and count truncation", () => {
    const item = workspace();
    try {
      mkdirSync(join(item.root, "nested")); writeFileSync(join(item.root, "nested", "a.txt"), "a"); writeFileSync(join(item.root, "b.txt"), "b");
      expect(inspectWorkspace(item.root, { maxDepth: 0, maxResults: 10 }).truncatedByDepth).toBe(true);
      expect(inspectWorkspace(item.root, { maxDepth: 8, maxResults: 1 }).truncatedByCount).toBe(true);
    } finally { item.remove(); }
  });
  it("rejects traversal, absolute escape, and prefix collision paths", () => {
    const item = workspace(); const outside = `${item.root}-other`;
    try {
      mkdirSync(outside); writeFileSync(join(outside, "escape.txt"), "x");
      expect(() => inspectWorkspace(item.root, { startPath: `..${sep}escape`, maxDepth: 1, maxResults: 1 })).toThrow(WorkspaceInspectionError);
      expect(() => inspectWorkspace(item.root, { startPath: outside, maxDepth: 1, maxResults: 1 })).toThrow(WorkspaceInspectionError);
      expect(() => inspectWorkspace(item.root, { startPath: "..\\escape", maxDepth: 1, maxResults: 1 })).toThrow(WorkspaceInspectionError);
    } finally { item.remove(); rmSync(outside, { recursive: true, force: true }); }
  });
  it("excludes morrow data and rejects external symlinks", () => {
    const item = workspace(); const outside = `${item.root}-other`;
    try {
      mkdirSync(join(item.root, ".morrow")); writeFileSync(join(item.root, ".morrow", "morrow.db"), "db"); writeFileSync(join(item.root, "ok.txt"), "ok");
      mkdirSync(outside); writeFileSync(join(outside, "escape.txt"), "x");
      try { symlinkSync(outside, join(item.root, "link"), "junction"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EPERM") return; throw error; }
      expect(() => inspectWorkspace(item.root, { maxDepth: 8, maxResults: 10 })).toThrow(WorkspaceInspectionError);
      rmSync(join(item.root, "link"), { recursive: true, force: true });
      expect(inspectWorkspace(item.root, { maxDepth: 8, maxResults: 10 }).entries.map((entry) => entry.path)).toEqual(["ok.txt"]);
    } finally { item.remove(); rmSync(outside, { recursive: true, force: true }); }
  });
});
