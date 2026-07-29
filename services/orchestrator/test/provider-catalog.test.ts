import { describe, it, expect } from "vitest";
import { ProviderIdSchema, ProviderStatusSchema } from "@morrow/contracts";
import { PROVIDER_CATALOG, catalogProvider, CATALOG_PROVIDER_IDS } from "../src/provider/catalog.js";
import { createProvider, getProviderStatus, listProviderStatuses, PROVIDER_IDS } from "../src/provider/registry.js";
import { providerEnvMapping } from "../src/provider/secrets.js";
import { testProviderConnectivity } from "../src/provider/connectivity.js";
import { routePreset } from "../src/routing/router.js";
import { createServer } from "node:http";

/**
 * The catalog is the single source of truth for OpenAI-compatible providers.
 * These tests hold the four derived surfaces (contracts enum, registry,
 * secrets mapping, connectivity planner) in sync so a provider can never be
 * half-added — configurable but unroutable, or routable but untestable.
 */
describe("Provider catalog", () => {
  it("declares every catalog id in the shared contracts enum", () => {
    for (const id of CATALOG_PROVIDER_IDS) {
      expect(() => ProviderIdSchema.parse(id)).not.toThrow();
    }
  });

  it("exposes every catalog provider through the registry", () => {
    for (const id of CATALOG_PROVIDER_IDS) {
      expect(PROVIDER_IDS).toContain(id);
    }
  });

  it("gives every catalog provider a complete, unique env mapping", () => {
    const seen = new Map<string, string>();
    for (const p of PROVIDER_CATALOG) {
      const mapping = providerEnvMapping(p.id);
      expect(mapping, `${p.id} has no env mapping`).toBeTruthy();
      expect(mapping!.baseUrlEnv).toBe(p.baseUrlEnv);
      expect(mapping!.modelEnv).toBe(p.modelEnv);
      expect(mapping!.contextLimitEnv).toBe(p.contextLimitEnv);
      // Hosted providers always need a key. A local server is configured by
      // URL, but may optionally declare one (vLLM can be started with
      // --api-key), so the mapping just has to match the catalog.
      expect(mapping!.apiKeyEnv).toBe(p.apiKeyEnv);
      if (!p.local) expect(mapping!.apiKeyEnv).toBeTruthy();

      // Two providers sharing an env var would let one silently configure the
      // other, so every env name must belong to exactly one provider.
      for (const name of [p.apiKeyEnv, p.fallbackApiKeyEnv, p.baseUrlEnv, p.modelEnv, p.contextLimitEnv]) {
        if (!name) continue;
        expect(seen.has(name), `${name} is claimed by both ${seen.get(name)} and ${p.id}`).toBe(false);
        seen.set(name, p.id);
      }
    }
  });

  it("uses an https endpoint for every hosted provider and loopback for every local one", () => {
    for (const p of PROVIDER_CATALOG) {
      const url = new URL(p.defaultBaseUrl);
      if (p.local) {
        expect(["127.0.0.1", "localhost"], `${p.id} local default must be loopback`).toContain(url.hostname);
      } else {
        expect(url.protocol, `${p.id} must not default to cleartext`).toBe("https:");
        expect(p.apiKeyEnv, `${p.id} is hosted and needs an API key env`).toBeTruthy();
      }
    }
  });

  /**
   * Regression guard. An earlier draft let `github-models` fall back to
   * `GITHUB_TOKEN`, a variable set in almost every CI runner and dev shell for
   * unrelated reasons. That silently marked a hosted network provider as
   * configured — and made it eligible for routing — for users who never opted
   * in. No catalog provider may claim a general-purpose env var.
   */
  it("never treats a general-purpose environment variable as a provider credential", () => {
    const generic = ["GITHUB_TOKEN", "GH_TOKEN", "API_KEY", "TOKEN", "OPENAI_API_KEY", "HOME", "PATH", "USER", "CI"];
    for (const p of PROVIDER_CATALOG) {
      for (const name of [p.apiKeyEnv, p.fallbackApiKeyEnv]) {
        if (name) expect(generic, `${p.id} must not read ${name}`).not.toContain(name);
      }
    }
  });

  it("reports nothing as configured in an empty environment", () => {
    const statuses = listProviderStatuses({});
    for (const id of CATALOG_PROVIDER_IDS) {
      const status = statuses.find((s) => s.id === id)!;
      expect(status, `${id} missing from statuses`).toBeTruthy();
      expect(status.configured, `${id} must not self-configure`).toBe(false);
      expect(status.available).toBe(false);
      // Honest emptiness: no invented model ids before the endpoint is probed.
      expect(status.models).toEqual([]);
      expect(status.defaultModel).toBeNull();
      expect(() => ProviderStatusSchema.parse(status)).not.toThrow();
    }
  });

  it("configures a hosted provider from its own key and builds a routable adapter", () => {
    const env = { OPENCODE_ZEN_API_KEY: "zen-key", OPENCODE_ZEN_MODEL: "some-model" };
    const status = getProviderStatus("opencode-zen", env)!;
    expect(status.configured).toBe(true);
    expect(status.authMode).toBe("catalog-api-key");
    expect(status.endpointHost).toBe("opencode.ai");
    expect(status.defaultModel).toBe("some-model");

    const provider = createProvider("opencode-zen", env);
    expect(provider.id).toBe("opencode-zen");
    expect(provider.route?.endpointHost).toBe("opencode.ai");
  });

  it("accepts the provider's documented alternate key variable", () => {
    // OpenCode's own tooling reads OPENCODE_API_KEY; both names must work.
    expect(getProviderStatus("opencode-zen", { OPENCODE_API_KEY: "zen-key" })!.configured).toBe(true);
  });

  it("honours a custom base URL override", () => {
    const env = { GROQ_API_KEY: "k", GROQ_BASE_URL: "https://proxy.internal/v1", GROQ_MODEL: "m" };
    const status = getProviderStatus("groq", env)!;
    expect(status.endpointType).toBe("custom");
    expect(status.endpointHost).toBe("proxy.internal");
  });

  it("refuses to guess a model instead of sending an empty one", () => {
    // A catalog provider ships no built-in model id. Failing loudly beats
    // sending "" and getting an opaque 400 back from the endpoint.
    expect(() => createProvider("groq", { GROQ_API_KEY: "k" })).toThrow(/requires a model/);
  });

  it("treats a local server as opt-in, not assumed-present", () => {
    expect(getProviderStatus("lmstudio", {})!.configured).toBe(false);
    const status = getProviderStatus("lmstudio", { LMSTUDIO_BASE_URL: "http://127.0.0.1:1234/v1" })!;
    expect(status.configured).toBe(true);
    expect(status.authMode).toBe("catalog-local");
    expect(status.authStatus).toBe("not-applicable");
    expect(status.capabilities.local).toBe(true);
  });

  it("sends a bearer token to a key-protected local server", async () => {
    // vLLM started with --api-key rejects unauthenticated requests, so the key
    // must actually reach the endpoint rather than being dropped because the
    // provider is classified as local.
    const secret = "vllm-local-secret";
    // The probe deliberately makes a second, credential-free request to decide
    // whether the endpoint actually enforces auth, so record every request
    // rather than only the last.
    const seenAuth: Array<string | null> = [];
    const server = createServer((req, res) => {
      seenAuth.push(req.headers.authorization ?? null);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local-llm" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await testProviderConnectivity("vllm", {
        VLLM_BASE_URL: `http://127.0.0.1:${port}/v1`,
        VLLM_API_KEY: secret,
      });
      expect(result.ok).toBe(true);
      expect(seenAuth).toContain(`Bearer ${secret}`);
      expect(result.modelsSample).toContain("local-llm");
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports an unconfigured catalog provider as not-configured rather than unknown", async () => {
    const result = await testProviderConnectivity("cerebras", {});
    expect(result.configured).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.detail).toContain("CEREBRAS_API_KEY");
    expect(result.detail).not.toMatch(/unknown provider/i);
  });

  it("never leaks a key into the connectivity result for a catalog provider", async () => {
    const secret = "sk-should-never-appear";
    const result = await testProviderConnectivity(
      "groq",
      { GROQ_API_KEY: secret, GROQ_BASE_URL: "http://127.0.0.1:9/v1" },
      50
    );
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.configured).toBe(true);
    expect(result.ok).toBe(false); // nothing is listening on port 9
  });

  /**
   * `configured` answers "did the operator supply a credential", and `ok`
   * answers "did this check succeed". Conflating them meant a provider outage,
   * a rate limit, or a flaky network reported the provider as not configured —
   * telling the user to re-enter a key that was never the problem.
   */
  it("keeps reporting a provider as configured when the check fails for other reasons", async () => {
    const unreachable = await testProviderConnectivity(
      "groq",
      { GROQ_API_KEY: "k", GROQ_BASE_URL: "http://127.0.0.1:9/v1" },
      50
    );
    expect(unreachable.ok).toBe(false);
    expect(unreachable.configured, "an unreachable endpoint does not unconfigure a stored key").toBe(true);

    const server = createServer((_req, res) => res.writeHead(500).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const failing = await testProviderConnectivity("groq", {
        GROQ_API_KEY: "k",
        GROQ_BASE_URL: `http://127.0.0.1:${port}/v1`,
      });
      expect(failing.ok).toBe(false);
      expect(failing.configured, "a provider-side 500 does not unconfigure a stored key").toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Genuinely absent credentials are still reported as not configured.
    const missing = await testProviderConnectivity("groq", {});
    expect(missing.configured).toBe(false);
  });

  it("keeps a meaningful number of providers available to users", () => {
    // The point of the catalog is breadth of choice; guard against a refactor
    // silently dropping most of it.
    expect(PROVIDER_CATALOG.length).toBeGreaterThanOrEqual(20);
    expect(catalogProvider("opencode-zen")).toBeTruthy();
    expect(listProviderStatuses({}).length).toBeGreaterThanOrEqual(27);
  });
});

describe("Routing reaches catalog providers", () => {
  /**
   * Presets name a curated set of preferred providers. Before catalog
   * providers could be appended as a fallback, a user whose only configured
   * provider was outside every preset's list — Groq, OpenCode Zen, LM Studio —
   * got "no configured provider" from every preset, leaving a fully configured
   * Morrow unable to run anything.
   */
  it("routes to a configured provider that no preset names", () => {
    const env = { GROQ_API_KEY: "k", GROQ_MODEL: "some-groq-model" };
    const result = routePreset("balanced", env);
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.decision.providerId).toBe("groq");
    expect(result.decision.model).toBe("some-groq-model");
    // Reaching a non-preferred provider is a fallback and must be reported.
    expect(result.decision.fallbackUsed).toBe(true);
  });

  it("still prefers a preset's own providers over an appended one", () => {
    const env = {
      GROQ_API_KEY: "k",
      GROQ_MODEL: "some-groq-model",
      ANTHROPIC_API_KEY: "k",
    };
    const result = routePreset("best-quality", env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.decision.providerId).toBe("anthropic");
    expect(result.decision.fallbackUsed).toBe(false);
  });

  it("lets a local-only preset use any local server, not just Ollama", () => {
    const env = { LMSTUDIO_BASE_URL: "http://127.0.0.1:1234/v1", LMSTUDIO_MODEL: "local-model" };
    const result = routePreset("private-local", env);
    expect(result.ok, result.ok ? "" : result.reason).toBe(true);
    if (!result.ok) return;
    expect(result.decision.providerId).toBe("lmstudio");
    expect(result.decision.privacy).toBe("local-only");
  });

  /**
   * The privacy guarantee is absolute: the fallback must never be able to turn
   * a local-only run into a hosted one, no matter what else is configured.
   */
  it("never appends a hosted provider to a local-only preset", () => {
    const env = { GROQ_API_KEY: "k", GROQ_MODEL: "m", OPENCODE_ZEN_API_KEY: "k", OPENCODE_ZEN_MODEL: "m" };
    const result = routePreset("private-local", env);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/local/i);
    // Not one hosted provider may appear as a candidate for a local-only preset.
    const decision = routePreset("private-local", { ...env, OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1" });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    for (const candidate of decision.decision.candidates) {
      expect(["ollama", "lmstudio", "llamacpp", "vllm", "jan"]).toContain(candidate.providerId);
    }
  });

  it("says a provider needs a model rather than claiming nothing is configured", () => {
    // A configured provider with no model selected is a different problem from
    // an unconfigured one, and needs a different instruction.
    const result = routePreset("balanced", { GROQ_API_KEY: "k" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Named by its display label, not its internal id, and with no CLI
    // invocation: this string reaches the web composer verbatim, where
    // "Run `morrow providers configure groq`" is not something the reader can
    // act on. Each surface supplies its own affordance.
    expect(result.reason).toContain("Groq");
    expect(result.reason).toMatch(/no model has been chosen/i);
    expect(result.reason).not.toMatch(/no connected provider to run on/i);
    expect(result.reason).not.toMatch(/morrow providers/i);
  });

  it("still reports an empty environment as nothing configured", () => {
    const result = routePreset("balanced", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/no connected provider/i);
  });
});

describe("Connectivity distinguishes reachable from verified", () => {
  async function withServer(
    handler: (req: any, res: any) => void,
    run: (port: number) => Promise<void>
  ): Promise<void> {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      await run(port);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  /**
   * Some providers serve their model list to anyone. A 200 there proves the
   * endpoint is reachable and nothing about the key, so reporting it as
   * "verified" would tell a user with an invalid key that they are ready.
   */
  it("does not claim verification when the endpoint ignores the credential", async () => {
    await withServer(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "public-model" }] }));
      },
      async (port) => {
        const result = await testProviderConnectivity("groq", {
          GROQ_API_KEY: "definitely-not-valid",
          GROQ_BASE_URL: `http://127.0.0.1:${port}/v1`,
        });
        expect(result.ok).toBe(true);
        expect(result.credentialVerified).toBe(false);
        expect(result.detail).toMatch(/without authentication/i);
      }
    );
  });

  it("claims verification when the endpoint actually enforces the credential", async () => {
    await withServer(
      (req, res) => {
        if (req.headers.authorization !== "Bearer good-key") {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "private-model" }] }));
      },
      async (port) => {
        const result = await testProviderConnectivity("groq", {
          GROQ_API_KEY: "good-key",
          GROQ_BASE_URL: `http://127.0.0.1:${port}/v1`,
        });
        expect(result.ok).toBe(true);
        expect(result.credentialVerified).toBe(true);
        expect(result.detail).toMatch(/credential accepted/i);
      }
    );
  });

  it("still reports a rejected credential as a failure", async () => {
    await withServer(
      (_req, res) => res.writeHead(401).end(),
      async (port) => {
        const result = await testProviderConnectivity("groq", {
          GROQ_API_KEY: "bad",
          GROQ_BASE_URL: `http://127.0.0.1:${port}/v1`,
        });
        expect(result.ok).toBe(false);
        expect(result.errorKind).toBe("auth");
      }
    );
  });
});

describe("Provider status exposes what a setup UI needs", () => {
  /**
   * A setup form needs the complete endpoint, including any version path.
   * Reconstructing it from `endpointHost` silently drops the path — a web
   * form pre-filled with "http://127.0.0.1:1234" instead of
   * "http://127.0.0.1:1234/v1" saves an endpoint that cannot serve a request.
   */
  it("publishes the full default endpoint, not just its host", () => {
    const lmstudio = getProviderStatus("lmstudio", {})!;
    expect(lmstudio.defaultBaseUrl).toBe("http://127.0.0.1:1234/v1");
    expect(lmstudio.endpointHost).toBe("127.0.0.1:1234");

    for (const p of PROVIDER_CATALOG) {
      const status = getProviderStatus(p.id, {})!;
      expect(status.defaultBaseUrl, `${p.id} must publish its default endpoint`).toBe(p.defaultBaseUrl);
      // The published URL has to be usable as-is.
      expect(() => new URL(status.defaultBaseUrl!)).not.toThrow();
    }
  });

  it("tells a setup UI how to group, pay for, and sign in to each provider", () => {
    const zen = getProviderStatus("opencode-zen", {})!;
    expect(zen.category).toBe("gateway");
    expect(zen.keyUrl).toBe("https://opencode.ai/auth");
    // OpenCode Zen is API-key only per its official docs.
    expect(zen.supportsOAuth).toBe(false);
    expect(zen.hasFreeTier).toBe(true);

    const anthropic = getProviderStatus("anthropic", {})!;
    expect(anthropic.category).toBe("assistant");
    expect(anthropic.supportsOAuth).toBe(true);

    expect(getProviderStatus("lmstudio", {})!.category).toBe("local");
  });
});
