import { listProviderStatuses, isProviderConfigured } from "../src/provider/registry.js";
import { routePreset, listPresetStatuses } from "../src/routing/router.js";
import { listModels } from "../src/routing/models.js";
import { OAUTH_FINDINGS } from "../src/provider/oauth.js";

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function run() {
  // 1. With no credentials, no hosted provider is configured and cloud presets are unavailable.
  const emptyEnv: Record<string, string | undefined> = {};
  const empty = listProviderStatuses(emptyEnv);
  assert(empty.every((s) => !s.configured), "no provider should be configured with empty env");
  assert(!routePreset("balanced", emptyEnv).ok, "balanced should be unavailable with no providers");
  assert(!routePreset("private-local", emptyEnv).ok, "private-local should be unavailable without Ollama");

  // 2. Secrets never appear in serialized status.
  const secretEnv = { OPENAI_API_KEY: "sk-test-SECRET-VALUE-123456" };
  const json = JSON.stringify(listProviderStatuses(secretEnv));
  assert(!json.includes("SECRET-VALUE"), "API key must never appear in provider status");

  // 3. OpenAI configured -> balanced routes to openai (preferred).
  const openaiRoute = routePreset("balanced", secretEnv);
  assert(openaiRoute.ok && openaiRoute.decision.providerId === "openai", "balanced should route to openai");
  assert(openaiRoute.ok && !openaiRoute.decision.fallbackUsed, "openai is preferred for balanced (no fallback)");

  // 4. Only Anthropic configured -> balanced falls back to anthropic, honestly flagged.
  const anthropicEnv = { ANTHROPIC_API_KEY: "sk-ant-test" };
  const fb = routePreset("balanced", anthropicEnv);
  assert(fb.ok && fb.decision.providerId === "anthropic", "balanced should fall back to anthropic");
  assert(fb.ok && fb.decision.fallbackUsed, "fallback must be reported");

  // 5. Privacy boundary: local-only preset cannot be overridden to a hosted provider.
  const localEnv = { OLLAMA_BASE_URL: "http://127.0.0.1:11434/v1", OPENAI_API_KEY: "sk-test" };
  assert(isProviderConfigured("ollama", localEnv), "ollama should be configured when OLLAMA_BASE_URL is set");
  const pl = routePreset("private-local", localEnv);
  assert(pl.ok && pl.decision.providerId === "ollama", "private-local routes to ollama");
  const blocked = routePreset("private-local", localEnv, { providerId: "openai" });
  assert(!blocked.ok, "private-local must reject a hosted provider override");

  // 6. Preset status + model registry are coherent.
  const statuses = listPresetStatuses(secretEnv);
  assert(statuses.length === 7, "expected 7 presets");
  const balancedStatus = statuses.find((s) => s.preset.id === "balanced");
  assert(!!balancedStatus?.available && balancedStatus.resolved?.providerId === "openai", "balanced resolved to openai");
  assert(listModels().length > 0, "model registry should be non-empty");

  // 7. OAuth findings are honest and match the implemented surface: Claude and
  //    Codex subscription sign-in are available; Gemini has no comparable
  //    consumer OAuth and stays API-key. (Mirrors server-providers.test.ts.)
  assert(OAUTH_FINDINGS.length === 3, "expected 3 OAuth findings");
  assert(
    OAUTH_FINDINGS.every((f) => f.status === "available" || f.status === "unavailable"),
    "every OAuth finding must declare a concrete available/unavailable status",
  );
  const available = OAUTH_FINDINGS.filter((f) => f.status === "available")
    .map((f) => f.id)
    .sort();
  assert(
    available.length === 2 && available[0] === "claude-oauth" && available[1] === "codex-oauth",
    "Claude + Codex subscription OAuth should be reported available",
  );
  assert(
    OAUTH_FINDINGS.find((f) => f.id === "gemini-oauth")?.status === "unavailable",
    "Gemini OAuth should be reported unavailable (API-key only)",
  );

  console.log("Provider/routing smoke test passed successfully!");
}

try {
  run();
} catch (e) {
  console.error("Provider/routing smoke test failed:", e);
  process.exit(1);
}
