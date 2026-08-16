import { effort, model, price } from "./common.js";

export const models = [
  model("openai", "gpt-5.6-sol", "GPT-5.6 Sol", { aliases: ["gpt-5.6", "gpt5.6"], family: "gpt-5.6", generation: "5.6", contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: price(5, 30, 0.5), vision: true, speed: "powerful", cost: "high", reasoning: effort(["low", "medium", "high", "xhigh", "max"]) }),
  model("openai", "gpt-5.6-terra", "GPT-5.6 Terra", { family: "gpt-5.6", generation: "5.6", contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: price(2.5, 15), vision: true, speed: "balanced", cost: "medium", reasoning: effort(["low", "medium", "high", "xhigh", "max"]) }),
  model("openai", "gpt-5.6-luna", "GPT-5.6 Luna", { family: "gpt-5.6", generation: "5.6", contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: price(1, 6), vision: true, speed: "fast", cost: "low", reasoning: effort(["low", "medium", "high", "xhigh", "max"]) }),
  model("openai", "gpt-5.5", "GPT-5.5", { aliases: ["gpt5.5"], family: "gpt-5.5", generation: "5.5", lifecycle: "legacy", contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: price(5, 30, 0.5), vision: true, speed: "powerful", cost: "high", reasoning: effort() }),
  model("openai", "gpt-5.4", "GPT-5.4", { aliases: ["gpt5.4"], family: "gpt-5.4", generation: "5.4", lifecycle: "legacy", contextWindow: 1_050_000, maxOutputTokens: 128_000, pricing: price(2.5, 15, 0.25), vision: true, speed: "powerful", cost: "medium", reasoning: effort() }),
  model("openai", "gpt-5.4-mini", "GPT-5.4 mini", { aliases: ["gpt5.4-mini"], family: "gpt-5.4", vision: true, speed: "fast", cost: "low", reasoning: effort() }),
] as const;
