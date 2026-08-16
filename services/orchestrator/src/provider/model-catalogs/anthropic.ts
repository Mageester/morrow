import { fixedReasoning, model, price } from "./common.js";

export const models = [
  model("anthropic", "claude-fable-5", "Claude Fable 5", { family: "claude-fable", generation: "5", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: price(10, 50), vision: true, speed: "powerful", cost: "high", reasoning: fixedReasoning() }),
  model("anthropic", "claude-opus-4-8", "Claude Opus 4.8", { family: "claude-opus", generation: "4.8", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: price(5, 25), vision: true, speed: "powerful", cost: "high", reasoning: fixedReasoning() }),
  model("anthropic", "claude-sonnet-5", "Claude Sonnet 5", { family: "claude-sonnet", generation: "5", contextWindow: 1_000_000, maxOutputTokens: 128_000, pricing: price(3, 15), vision: true, speed: "fast", cost: "medium", reasoning: fixedReasoning() }),
  model("anthropic", "claude-haiku-4-5-20251001", "Claude Haiku 4.5", { aliases: ["claude-haiku-4-5"], family: "claude-haiku", generation: "4.5", contextWindow: 200_000, maxOutputTokens: 64_000, pricing: price(1, 5), vision: true, speed: "fast", cost: "low" }),
] as const;
