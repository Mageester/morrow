import { afterEach, describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadHistory, appendHistory } from "../src/terminal/history.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "morrow-hist-"));
  dirs.push(dir);
  return join(dir, "nested", "history");
}

describe("command history", () => {
  it("returns [] for a missing file", () => {
    expect(loadHistory(tmpFile())).toEqual([]);
  });

  it("appends and round-trips lines (creating parent dirs)", () => {
    const file = tmpFile();
    appendHistory(file, "first command");
    appendHistory(file, "second command");
    expect(loadHistory(file)).toEqual(["first command", "second command"]);
  });

  it("collapses an immediately-consecutive duplicate", () => {
    const file = tmpFile();
    appendHistory(file, "same");
    appendHistory(file, "same");
    appendHistory(file, "different");
    appendHistory(file, "same");
    expect(loadHistory(file)).toEqual(["same", "different", "same"]);
  });

  it("ignores blank lines and exit-style noise", () => {
    const file = tmpFile();
    appendHistory(file, "   ");
    appendHistory(file, "/exit");
    appendHistory(file, "real");
    expect(loadHistory(file)).toEqual(["real"]);
  });

  it("trims history to the max length", () => {
    const file = tmpFile();
    for (let i = 0; i < 10; i++) appendHistory(file, `cmd ${i}`, 3);
    expect(loadHistory(file, 3)).toEqual(["cmd 7", "cmd 8", "cmd 9"]);
  });
});
