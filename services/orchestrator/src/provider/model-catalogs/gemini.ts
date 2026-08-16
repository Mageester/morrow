import { geminiThinking, model, unverifiedReasoning } from "./common.js";

/** Date the per-model thinkingLevel sets below were probed against v1beta. */
const GEMINI_LEVELS_VERIFIED_AT = "2026-08-16T00:00:00.000Z";

/**
 * Gemini's `GET /v1beta/models` reports `inputTokenLimit`, `outputTokenLimit`
 * and a `thinking` boolean, so context capacity is genuinely discovered at
 * runtime and is deliberately NOT restated here — a stale number in this file
 * would only ever be a worse answer than the one the API gives.
 *
 * What the listing does not report is which `thinkingLevel` values each model
 * accepts. That is the one fact these entries carry, and it is per-model:
 * verified against the live v1beta API on 2026-08-16, `gemini-3.7-flash`
 * rejects MINIMAL ("Thinking level MINIMAL is not supported for this model")
 * while `gemini-3.5-flash` and `gemini-3.1-flash-lite` accept it. A route
 * whose levels have not been verified stays absent rather than guessed.
 */
export const models = [
  model("gemini", "gemini-3.7-flash", "Gemini 3.7 Flash", { family: "gemini-flash", generation: "3.7", vision: true, speed: "powerful", cost: "unknown", verifiedAt: GEMINI_LEVELS_VERIFIED_AT, reasoning: geminiThinking(["low", "medium", "high"]) }),
  model("gemini", "gemini-3.6-flash", "Gemini 3.6 Flash", { family: "gemini-flash", generation: "3.6", vision: true, speed: "powerful", cost: "unknown", verifiedAt: GEMINI_LEVELS_VERIFIED_AT, reasoning: geminiThinking(["minimal", "low", "medium", "high"]) }),
  model("gemini", "gemini-3.5-flash", "Gemini 3.5 Flash", { family: "gemini-flash", generation: "3.5", vision: true, speed: "powerful", cost: "unknown", verifiedAt: GEMINI_LEVELS_VERIFIED_AT, reasoning: geminiThinking(["minimal", "low", "medium", "high"]) }),
  model("gemini", "gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite", { family: "gemini-flash-lite", generation: "3.1", vision: true, speed: "fast", cost: "unknown", verifiedAt: GEMINI_LEVELS_VERIFIED_AT, reasoning: geminiThinking(["minimal", "low", "medium", "high"]) }),
  // Levels unverified: this account is over quota for 3.1 Pro, so the live
  // probe could not distinguish "unsupported level" from "no quota".
  model("gemini", "gemini-3.1-pro-preview", "Gemini 3.1 Pro Preview", { family: "gemini-pro", generation: "3.1", lifecycle: "preview", vision: true, speed: "powerful", cost: "unknown", reasoning: unverifiedReasoning() }),
] as const;
