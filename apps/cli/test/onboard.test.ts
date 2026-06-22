import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/config/config.js";
import { Context } from "../src/cli/context.js";
import { Output } from "../src/cli/output.js";
import { onboardCommand } from "../src/commands/onboard.js";
import { EXIT } from "../src/cli/errors.js";

// Mock common interactive prompt functions
vi.mock("../src/commands/common.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    ask: vi.fn(),
    askSecret: vi.fn(),
    confirm: vi.fn(),
    select: vi.fn(),
    validateDirectory: vi.fn((p) => p),
  };
});

// Mock lifecycle
vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    ensureRunning: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn().mockResolvedValue(true),
  };
});

// Mock os homedir to isolate tests from host filesystem
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    homedir: () => "/mock/home",
  };
});

import { ask, confirm, select, askSecret } from "../src/commands/common.js";

describe("CLI Onboarding Command", () => {
  const tempRoots: string[] = [];
  let config: ConfigStore;
  let ctx: Context;
  let stdoutWrite: any;

  beforeEach(() => {
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const home = mkdtempSync(join(tmpdir(), "morrow-cli-onboard-test-"));
    tempRoots.push(home);

    config = ConfigStore.load({ MORROW_HOME: home }, home);
    const out = new Output({ json: false, quiet: false, color: false });
    ctx = new Context({ out, config, paths: config.paths, flags: {} });

    // Mock API client calls
    ctx.api = () => ({
      health: vi.fn().mockResolvedValue({ ok: true }),
      listProjects: vi.fn().mockResolvedValue([]),
      getProject: vi.fn().mockResolvedValue({ id: "p1", name: "Test Project", workspacePath: "/test" }),
      createProject: vi.fn().mockResolvedValue({ id: "p1", name: "Test Project", workspacePath: "/test" }),
      listProviders: vi.fn().mockResolvedValue([
        { id: "openai", label: "OpenAI", configured: false, capabilities: {}, authStatus: "missing", models: [] }
      ]),
      testProvider: vi.fn().mockResolvedValue({ ok: true, latencyMs: 120 }),
      getOnboardingState: vi.fn().mockResolvedValue({ onboarded: false, onboardingStep: null }),
      saveOnboardingState: vi.fn().mockResolvedValue({ success: true }),
      resetOnboardingState: vi.fn().mockResolvedValue({ success: true }),
      createConversation: vi.fn().mockResolvedValue({ id: "c1", projectId: "p1", title: "First Mission" }),
    } as any);
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("subcommand reset unsets config values", async () => {
    config.set("user.onboarded", "true", "user");
    config.set("user.name", "Aidan", "user");
    config.set("user.useCase", "Development", "user");

    const exitCode = await onboardCommand(ctx, "reset", []);
    expect(exitCode).toBe(EXIT.OK);

    expect(config.get("user.onboarded")).toBeUndefined();
    expect(config.get("user.name")).toBeUndefined();
    expect(config.get("user.useCase")).toBeUndefined();
  });

  it("subcommand status prints details", async () => {
    config.set("user.onboarded", "true", "user");
    config.set("user.name", "Aidan", "user");
    config.set("user.onboardingStep", "complete", "user");

    const exitCode = await onboardCommand(ctx, "status", []);
    expect(exitCode).toBe(EXIT.OK);

    const output = stdoutWrite.mock.calls.map(([val]: any) => String(val)).join("");
    expect(output).toContain("Onboarded");
    expect(output).toContain("Aidan");
  });

  it("completes full guided flow step-by-step and persists selections", async () => {
    // welcome: press enter
    vi.mocked(ask).mockResolvedValueOnce("");
    // profile: enter name
    vi.mocked(ask).mockResolvedValueOnce("Alex");
    // use case: select development (index 0)
    vi.mocked(select).mockResolvedValueOnce(0);
    // provider setup: select skip (index 4)
    vi.mocked(select).mockResolvedValueOnce(4);
    // agent mode: select Agent (index 2)
    vi.mocked(select).mockResolvedValueOnce(2);
    // skills selection: select enable all (index 0)
    vi.mocked(select).mockResolvedValueOnce(0);
    // project registration: select custom (index 0 for custom path if no repos, else skip/custom)
    // Let's mock discovered repos list as empty, so choice 0 is Add custom, 1 is Skip
    vi.mocked(select).mockResolvedValueOnce(1); // skip project
    // mission: select finish (index 4)
    vi.mocked(select).mockResolvedValueOnce(4);

    const exitCode = await onboardCommand(ctx, "", []);
    expect(exitCode).toBe(EXIT.OK);

    expect(config.get("user.onboarded")).toBe(true);
    expect(config.get("user.name")).toBe("Alex");
    expect(config.get("user.useCase")).toBe("Software Development");
    expect(config.get("defaults.mode")).toBe("agent");
  });

  it("supports resuming onboarding from an interrupted step", async () => {
    config.set("user.onboardingStep", "mode", "user");
    // confirm resume setup -> Yes
    vi.mocked(confirm).mockResolvedValueOnce(true);
    // agent mode selection: Plan-only (index 0)
    vi.mocked(select).mockResolvedValueOnce(0);
    // skills selection: skip (index 2)
    vi.mocked(select).mockResolvedValueOnce(2);
    // project registration: skip (index 1)
    vi.mocked(select).mockResolvedValueOnce(1);
    // mission: finish (index 4)
    vi.mocked(select).mockResolvedValueOnce(4);

    const exitCode = await onboardCommand(ctx, "", []);
    expect(exitCode).toBe(EXIT.OK);

    expect(config.get("user.onboarded")).toBe(true);
    expect(config.get("defaults.mode")).toBe("plan-only");
  });

  it("handles provider validation failure and allows retry", async () => {
    config.set("user.onboardingStep", "provider", "user");
    vi.mocked(confirm).mockResolvedValueOnce(true); // resume

    // Select OpenAI provider (index 0)
    vi.mocked(select).mockResolvedValueOnce(0);
    // Enter key
    vi.mocked(askSecret).mockResolvedValueOnce("sk-invalid-key");
    
    // Mock testProvider failure
    const testMock = vi.fn().mockResolvedValue({ ok: false, detail: "API key invalid" });
    ctx.api = () => ({
      listProviders: vi.fn().mockResolvedValue([
        { id: "openai", label: "OpenAI", configured: false, capabilities: {}, authStatus: "missing", models: [] }
      ]),
      testProvider: testMock,
      saveOnboardingState: vi.fn().mockResolvedValue({ success: true }),
    } as any);

    // Prompted to keep key anyway? -> No
    vi.mocked(confirm).mockResolvedValueOnce(false);
    // select Skip to exit provider loop (index 4)
    vi.mocked(select).mockResolvedValueOnce(4);

    // mode selection: Plan-only (index 0)
    vi.mocked(select).mockResolvedValueOnce(0);
    // skills selection: skip (index 2)
    vi.mocked(select).mockResolvedValueOnce(2);
    // project registration: skip (index 1)
    vi.mocked(select).mockResolvedValueOnce(1);
    // mission: finish (index 4)
    vi.mocked(select).mockResolvedValueOnce(4);

    const exitCode = await onboardCommand(ctx, "", []);
    expect(exitCode).toBe(EXIT.OK);
    expect(testMock).toHaveBeenCalledWith("openai");
  });
});
