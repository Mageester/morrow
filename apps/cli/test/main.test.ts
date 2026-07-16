import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveInvocation, run } from "../src/main.js";

describe("morrow root command", () => {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

  afterEach(() => {
    stdout.mockClear();
    stderr.mockClear();
  });

  it("prints a product-oriented help surface", async () => {
    await expect(run(["--help"])).resolves.toBe(0);
    const help = stdout.mock.calls.map(([value]) => String(value)).join("");
    // Primary product commands lead.
    expect(help).toContain("morrow ask");
    expect(help).toContain("morrow mission");
    expect(help).toContain("morrow plan");
    expect(help).toContain("morrow fix");
    expect(help).toContain("morrow resume");
    expect(help).toContain("morrow onboard");
    expect(help).toContain("morrow auth");
    expect(help).toContain("morrow acceptance");
    expect(help).not.toContain("morrow open");
    expect(help).not.toContain("browser");
    // Advanced/admin commands are de-emphasized but discoverable.
    expect(help).toContain("projects");
    expect(help).not.toContain("completion");
  });

  it("lists every real interactive session command, generated from the palette registry (KNOWN_ISSUES #14)", async () => {
    await expect(run(["--help"])).resolves.toBe(0);
    const help = stdout.mock.calls.map(([value]) => String(value)).join("");
    // Previously hard-coded and out of sync with commands.ts — /tasks and
    // /stats existed in the interactive palette but were missing here.
    expect(help).toContain("/tasks");
    expect(help).toContain("/stats");
  });

  it("prints package version without contacting service", async () => {
    await expect(run(["--version"])).resolves.toBe(0);
    expect(stdout.mock.calls.map(([value]) => String(value)).join("")).toContain("0.1.0-beta.30");
  });

  it("reports a corrupt config as JSON instead of failing before doctor starts", async () => {
    const oldHome = process.env.MORROW_HOME;
    const home = mkdtempSync(join(tmpdir(), "morrow-doctor-config-test-"));
    process.env.MORROW_HOME = home;
    writeFileSync(join(home, "config.json"), '{"providerKey":"must-not-leak",');
    try {
      await expect(run(["doctor", "--json"])).resolves.toBe(2);
      const raw = stdout.mock.calls.map(([value]) => String(value)).join("");
      const payload = JSON.parse(raw);
      expect(payload.ok).toBe(false);
      expect(payload.checks).toContainEqual(expect.objectContaining({ name: "config", ok: false, critical: true }));
      expect(raw).not.toContain("must-not-leak");
      expect(stderr.mock.calls).toHaveLength(0);
    } finally {
      if (oldHome === undefined) delete process.env.MORROW_HOME;
      else process.env.MORROW_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("treats plain text input as an implicit one-shot prompt", () => {
    expect(resolveInvocation(["Explain", "this", "repository"])).toEqual({
      kind: "prompt",
      prompt: "Explain this repository",
    });
  });

  it("treats bare morrow as interactive chat entry", () => {
    expect(resolveInvocation([])).toEqual({ kind: "interactive" });
  });

  it("recognizes lifecycle commands instead of routing them into chat", () => {
    for (const command of ["start", "stop", "restart", "status", "doctor", "uninstall"]) {
      expect(resolveInvocation([command])).toEqual({ kind: "command", root: command, sub: undefined, args: [] });
    }
    expect(resolveInvocation(["install-now"])).toEqual({ kind: "command", root: "install-now", sub: undefined, args: [] });
    expect(resolveInvocation(["repair:paths"])).toEqual({ kind: "command", root: "repair:paths", sub: undefined, args: [] });
  });

  it("treats run as an explicit one-shot alias", () => {
    expect(resolveInvocation(["run", "Return", "JSON"])).toEqual({
      kind: "prompt",
      prompt: "Return JSON",
    });
  });

  it("does not expose open as a browser command", () => {
    expect(resolveInvocation(["open"])).toEqual({ kind: "prompt", prompt: "open" });
  });

  it("treats sessions as a top-level command alias", () => {
    expect(resolveInvocation(["sessions"])).toEqual({
      kind: "command",
      root: "sessions",
      sub: undefined,
      args: [],
    });
  });

  it("treats mission as the primary terminal Mission Control command", () => {
    expect(resolveInvocation(["mission"])).toEqual({
      kind: "command",
      root: "mission",
      sub: undefined,
      args: [],
    });
    expect(resolveInvocation(["mission", "fix", "the", "tests"])).toEqual({
      kind: "command",
      root: "mission",
      sub: "fix",
      args: ["the", "tests"],
    });
  });

  it("treats session subcommands as a top-level alias", () => {
    expect(resolveInvocation(["session", "show", "abc123"])).toEqual({
      kind: "command",
      root: "session",
      sub: "show",
      args: ["abc123"],
    });
  });

  it("treats resume as a top-level command alias", () => {
    expect(resolveInvocation(["resume", "abc123"])).toEqual({
      kind: "command",
      root: "resume",
      sub: "abc123",
      args: [],
    });
  });

  it("exposes uninstall help without starting chat", async () => {
    await expect(run(["uninstall", "--help"])).resolves.toBe(0);
    const help = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(help).toContain("Morrow uninstall");
    expect(help).toContain("--purge-data");
    expect(help).not.toContain("provider/model");
  });

  it("exposes cortex help without starting the service", async () => {
    await expect(run(["cortex", "--help"])).resolves.toBe(0);
    const help = stdout.mock.calls.map(([value]) => String(value)).join("");
    const err = stderr.mock.calls.map(([value]) => String(value)).join("");
    expect(help).toContain("morrow cortex status");
    expect(help).toContain("morrow cortex refresh");
    expect(err).not.toContain("Morrow is ready");
  });

  it("exposes mission help without opening Mission Control", async () => {
    await expect(run(["mission", "--help"])).resolves.toBe(0);
    const help = stdout.mock.calls.map(([value]) => String(value)).join("");
    const err = stderr.mock.calls.map(([value]) => String(value)).join("");
    expect(help).toContain("morrow mission list");
    expect(help).toContain("morrow mission failures");
    expect(err).not.toContain("Morrow is ready");
  });

  it("exposes acceptance help without onboarding or starting the service", async () => {
    await expect(run(["acceptance", "--help"])).resolves.toBe(0);
    const help = stdout.mock.calls.map(([value]) => String(value)).join("");
    expect(help).toContain("morrow acceptance run");
    expect(help).toContain("morrow acceptance resume");
    expect(help).toContain("morrow acceptance report");
  });

  it("exposes a dry-run uninstall that removes launcher/app surfaces while preserving data by default", async () => {
    const oldHome = process.env.MORROW_HOME;
    const home = mkdtempSync(join(tmpdir(), "morrow-uninstall-test-"));
    process.env.MORROW_HOME = home;
    try {
      await expect(run(["uninstall", "--dry-run", "--json"])).resolves.toBe(0);
      const payload = JSON.parse(stdout.mock.calls.map(([value]) => String(value)).join(""));
      expect(payload.choices).toMatchObject({
        removeApp: true,
        removePath: true,
        removeShortcuts: true,
        removeConfig: false,
        removeDatabase: false,
        removeLogs: false,
        removeCache: false,
        removeBackups: false,
        dryRun: true,
      });
      expect(payload.dataDirectory).toBe(home);
      expect(payload.targets.map((target: { label: string }) => target.label)).toContain("Application files");
    } finally {
      if (oldHome === undefined) delete process.env.MORROW_HOME;
      else process.env.MORROW_HOME = oldHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
