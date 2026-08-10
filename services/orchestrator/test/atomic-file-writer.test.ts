import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendWorkspaceFileAtomic, AtomicAppendError } from "../src/tools/atomic-file-writer.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("atomic workspace append", () => {
  let workspace: string;
  let backups: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "morrow-atomic-append-"));
    backups = join(workspace, ".backups");
  });
  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  it("creates and appends text with an expected-offset fence and content digest", () => {
    const created = appendWorkspaceFileAtomic({ workspaceRoot: workspace, relativePath: "dist/large.txt", content: "hello", expectedOffset: 0, backupDir: backups });
    expect(created).toMatchObject({ created: true, appendedBytes: 5, totalBytes: 5, sha256: sha256("hello"), originalHash: "" });

    const appended = appendWorkspaceFileAtomic({ workspaceRoot: workspace, relativePath: "dist/large.txt", content: " world", expectedOffset: created.totalBytes, backupDir: backups });
    expect(appended).toMatchObject({ created: false, appendedBytes: 6, totalBytes: 11, sha256: sha256("hello world"), originalHash: sha256("hello") });
    expect(readFileSync(join(workspace, "dist", "large.txt"), "utf8")).toBe("hello world");
    expect(readFileSync(join(backups, `${sha256("hello")}.bak`), "utf8")).toBe("hello");
    expect(readdirSync(join(workspace, "dist")).some((name) => name.includes("morrow-append"))).toBe(false);
  });

  it("rejects a stale replay without duplicating bytes", () => {
    writeFileSync(join(workspace, "output.txt"), "already written", "utf8");
    try {
      appendWorkspaceFileAtomic({ workspaceRoot: workspace, relativePath: "output.txt", content: " duplicate", expectedOffset: 0, backupDir: backups });
      throw new Error("expected append to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AtomicAppendError);
      expect(error).toMatchObject({ code: "OFFSET_MISMATCH", actualOffset: 15, expectedOffset: 0 });
    }
    expect(readFileSync(join(workspace, "output.txt"), "utf8")).toBe("already written");
  });

  it("assembles a multi-megabyte file across bounded chunks", () => {
    const chunk = "0123456789abcdef".repeat(32_768); // 512 KiB
    let offset = 0;
    for (let index = 0; index < 8; index++) {
      offset = appendWorkspaceFileAtomic({ workspaceRoot: workspace, relativePath: "generated/bundle.txt", content: chunk, expectedOffset: offset, backupDir: backups }).totalBytes;
    }
    expect(offset).toBe(4 * 1024 * 1024);
    expect(readFileSync(join(workspace, "generated", "bundle.txt"), "utf8")).toBe(chunk.repeat(8));
  });

  it.each(["../escape.txt", "C:\\Windows\\escape.txt", ".env", ".git/config"])("rejects unsafe target %s", (relativePath) => {
    expect(() => appendWorkspaceFileAtomic({ workspaceRoot: workspace, relativePath, content: "x", expectedOffset: 0, backupDir: backups })).toThrow();
    expect(existsSync(join(workspace, relativePath))).toBe(false);
  });

  it("rejects binary null bytes and invalid offsets", () => {
    expect(() => appendWorkspaceFileAtomic({ workspaceRoot: workspace, relativePath: "x.txt", content: "a\0b", expectedOffset: 0, backupDir: backups })).toThrow(/binary/i);
    expect(() => appendWorkspaceFileAtomic({ workspaceRoot: workspace, relativePath: "x.txt", content: "a", expectedOffset: -1, backupDir: backups })).toThrow(/offset/i);
  });
});
