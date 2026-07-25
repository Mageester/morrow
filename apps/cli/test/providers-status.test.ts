import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderStatus } from "@morrow/contracts";
import { ConfigStore } from "../src/config/config.js";
import { Context } from "../src/cli/context.js";
import { Output } from "../src/cli/output.js";
import { providersCommand } from "../src/commands/providers.js";

vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ensureRunning: vi.fn(), isRunning: vi.fn().mockResolvedValue(true) };
});

function provider(over: Partial<ProviderStatus> & { id: string }): ProviderStatus {
  return {
    version: 1, label: over.id, kind: "api-key", configured: false, available: false,
    endpointType: "default", endpointHost: null, authStatus: "missing",
    capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: false, customEndpoint: true, local: false },
    models: [], defaultModel: null, note: null,
    setupHint: "Set SOME_API_KEY (and optionally SOME_BASE_URL for a compatible gateway).",
    ...over,
  } as ProviderStatus;
}

describe("morrow providers status", () => {
  const roots: string[] = [];
  let ctx: Context;
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation((v: any) => { out.push(String(v)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((v: any) => { out.push(String(v)); return true; });
    const home = mkdtempSync(join(tmpdir(), "morrow-pstatus-"));
    roots.push(home);
    const config = ConfigStore.load({ MORROW_HOME: home }, home);
    ctx = new Context({ out: new Output({ json: false, quiet: false, color: false }), config, paths: config.paths, flags: {} });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  const withProviders = (list: ProviderStatus[]) => {
    ctx.api = () => ({ listProviders: vi.fn().mockResolvedValue(list) }) as any;
  };

  /**
   * This command answered "here is every provider and the environment variable
   * that configures it", printing all 30 with setup instructions. On a fresh
   * install that was a 60-line lecture at a user who has a guided
   * `providers configure` command one keystroke away.
   */
  it("does not print every provider's setup instructions when nothing is connected", async () => {
    withProviders([provider({ id: "openai" }), provider({ id: "groq" }), provider({ id: "lmstudio" })]);

    await providersCommand(ctx, "status", []);
    const text = out.join("");

    expect(text).toMatch(/No provider is connected yet/);
    expect(text).toMatch(/3 providers are available/);
    expect(text).toMatch(/morrow providers configure/);
    // The env-var lecture is gone.
    expect(text).not.toMatch(/SOME_API_KEY/);
  });

  it("reports what is actually connected, with its model and endpoint", async () => {
    withProviders([
      provider({ id: "opencode-zen", label: "OpenCode Zen", configured: true, available: true, defaultModel: "big-pickle", endpointHost: "opencode.ai" }),
      provider({ id: "groq", label: "Groq" }),
    ]);

    await providersCommand(ctx, "status", []);
    const text = out.join("");

    expect(text).toMatch(/OpenCode Zen/);
    expect(text).toMatch(/big-pickle/);
    expect(text).toMatch(/opencode\.ai/);
    expect(text).toMatch(/1 more available/);
  });

  it("flags a connected provider that still has no model chosen", async () => {
    withProviders([provider({ id: "groq", label: "Groq", configured: true, available: true, defaultModel: null })]);

    await providersCommand(ctx, "status", []);

    expect(out.join("")).toMatch(/No default model selected/);
  });

  it("hides internal providers a person cannot choose", async () => {
    withProviders([
      provider({ id: "mock", label: "Mock provider", configured: true }),
      provider({ id: "deterministic-local", label: "Local", configured: true }),
      provider({ id: "groq", label: "Groq" }),
    ]);

    await providersCommand(ctx, "status", []);
    const text = out.join("");

    expect(text).not.toMatch(/Mock provider/);
    expect(text).toMatch(/No provider is connected yet/);
    expect(text).toMatch(/1 providers? are available/);
  });
});
