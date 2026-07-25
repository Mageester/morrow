import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateWorkspace, WorkspaceValidationError } from "../src/workspace/validator.js";

describe("validateWorkspace", () => {
  const roots: string[] = [];
  const tempDir = () => {
    const dir = mkdtempSync(join(tmpdir(), "morrow-validator-"));
    roots.push(dir);
    return dir;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("accepts an existing directory and returns its canonical path", () => {
    const dir = tempDir();
    const result = validateWorkspace(dir);
    expect(result.canonicalPath).toBe(dir);
  });

  it("accepts a directory whose path contains spaces", () => {
    const parent = tempDir();
    const spaced = join(parent, "My Project Folder");
    mkdirSync(spaced, { recursive: true });
    expect(validateWorkspace(spaced).canonicalPath).toBe(spaced);
  });

  it("rejects a path that does not exist", () => {
    const dir = tempDir();
    expect(() => validateWorkspace(join(dir, "does-not-exist"))).toThrow(WorkspaceValidationError);
  });

  it("rejects a path that is a file, not a directory", () => {
    const dir = tempDir();
    const file = join(dir, "file.txt");
    writeFileSync(file, "not a directory");
    expect(() => validateWorkspace(file)).toThrow(WorkspaceValidationError);
  });

  it("rejects blank input instead of resolving it against the process cwd", () => {
    expect(() => validateWorkspace("")).toThrow(WorkspaceValidationError);
    expect(() => validateWorkspace("   ")).toThrow(WorkspaceValidationError);
  });

  it("resolves a symlinked directory to its real target", () => {
    const dir = tempDir();
    const real = join(dir, "real");
    mkdirSync(real, { recursive: true });
    const link = join(dir, "link");
    try {
      symlinkSync(real, link, "junction");
    } catch {
      return; // Symlink privileges are not guaranteed in every CI/sandbox environment.
    }
    expect(validateWorkspace(link).canonicalPath).toBe(real);
  });
});
