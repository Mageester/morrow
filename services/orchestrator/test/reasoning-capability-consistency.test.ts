import { describe, it, expect } from "vitest";
import { BUILT_IN_MODELS } from "../src/routing/models.js";
import { translateReasoning } from "../src/provider/reasoning.js";
import { reasoningOptions } from "../../../apps/cli/src/terminal/reasoning.js";
import type { ProviderProtocol } from "../src/provider/base.js";

/**
 * A route's reasoning capability is what the picker offers the user. The
 * adapter's `translateReasoning` is what the request is actually allowed to
 * carry. When those two disagree, the product advertises a control that is
 * rejected the moment it is used — which is exactly what happened to
 * claude-opus-4-8 and claude-sonnet-5: the registry declared effort control,
 * so `/reasoning` listed Low/Medium/High on those routes, and every selection
 * came back 400 REASONING_UNSUPPORTED because `anthropic-messages` has no
 * `reasoning_effort` field.
 *
 * This guard closes the loop structurally rather than model by model: for
 * every built-in model, each option the picker would show must translate on
 * that provider's real protocol.
 */

/**
 * The wire protocol each built-in model provider actually speaks (see the
 * provider descriptors in provider/registry.ts). Deliberately explicit: a new
 * provider entering the model catalog fails the coverage assertion below until
 * its protocol is stated here, so it cannot skip this check by omission.
 */
const PROTOCOL_BY_PROVIDER: Record<string, ProviderProtocol> = {
  openai: "openai-chat",
  anthropic: "anthropic-messages",
  gemini: "gemini-generate-content",
  deepseek: "openai-chat",
  openrouter: "openai-chat",
  ollama: "openai-chat",
  "opencode-zen": "openai-chat",
};

describe("reasoning capability matches what the provider protocol can carry", () => {
  it("covers every provider present in the built-in model catalog", () => {
    const providers = [...new Set(BUILT_IN_MODELS.map((m) => m.providerId))].sort();
    expect(providers.filter((id) => !(id in PROTOCOL_BY_PROVIDER))).toEqual([]);
  });

  for (const model of BUILT_IN_MODELS) {
    const capability = model.reasoning;
    if (!capability) continue;
    const protocol = PROTOCOL_BY_PROVIDER[model.providerId];
    if (!protocol) continue;

    it(`${model.providerId}/${model.id}: every offered reasoning option is accepted by ${protocol}`, () => {
      const rejected = reasoningOptions(capability)
        .map((option) => ({ option: option.arg, result: translateReasoning(option.config, protocol, capability) }))
        .filter((entry) => !entry.result.ok);
      expect(rejected).toEqual([]);
    });
  }
});
