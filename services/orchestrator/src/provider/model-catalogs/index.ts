import type { ModelInfo } from "@morrow/contracts";
import { models as anthropic } from "./anthropic.js";
import { models as deepseek } from "./deepseek.js";
import { models as gemini } from "./gemini.js";
import { models as ollama } from "./ollama.js";
import { models as openai } from "./openai.js";
import { models as openrouter } from "./openrouter.js";
import { models as opencodeZen } from "./opencode-zen.js";
import { BUNDLED_MODEL_CATALOG_VERSION, UNKNOWN_REASONING } from "./common.js";

/** Provider-owned catalogs are discovery seed data, not routing permission. */
export const PROVIDER_MODEL_CATALOGS: Readonly<Record<string, readonly ModelInfo[]>> = Object.freeze({
  openai,
  anthropic,
  gemini,
  openrouter,
  deepseek,
  "opencode-zen": opencodeZen,
  ollama,
});

/** Compatibility aggregate for existing model/status APIs. */
export const BUILT_IN_MODELS: ModelInfo[] = Object.freeze(
  Object.values(PROVIDER_MODEL_CATALOGS).flat().map((model) => model.reasoning ? model : { ...model, reasoning: UNKNOWN_REASONING }),
) as unknown as ModelInfo[];

export { BUNDLED_MODEL_CATALOG_VERSION, UNKNOWN_REASONING };
