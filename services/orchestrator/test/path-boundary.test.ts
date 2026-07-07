import { describe, expect, it } from "vitest";
import { win32, posix } from "node:path";
import { isWithinWorkspace } from "../src/workspace/path-boundary.js";

describe("workspace path containment", () => {
  const oneDriveRoot = "C:\\Users\\aidan\\OneDrive\\Documents\\Morrow\\Tests\\Todo-App";

  it("treats the workspace root itself as contained", () => {
    expect(isWithinWorkspace(oneDriveRoot, oneDriveRoot, win32)).toBe(true);
  });

  it("contains children of an OneDrive workspace on Windows", () => {
    expect(isWithinWorkspace(oneDriveRoot, `${oneDriveRoot}\\src\\App.tsx`, win32)).toBe(true);
    expect(isWithinWorkspace(oneDriveRoot, `${oneDriveRoot}\\package.json`, win32)).toBe(true);
  });

  it("tolerates drive-letter case differences from realpath on Windows", () => {
    // fs.realpathSync can return a different drive-letter case than the stored
    // root; a raw case-sensitive startsWith would falsely report "outside".
    const lowerDriveRoot = "c:\\Users\\aidan\\OneDrive\\Documents\\Morrow\\Tests\\Todo-App";
    expect(isWithinWorkspace(oneDriveRoot, `${lowerDriveRoot}\\src\\main.tsx`, win32)).toBe(true);
    expect(isWithinWorkspace(lowerDriveRoot, `${oneDriveRoot}\\src\\main.tsx`, win32)).toBe(true);
  });

  it("tolerates mixed path-segment casing on Windows (case-insensitive FS)", () => {
    expect(isWithinWorkspace(oneDriveRoot, `${oneDriveRoot}\\SRC\\App.tsx`, win32)).toBe(true);
  });

  it("rejects a sibling directory that merely shares a prefix on Windows", () => {
    expect(isWithinWorkspace(oneDriveRoot, "C:\\Users\\aidan\\OneDrive\\Documents\\Morrow\\Tests\\Todo-App-Evil\\x", win32)).toBe(false);
  });

  it("rejects traversal and escapes on Windows", () => {
    expect(isWithinWorkspace(oneDriveRoot, "C:\\Users\\aidan\\.ssh\\id_rsa", win32)).toBe(false);
    expect(isWithinWorkspace(oneDriveRoot, "C:\\Windows\\System32", win32)).toBe(false);
  });

  it("works for posix workspaces too", () => {
    const root = "/home/dev/projects/app";
    expect(isWithinWorkspace(root, root, posix)).toBe(true);
    expect(isWithinWorkspace(root, `${root}/src/index.ts`, posix)).toBe(true);
    expect(isWithinWorkspace(root, "/home/dev/projects/other/x", posix)).toBe(false);
    expect(isWithinWorkspace(root, "/etc/passwd", posix)).toBe(false);
    // Posix is case-sensitive: a case-mismatched path is genuinely different.
    expect(isWithinWorkspace(root, "/home/dev/projects/APP/src", posix)).toBe(false);
  });
});
