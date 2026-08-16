import { fixedReasoning, model } from "./common.js";

export const models = [
  model("gemini", "gemini-3.5-flash", "Gemini 3.5 Flash", { family: "gemini-flash", generation: "3.5", vision: true, speed: "powerful", cost: "unknown", reasoning: fixedReasoning() }),
  model("gemini", "gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", { family: "gemini-pro", generation: "3.1", lifecycle: "preview", vision: true, speed: "powerful", cost: "unknown", reasoning: fixedReasoning() }),
  model("gemini", "gemini-2.5-flash", "Gemini 2.5 Flash", { family: "gemini-flash", generation: "2.5", vision: true, speed: "fast", cost: "low", reasoning: fixedReasoning() }),
  model("gemini", "gemini-2.5-flash-lite", "Gemini 2.5 Flash-Lite", { family: "gemini-flash-lite", generation: "2.5", vision: true, speed: "fast", cost: "low", reasoning: fixedReasoning() }),
] as const;
