import { model } from "./common.js";

export const models = [
  model("openrouter", "openrouter/auto", "OpenRouter Auto", { tokenUsage: true, streamingUsage: true, speed: "balanced", cost: "unknown" }),
  model("openrouter", "deepseek/deepseek-v4-pro", "DeepSeek V4 Pro (via OpenRouter)", { contextWindow: 1_000_000, speed: "powerful", cost: "low" }),
  model("openrouter", "deepseek/deepseek-v4-flash", "DeepSeek V4 Flash (via OpenRouter)", { contextWindow: 1_000_000, speed: "fast", cost: "low" }),
] as const;
