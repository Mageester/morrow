import { describe, expect, it } from "vitest";
import { projectProviderRequest } from "../src/execution/provider-projection.js";
import { admitProviderRequest, measureProviderRequest } from "../src/execution/context-budget.js";
import type { ProviderRequestEnvelope } from "../src/execution/context-budget.js";

function envelopeOf(messageCount: number): ProviderRequestEnvelope {
  const messages: any[] = [{ role: "system", content: "You are Morrow." }];
  for (let index = 0; index < messageCount; index++) {
    messages.push({ role: index % 2 === 0 ? "user" : "assistant", content: `turn ${index} ${"detail ".repeat(20)}` });
  }
  messages.push({ role: "user", content: "what changed?" });
  return { model: "mock-model", messages, tools: [], outputReserveTokens: 4096 } as unknown as ProviderRequestEnvelope;
}

const checkpoint: any = {
  filesChanged: [], gitStatus: "", tests: [], unresolvedFailures: [], recoveryAttempts: [],
  pendingWork: [], approvals: {}, taskId: "t", missionId: null, providerRouting: {},
  providerContinuationRefs: [], evidenceRequired: [],
};

/**
 * The no-compaction path admits the measurement it already took instead of
 * measuring the identical envelope a second time. That is only sound because
 * `measureProviderRequest` is pure, so this pins the equivalence rather than
 * the shortcut: whatever admission the envelope would have produced is exactly
 * what the reused measurement produces.
 */
describe("provider projection reuses its measurement when nothing is compacted", () => {
  it("admits identically to measuring the envelope a second time", () => {
    const envelope = envelopeOf(120);
    const result = projectProviderRequest({
      checkpoint, envelope, resolution: { usableInputTokens: 5_000_000 } as any,
    });

    expect(result.compacted).toBe(false);
    expect(result.envelope).toBe(envelope);
    expect(result.admission).toEqual(admitProviderRequest(envelope, { usableInputTokens: 5_000_000 }));
    expect(result.admission.measurement).toEqual(measureProviderRequest(envelope));
    expect(result.admission.measurement).toEqual(result.originalMeasurement);
  });

  it("matches a freshly measured admission at every budget that skips compaction", () => {
    const envelope = envelopeOf(120);
    const measured = measureProviderRequest(envelope);
    // Any budget comfortably above the measurement leaves `shouldCompact`
    // false, which is the branch that now reuses the measurement.
    for (const usableInputTokens of [measured.inputTokens * 2, measured.inputTokens * 10, 5_000_000]) {
      const result = projectProviderRequest({ checkpoint, envelope, resolution: { usableInputTokens } as any });
      expect(result.compacted).toBe(false);
      expect(result.admission).toEqual(admitProviderRequest(envelope, { usableInputTokens }));
    }
  });
});
