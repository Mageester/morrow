import { deepSeekReasoning, fixedReasoning, model, price } from "./common.js";

export const models = [
  model("deepseek", "deepseek-v4-pro", "DeepSeek V4 Pro", { aliases: ["deepseek-pro"], contextWindow: 1_000_000, maxOutputTokens: 384_000, pricing: price(0.435, 0.87, 0.003625), speed: "powerful", cost: "low", reasoning: deepSeekReasoning() }),
  model("deepseek", "deepseek-v4-flash", "DeepSeek V4 Flash", { aliases: ["deepseek-flash"], contextWindow: 1_000_000, maxOutputTokens: 384_000, pricing: price(0.14, 0.28, 0.0028), speed: "fast", cost: "low", reasoning: deepSeekReasoning() }),
  model("deepseek", "deepseek-chat", "DeepSeek Chat", { canonicalTarget: { providerId: "deepseek", modelId: "deepseek-v4-flash" }, lifecycle: "deprecated", speed: "balanced", cost: "low" }),
  model("deepseek", "deepseek-reasoner", "DeepSeek Reasoner", { canonicalTarget: { providerId: "deepseek", modelId: "deepseek-v4-flash" }, lifecycle: "deprecated", speed: "powerful", cost: "low", reasoning: fixedReasoning() }),
] as const;
