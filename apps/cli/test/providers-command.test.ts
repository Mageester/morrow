import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/service/lifecycle.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ensureRunning: vi.fn() };
});

vi.mock("../src/commands/common.js", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, ask: vi.fn(), askSecret: vi.fn(), confirm: vi.fn() };
});

import { Output } from "../src/cli/output.js";
import { providersCommand } from "../src/commands/providers.js";
import { ask, confirm } from "../src/commands/common.js";
import { EXIT } from "../src/cli/errors.js";

describe("morrow providers login/logout (Codex OAuth)", () => {
  let printed: string[];

  beforeEach(() => {
    printed = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: any) => {
      printed.push(String(chunk));
      return true;
    }) as any);
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: any) => {
      printed.push(String(chunk));
      return true;
    }) as any);
    vi.mocked(ask).mockReset();
    vi.mocked(confirm).mockReset();
  });

  afterEach(() => vi.restoreAllMocks());

  function ctx(api: Record<string, unknown>, flags: Record<string, string | boolean> = {}, json = false) {
    return {
      flags,
      out: new Output({ json, quiet: false, color: false }),
      config: { get: () => undefined },
      api: () => api,
    } as any;
  }

  const OAUTH_FINDING = {
    id: "codex-oauth",
    label: "Codex / ChatGPT OAuth (OpenAI)",
    status: "available",
    reason: "Subscription sign-in is available via the Codex CLI's first-party OAuth client and PKCE.",
    recommendation: "Sign in below, or use the OpenAI provider with an API key.",
    documentationUrl: "https://platform.openai.com/docs/api-reference/authentication",
  };

  function fakeApi(overrides: Record<string, unknown> = {}) {
    return {
      listOAuth: vi.fn(async () => [OAUTH_FINDING]),
      oauthStatus: vi.fn(async () => [
        { id: "openai", label: "Codex / ChatGPT (OpenAI)", providerId: "openai", status: "disconnected", expiresAt: null, scope: null, warning: "" },
      ]),
      startOAuthLogin: vi.fn(async () => ({ authorizeUrl: "https://auth.openai.com/oauth/authorize?state=abc", redirectUri: "http://localhost:1455/auth/callback", manual: true })),
      completeOAuthLogin: vi.fn(async () => ({
        id: "openai",
        label: "Codex / ChatGPT (OpenAI)",
        providerId: "openai",
        status: "connected",
        expiresAt: "2026-08-01T00:00:00.000Z",
        scope: "openid profile email offline_access",
        warning: "",
      })),
      oauthLogout: vi.fn(async () => ({ ok: true, provider: "openai" })),
      ...overrides,
    };
  }

  it("signs in to Codex via `providers login codex`, resolving the alias to openai", async () => {
    const api = fakeApi();
    vi.mocked(ask).mockResolvedValue("pasted-auth-code");
    const code = await providersCommand(ctx(api), "login", ["codex"]);
    expect(code).toBe(EXIT.OK);
    expect(api.startOAuthLogin).toHaveBeenCalledWith("openai");
    expect(api.completeOAuthLogin).toHaveBeenCalledWith("openai", "pasted-auth-code");
    expect(printed.join("")).toContain("auth.openai.com/oauth/authorize");
    expect(printed.join("")).toContain("Signed in to Codex / ChatGPT (OpenAI)");
  });

  it("accepts a --code flag without prompting", async () => {
    const api = fakeApi();
    const code = await providersCommand(ctx(api, { code: "flag-code" }), "login", ["codex"]);
    expect(code).toBe(EXIT.OK);
    expect(ask).not.toHaveBeenCalled();
    expect(api.completeOAuthLogin).toHaveBeenCalledWith("openai", "flag-code");
  });

  it("also resolves the bare provider id `openai`", async () => {
    const api = fakeApi();
    vi.mocked(ask).mockResolvedValue("pasted-auth-code");
    await providersCommand(ctx(api), "login", ["openai"]);
    expect(api.startOAuthLogin).toHaveBeenCalledWith("openai");
  });

  it("rejects login for a provider with no OAuth support", async () => {
    const api = fakeApi();
    await expect(providersCommand(ctx(api), "login", ["gemini"])).rejects.toThrow(/does not support subscription sign-in/);
    expect(api.startOAuthLogin).not.toHaveBeenCalled();
  });

  it("requires a provider argument", async () => {
    const api = fakeApi();
    await expect(providersCommand(ctx(api), "login", [])).rejects.toThrow(/Usage: morrow providers login/);
  });

  it("signs out via `providers logout claude`, resolving to anthropic", async () => {
    const api = fakeApi();
    const code = await providersCommand(ctx(api), "logout", ["claude"]);
    expect(code).toBe(EXIT.OK);
    expect(api.oauthLogout).toHaveBeenCalledWith("anthropic");
    expect(printed.join("")).toContain("Signed out of Claude (Anthropic)");
  });

  it("lists live sign-in status alongside the honest OAuth findings", async () => {
    const api = fakeApi({
      listProviders: vi.fn(async () => []),
      oauthStatus: vi.fn(async () => [
        { id: "openai", label: "Codex / ChatGPT (OpenAI)", providerId: "openai", status: "connected", expiresAt: "2026-08-01T00:00:00.000Z", scope: null, warning: "" },
      ]),
    });
    const code = await providersCommand(ctx(api), "list", []);
    expect(code).toBe(EXIT.OK);
    const output = printed.join("");
    expect(output).toContain("signed in");
    expect(output).toContain("morrow providers logout openai");
  });
});
