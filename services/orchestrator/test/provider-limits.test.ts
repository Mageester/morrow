import { describe, it, expect } from "vitest";
import {
  reconcileWireLimits,
  MIN_MS_PER_OUTPUT_TOKEN,
  DEFAULT_VISIBLE_ANSWER_FLOOR_TOKENS,
} from "../src/provider/limits.js";
import { PRESETS } from "../src/routing/presets.js";

/**
 * Morrow has shipped the same defect class twice in two unrelated adapters: a
 * limit that is only valid relative to another limit, moved without its pair.
 * These assertions pin the relations themselves, not the adapters that happen
 * to consume them.
 */
describe("wire request limits are reconciled against each other in one place", () => {
  it("leaves a mutually consistent set untouched and reports no adjustments", () => {
    const limits = reconcileWireLimits({ maxOutputTokens: 4096, timeoutMs: 90_000, temperature: 0.2 });
    expect(limits).toEqual({ maxOutputTokens: 4096, timeoutMs: 90_000, temperature: 0.2, adjustments: [] });
  });

  it("drops temperature when the protocol forbids it alongside reasoning", () => {
    // Anthropic rejects a request pairing extended thinking with a sampling
    // temperature. The preset supplies temperature without any knowledge of
    // the reasoning mode, so the two arrive already in conflict.
    const limits = reconcileWireLimits({
      maxOutputTokens: 4096,
      temperature: 0.3,
      reasoningBudgetTokens: 8192,
      reasoningExcludesTemperature: true,
      visibleAnswerFloorTokens: 4096,
    });
    expect(limits.temperature).toBeNull();
    expect(limits.adjustments.some((a) => a.includes("temperature"))).toBe(true);
  });

  it("keeps temperature when reasoning is not actually enabled", () => {
    const limits = reconcileWireLimits({ maxOutputTokens: 4096, temperature: 0.3, reasoningExcludesTemperature: true });
    expect(limits.temperature).toBe(0.3);
    expect(limits.adjustments).toEqual([]);
  });

  it("lifts the output ceiling above the reasoning budget so a visible answer can exist", () => {
    // A ceiling at or below the thinking budget guarantees the model spends
    // the whole allowance reasoning and returns nothing at all.
    const limits = reconcileWireLimits({ maxOutputTokens: 4096, reasoningBudgetTokens: 8192, visibleAnswerFloorTokens: 4096 });
    expect(limits.maxOutputTokens).toBe(8192 + 4096);
    expect(limits.adjustments.some((a) => a.includes("maxOutputTokens"))).toBe(true);
  });

  it("names a ceiling when a reasoning budget was requested without one", () => {
    const limits = reconcileWireLimits({ reasoningBudgetTokens: 2048 });
    expect(limits.maxOutputTokens).toBe(2048 + DEFAULT_VISIBLE_ANSWER_FLOOR_TOKENS);
  });

  it("leaves a ceiling that already clears the reasoning budget alone", () => {
    const limits = reconcileWireLimits({ maxOutputTokens: 32_000, reasoningBudgetTokens: 8192, visibleAnswerFloorTokens: 4096 });
    expect(limits.maxOutputTokens).toBe(32_000);
    expect(limits.adjustments).toEqual([]);
  });

  it("raises the deadline with the allowance instead of relabelling the failure", () => {
    // The observed regression: quadrupling the token allowance while holding
    // the deadline fixed converted an "empty response" failure into a
    // "provider stream timed out" failure, without ever letting the turn
    // finish. Raising one of these two limits alone is never correct.
    const limits = reconcileWireLimits({ maxOutputTokens: 32_768, timeoutMs: 90_000 });
    expect(limits.timeoutMs).toBe(32_768 * MIN_MS_PER_OUTPUT_TOKEN);
    expect(limits.adjustments.some((a) => a.includes("timeoutMs"))).toBe(true);
  });

  it("does not invent a deadline for a request that had none", () => {
    const limits = reconcileWireLimits({ maxOutputTokens: 32_768 });
    expect(limits.timeoutMs).toBeUndefined();
  });

  it("accounts for the reasoning budget when sizing the deadline", () => {
    // The ceiling is raised first, so the deadline is derived from the ceiling
    // the request will actually carry — not the one the caller passed in.
    const limits = reconcileWireLimits({
      maxOutputTokens: 4096,
      timeoutMs: 90_000,
      reasoningBudgetTokens: 60_000,
      visibleAnswerFloorTokens: 4096,
    });
    expect(limits.maxOutputTokens).toBe(64_096);
    expect(limits.timeoutMs).toBe(64_096 * MIN_MS_PER_OUTPUT_TOKEN);
  });

  it("treats absent, null, and non-positive limits as unset rather than as values", () => {
    expect(reconcileWireLimits({})).toEqual({ maxOutputTokens: null, timeoutMs: undefined, temperature: null, adjustments: [] });
    expect(reconcileWireLimits({ maxOutputTokens: null, timeoutMs: 0 })).toEqual({ maxOutputTokens: null, timeoutMs: undefined, temperature: null, adjustments: [] });
    // Temperature 0 is a real, meaningful selection — never confuse it with unset.
    expect(reconcileWireLimits({ temperature: 0 }).temperature).toBe(0);
  });

  /**
   * The floor is not a throughput estimate — it is the point past which a
   * deadline is arithmetically incapable of admitting the allowance it was
   * paired with. Every shipped preset must sit comfortably above it, or the
   * rule would be silently rewriting normal configuration instead of catching
   * a genuine mismatch.
   */
  it("never fires on a shipped preset", () => {
    for (const preset of PRESETS) {
      if (typeof preset.outputBudgetTokens !== "number" || typeof preset.timeoutMs !== "number") continue;
      const limits = reconcileWireLimits({ maxOutputTokens: preset.outputBudgetTokens, timeoutMs: preset.timeoutMs });
      expect(limits.adjustments, `preset ${preset.id} pairs ${preset.outputBudgetTokens} tokens with ${preset.timeoutMs}ms`).toEqual([]);
    }
  });

  /**
   * The empty-response recovery scales both limits by the same multiplier, up
   * to 8x. That escalation must stay self-consistent at every step — the
   * failure it was written to fix was a 4x budget under a 1x deadline.
   */
  it("stays consistent across the whole empty-response escalation ladder", () => {
    for (const preset of PRESETS) {
      if (typeof preset.outputBudgetTokens !== "number" || typeof preset.timeoutMs !== "number") continue;
      for (const multiplier of [1, 2, 4, 8]) {
        const limits = reconcileWireLimits({
          maxOutputTokens: preset.outputBudgetTokens * multiplier,
          timeoutMs: preset.timeoutMs * multiplier,
        });
        expect(limits.adjustments, `preset ${preset.id} at ${multiplier}x`).toEqual([]);
      }
    }
  });
});
