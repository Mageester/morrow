import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  chatCommand: vi.fn(async () => 0),
  ensureRunning: vi.fn(async () => undefined),
  serveDetached: vi.fn(async () => undefined),
  serveForeground: vi.fn(async () => 0),
  stop: vi.fn(async () => false),
  tailLog: vi.fn(() => ""),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}));

vi.mock("../src/commands/chat.js", () => ({
  chatCommand: mocks.chatCommand,
}));

vi.mock("../src/service/lifecycle.js", () => ({
  ensureRunning: mocks.ensureRunning,
  serveDetached: mocks.serveDetached,
  serveForeground: mocks.serveForeground,
  stop: mocks.stop,
  tailLog: mocks.tailLog,
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

import { run } from "../src/main.js";

describe("bare morrow launch", () => {
  let oldHome: string | undefined;
  let home: string;

  beforeEach(() => {
    oldHome = process.env.MORROW_HOME;
    home = mkdtempSync(join(tmpdir(), "morrow-root-launch-"));
    process.env.MORROW_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({ user: { onboarded: true } }), "utf8");
  });

  afterEach(() => {
    if (oldHome === undefined) delete process.env.MORROW_HOME;
    else process.env.MORROW_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("opens the terminal chat entry instead of the browser", async () => {
    await expect(run([])).resolves.toBe(0);

    expect(mocks.chatCommand).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("keeps morrow open as the explicit browser command", async () => {
    await expect(run(["open"])).resolves.toBe(0);

    expect(mocks.chatCommand).not.toHaveBeenCalled();
    expect(mocks.ensureRunning).toHaveBeenCalledTimes(1);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });
});
