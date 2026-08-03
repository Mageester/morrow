import { describe, expect, it } from "vitest";
import { resolveModelMetadata } from "../src/routing/models.js";

/**
 * Found while checking a model id a user supplied as `DEEPSEEK-V4-FLASH-FREE`.
 *
 * Model ids are case-insensitive identities but case-sensitive payloads. The
 * catalog lookup was exact-match only, so an id typed in a different case
 * resolved as an unknown model: no context window, no pricing, no reasoning
 * contract, and a distinct canonical id — which also means a distinct provider
 * route fingerprint, so continuation state would never be reused. The
 * conservative 32k fallback that follows makes a long task compact constantly.
 *
 * Metadata lookup is now case-insensitive. The id sent to the provider is
 * still exactly what the caller supplied, because provider payloads are
 * case-sensitive.
 */

describe("model id case is an identity, not a new model", () => {
  it("resolves the same metadata regardless of the case supplied", () => {
    const lower = resolveModelMetadata("deepseek", "deepseek-v4-flash");
    const upper = resolveModelMetadata("deepseek", "DEEPSEEK-V4-FLASH");
    expect(upper.canonicalId).toBe(lower.canonicalId);
    expect(upper.contextWindow).toBe(lower.contextWindow);
    expect(upper.contextWindow).not.toBeNull();
  });

  it("resolves a case-varied alias to the same canonical model", () => {
    const viaAlias = resolveModelMetadata("deepseek", "DEEPSEEK-CHAT");
    expect(viaAlias.canonicalId).toBe("deepseek-v4-flash");
    expect(viaAlias.contextWindow).toBe(1_000_000);
  });

  it("still sends the provider the id exactly as supplied", () => {
    // Provider payloads are case-sensitive; only our metadata lookup folds.
    const upper = resolveModelMetadata("deepseek", "DEEPSEEK-V4-FLASH");
    expect(upper.id).toBe("DEEPSEEK-V4-FLASH");
    expect(upper.providerModelId).toBe("DEEPSEEK-V4-FLASH");
  });

  it("does not invent metadata for a genuinely unknown model", () => {
    const unknown = resolveModelMetadata("deepseek", "not-a-real-model");
    expect(unknown.contextWindow).toBeNull();
  });

  it("does not collide two different models that differ by more than case", () => {
    const flash = resolveModelMetadata("deepseek", "deepseek-v4-flash");
    const other = resolveModelMetadata("deepseek", "deepseek-v4-pro");
    expect(other.canonicalId).not.toBe(flash.canonicalId);
  });
});
