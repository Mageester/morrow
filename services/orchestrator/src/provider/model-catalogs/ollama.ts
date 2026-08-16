import { freeLocal, model } from "./common.js";

export const models = [
  model("ollama", "llama3.1", "Llama 3.1 (local)", { contextWindow: 128_000, pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "balanced", cost: "free", privacy: "local" }),
  model("ollama", "qwen2.5", "Qwen 2.5 (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "balanced", cost: "free", privacy: "local" }),
  model("ollama", "mistral", "Mistral (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "fast", cost: "free", privacy: "local" }),
  model("ollama", "phi3", "Phi-3 (local)", { pricing: freeLocal, tokenUsage: false, streamingUsage: false, vision: false, speed: "fast", cost: "free", privacy: "local" }),
] as const;
