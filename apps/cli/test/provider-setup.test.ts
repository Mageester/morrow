import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderStatus } from "@morrow/contracts";
import { ConfigStore } from "../src/config/config.js";
import { Context } from "../src/cli/context.js";
import { Output } from "../src/cli/output.js";

vi.mock("../src/commands/common.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ask: vi.fn(), askSecret: vi.fn(), confirm: vi.fn(), select: vi.fn() };
});

vi.mock("../src/commands/provider-oauth.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, oauthLogin: vi.fn().mockResolvedValue(0), openBrowser: vi.fn() };
});

import { ask, askSecret, confirm, select } from "../src/commands/common.js";
import { oauthLogin, openBrowser } from "../src/commands/provider-oauth.js";
import {
  describeProvider,
  pickProvider,
  printCatalog,
  searchProviders,
  setupProvider,
  supportsOAuth,
} from "../src/commands/provider-setup.js";

function providerStatus(over: Partial<ProviderStatus> & { id: string }): ProviderStatus {
  return {
    version: 1,
    label: over.id,
    kind: "api-key",
    configured: false,
    available: false,
    endpointType: "default",
    endpointHost: null,
    authStatus: "missing",
    capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: false, customEndpoint: true, local: false },
    models: [],
    defaultModel: null,
    note: null,
    setupHint: null,
    ...over,
  } as ProviderStatus;
}

const ZEN = providerStatus({
  id: "opencode-zen",
  label: "OpenCode Zen",
  category: "gateway",
  keyUrl: "https://opencode.ai/auth",
  supportsOAuth: false,
  hasFreeTier: true,
  note: "Curated model gateway from the OpenCode project, including a free tier.",
});
const ANTHROPIC = providerStatus({ id: "anthropic", label: "Anthropic", category: "assistant", supportsOAuth: true });
const LMSTUDIO = providerStatus({
  id: "lmstudio",
  label: "LM Studio (local)",
  category: "local",
  kind: "local",
  capabilities: { streaming: true, toolCalls: true, systemMessages: true, vision: false, customEndpoint: true, local: true },
});

describe("Guided provider setup", () => {
  const tempRoots: string[] = [];
  let ctx: Context;
  let stdout: string[];

  beforeEach(() => {
    stdout = [];
    // Capture both streams: `print` goes to stdout while `info`/`warn` are
    // diagnostics on stderr, and these assertions are about what the user sees.
    vi.spyOn(process.stdout, "write").mockImplementation((v: any) => { stdout.push(String(v)); return true; });
    vi.spyOn(process.stderr, "write").mockImplementation((v: any) => { stdout.push(String(v)); return true; });
    const home = mkdtempSync(join(tmpdir(), "morrow-provider-setup-"));
    tempRoots.push(home);
    const config = ConfigStore.load({ MORROW_HOME: home }, home);
    ctx = new Context({ out: new Output({ json: false, quiet: false, color: false }), config, paths: config.paths, flags: {} });
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const api = (over: Record<string, any> = {}) =>
    ({
      listProviders: vi.fn().mockResolvedValue([ANTHROPIC, ZEN, LMSTUDIO]),
      configureProvider: vi.fn().mockResolvedValue({ written: [], securePermissions: true, shadowedByEnv: [] }),
      removeProviderCredentials: vi.fn().mockResolvedValue({ removed: [] }),
      testProvider: vi.fn().mockResolvedValue({ ok: true, latencyMs: 10, errorKind: null, models: [] }),
      ...over,
    }) as any;

  describe("catalog presentation", () => {
    it("groups providers under readable headings instead of a flat id list", () => {
      printCatalog(ctx, [ANTHROPIC, ZEN, LMSTUDIO]);
      const text = stdout.join("");
      expect(text).toContain("Major assistants");
      expect(text).toContain("Gateways (one key, many models)");
      expect(text).toContain("Local (nothing leaves your machine)");
      expect(text).toContain("OpenCode Zen");
    });

    it("marks the ways a provider can be paid for and signed into", () => {
      expect(describeProvider(ctx, ANTHROPIC)).toContain("subscription sign-in");
      expect(describeProvider(ctx, ZEN)).toContain("free tier");
      expect(describeProvider(ctx, ZEN)).not.toContain("subscription sign-in");
      expect(describeProvider(ctx, LMSTUDIO)).toContain("local");
    });

    it("hides internal testing providers from the catalog", () => {
      const mock = providerStatus({ id: "mock", label: "Mock provider", category: "testing" });
      printCatalog(ctx, [ZEN, mock]);
      expect(stdout.join("")).not.toContain("Mock provider");
    });

    it("searches across id, label, and description", () => {
      expect(searchProviders([ANTHROPIC, ZEN, LMSTUDIO], "zen").map((s) => s.id)).toEqual(["opencode-zen"]);
      expect(searchProviders([ANTHROPIC, ZEN, LMSTUDIO], "LM Studio").map((s) => s.id)).toEqual(["lmstudio"]);
      expect(searchProviders([ANTHROPIC, ZEN, LMSTUDIO], "gateway").map((s) => s.id)).toEqual(["opencode-zen"]);
    });

    it("reports subscription sign-in only where a real flow exists", () => {
      expect(supportsOAuth(ANTHROPIC)).toBe(true);
      // OpenCode Zen is API-key only per its official docs; the picker must not
      // offer a sign-in that does not exist.
      expect(supportsOAuth(ZEN)).toBe(false);
    });
  });

  describe("choosing a provider", () => {
    it("selects an exact name match without a disambiguation prompt", async () => {
      vi.mocked(ask).mockResolvedValueOnce("opencode-zen");
      expect((await pickProvider(ctx, api()))!.id).toBe("opencode-zen");
      expect(select).not.toHaveBeenCalled();
    });

    it("returns null when the user presses Enter to move on", async () => {
      vi.mocked(ask).mockResolvedValueOnce("");
      expect(await pickProvider(ctx, api())).toBeNull();
    });

    it("re-prompts instead of failing when nothing matches", async () => {
      vi.mocked(ask).mockResolvedValueOnce("nonsense-provider").mockResolvedValueOnce("");
      expect(await pickProvider(ctx, api())).toBeNull();
      expect(vi.mocked(ask)).toHaveBeenCalledTimes(2);
    });
  });

  describe("credential handling", () => {
    it("persists through the service before verifying, never by writing the file itself", async () => {
      const order: string[] = [];
      const configureProvider = vi.fn(async () => { order.push("configure"); return { written: ["OPENCODE_ZEN_API_KEY"], securePermissions: true, shadowedByEnv: [] }; });
      const testProvider = vi.fn(async () => { order.push("test"); return { ok: true, latencyMs: 5, errorKind: null, models: [] }; });
      vi.mocked(askSecret).mockResolvedValueOnce("zen-key");
      vi.mocked(confirm).mockResolvedValue(false); // decline "open key page"

      const result = await setupProvider(ctx, api({ configureProvider, testProvider }), ZEN, { interactive: true });

      expect(result.ok).toBe(true);
      expect(configureProvider).toHaveBeenCalledWith("opencode-zen", { apiKey: "zen-key" });
      expect(order).toEqual(["configure", "test"]);
    });

    it("offers to open the provider's key page", async () => {
      vi.mocked(confirm).mockResolvedValueOnce(true);
      vi.mocked(askSecret).mockResolvedValueOnce("zen-key");
      await setupProvider(ctx, api(), ZEN, { interactive: true });
      expect(openBrowser).toHaveBeenCalledWith("https://opencode.ai/auth");
    });

    it("prefers subscription sign-in when the provider really supports it", async () => {
      vi.mocked(confirm).mockResolvedValueOnce(true); // yes, sign in
      const result = await setupProvider(ctx, api(), ANTHROPIC, { interactive: true });
      expect(oauthLogin).toHaveBeenCalledWith(ctx, expect.anything(), "anthropic");
      expect(askSecret).not.toHaveBeenCalled();
      expect(result.ok).toBe(true);
    });

    it("falls back to an API key when sign-in fails", async () => {
      vi.mocked(oauthLogin).mockRejectedValueOnce(new Error("browser unavailable"));
      vi.mocked(confirm)
        .mockResolvedValueOnce(true)  // try sign-in
        .mockResolvedValueOnce(true)  // yes, use a key instead
        .mockResolvedValue(false);
      vi.mocked(askSecret).mockResolvedValueOnce("ant-key");

      const configureProvider = vi.fn().mockResolvedValue({ written: [], securePermissions: true, shadowedByEnv: [] });
      const result = await setupProvider(ctx, api({ configureProvider }), ANTHROPIC, { interactive: true });

      expect(configureProvider).toHaveBeenCalledWith("anthropic", { apiKey: "ant-key" });
      expect(result.ok).toBe(true);
    });

    it("skips OAuth entirely when an explicit key is supplied", async () => {
      await setupProvider(ctx, api(), ANTHROPIC, { apiKey: "explicit", interactive: true });
      expect(oauthLogin).not.toHaveBeenCalled();
    });

    it("removes an unverified credential when the user declines to keep it", async () => {
      const removeProviderCredentials = vi.fn().mockResolvedValue({ removed: ["OPENCODE_ZEN_API_KEY"] });
      const testProvider = vi.fn().mockResolvedValue({ ok: false, detail: "HTTP 401", errorKind: "auth", models: [] });
      vi.mocked(askSecret).mockResolvedValueOnce("bad-key");
      vi.mocked(confirm).mockResolvedValue(false); // no browser, and no "keep anyway"

      const result = await setupProvider(ctx, api({ testProvider, removeProviderCredentials }), ZEN, { interactive: true });

      expect(result.ok).toBe(false);
      expect(removeProviderCredentials).toHaveBeenCalledWith("opencode-zen");
      // The user is told what to do about an auth rejection, not just that it failed.
      expect(stdout.join("")).toMatch(/rejected the credential/i);
    });

    it("refuses clearly instead of blocking on stdin when not interactive", async () => {
      const configureProvider = vi.fn();
      const result = await setupProvider(ctx, api({ configureProvider }), ZEN, { interactive: false });
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/--key/);
      expect(configureProvider).not.toHaveBeenCalled();
      expect(askSecret).not.toHaveBeenCalled();
    });

    it("treats a local server's key as optional and asks for its URL", async () => {
      vi.mocked(ask).mockResolvedValueOnce("http://127.0.0.1:1234/v1");
      vi.mocked(askSecret).mockResolvedValueOnce(""); // no key, that is fine
      const configureProvider = vi.fn().mockResolvedValue({ written: [], securePermissions: true, shadowedByEnv: [] });

      const result = await setupProvider(ctx, api({ configureProvider }), LMSTUDIO, { interactive: true });

      expect(result.ok).toBe(true);
      expect(configureProvider).toHaveBeenCalledWith("lmstudio", { baseUrl: "http://127.0.0.1:1234/v1" });
    });
  });

  describe("model selection", () => {
    it("offers the models the credential can actually reach and saves the choice", async () => {
      const testProvider = vi.fn().mockResolvedValue({
        ok: true, latencyMs: 8, errorKind: null,
        models: [{ providerModelId: "big-pickle" }, { providerModelId: "gpt-5.5" }],
      });
      const configureProvider = vi.fn().mockResolvedValue({ written: [], securePermissions: true, shadowedByEnv: [] });
      vi.mocked(askSecret).mockResolvedValueOnce("zen-key");
      vi.mocked(confirm).mockResolvedValue(false);
      vi.mocked(select).mockResolvedValueOnce(1);

      const result = await setupProvider(ctx, api({ testProvider, configureProvider }), ZEN, { interactive: true });

      const offered = vi.mocked(select).mock.calls[0]![2] as Array<{ id: string }>;
      expect(offered.map((o) => o.id)).toEqual(["big-pickle", "gpt-5.5", ""]);
      expect(result.model).toBe("gpt-5.5");
      expect(configureProvider).toHaveBeenLastCalledWith("opencode-zen", { model: "gpt-5.5" });
    });

    it("succeeds without a model when the endpoint publishes no model list", async () => {
      const testProvider = vi.fn().mockResolvedValue({ ok: true, latencyMs: 8, errorKind: null, models: [] });
      vi.mocked(askSecret).mockResolvedValueOnce("zen-key");
      vi.mocked(confirm).mockResolvedValue(false);

      const result = await setupProvider(ctx, api({ testProvider }), ZEN, { interactive: true });

      expect(result.ok).toBe(true);
      expect(result.model).toBeUndefined();
      expect(select).not.toHaveBeenCalled();
      expect(stdout.join("")).toMatch(/did not publish a model list/i);
    });
  });
});
