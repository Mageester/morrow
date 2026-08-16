/**
 * Live availability probe for the benchmark's provider routes. Reports the
 * truth about each route (reachable, rejected, missing credentials) without
 * running any benchmark task.
 */
import { join } from "node:path";
import { hydrateProviderEnvFromSecrets } from "../src/provider/secrets.js";
import { resolveMorrowHome } from "../src/home.js";
import { createProvider, getProviderDefaultModel, isProviderConfigured } from "../src/provider/registry.js";
import type { ProviderId } from "@morrow/contracts";

hydrateProviderEnvFromSecrets(join(resolveMorrowHome(process.env), "secrets.env"), process.env);

const routes: Array<{ providerId: ProviderId; model?: string | undefined }> = [
  { providerId: "deepseek" },
  { providerId: "opencode-zen", model: process.env.OPENCODE_ZEN_MODEL },
  { providerId: "nvidia-nim", model: process.env.NVIDIA_NIM_MODEL },
  { providerId: "tokenrouter", model: process.env.TOKENROUTER_MODEL },
  { providerId: "openai" },
  { providerId: "anthropic" },
  { providerId: "gemini" },
  { providerId: "openrouter" },
];

for (const route of routes) {
  const model = route.model ?? getProviderDefaultModel(route.providerId, process.env) ?? "(none)";
  if (!isProviderConfigured(route.providerId, process.env)) {
    console.log(`${route.providerId}: unavailable (no credentials configured)`);
    continue;
  }
  const started = Date.now();
  try {
    const provider = createProvider(route.providerId, process.env, model);
    let text = "";
    for await (const chunk of provider.streamChat([{ role: "user", content: "Reply with exactly: OK" }], { model, maxOutputTokens: 64, timeoutMs: 180_000 })) {
      if (chunk.type === "text" && chunk.text) text += chunk.text;
    }
    console.log(`${route.providerId} [${model}]: reachable (${Date.now() - started}ms) -> ${JSON.stringify(text.trim().slice(0, 60))}`);
  } catch (error) {
    console.log(`${route.providerId} [${model}]: FAILED (${Date.now() - started}ms) -> ${(error as Error).message.slice(0, 180)}`);
  }
}
