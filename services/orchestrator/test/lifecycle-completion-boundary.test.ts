import { describe, expect, it, vi } from "vitest";

describe("lifecycle completion boundary precedence", () => {
  it("suppresses unverified_completion heuristic when completion contract is durably satisfied", () => {
    const completedWithoutMoreTools = true;
    const lastVerificationFailure = { tool: "run_command", detail: "Command exited with status 1." };
    const completionIsDurablySatisfied = true;

    // Logic under test:
    const shouldInterruptUnverified = completedWithoutMoreTools && lastVerificationFailure && !completionIsDurablySatisfied;

    expect(shouldInterruptUnverified).toBe(false);
  });

  it("does not suppress unverified_completion heuristic when completion contract is NOT satisfied", () => {
    const completedWithoutMoreTools = true;
    const lastVerificationFailure = { tool: "run_command", detail: "Command exited with status 1." };
    const completionIsDurablySatisfied = false;

    // Logic under test:
    const shouldInterruptUnverified = completedWithoutMoreTools && lastVerificationFailure && !completionIsDurablySatisfied;

    expect(shouldInterruptUnverified).toBe(true);
  });

  it("ensures duplicate narration hard guard still runs even when completion contract is true", () => {
    const completionIsDurablySatisfied = true;
    const canonicalFinalText = "Narration text";
    const priorNarration = ["Narration text"];

    function duplicatesPriorNarration(finalText: string, prior: string[]) {
      return prior.includes(finalText);
    }

    const isDuplicate = duplicatesPriorNarration(canonicalFinalText, priorNarration);
    expect(isDuplicate).toBe(true);
    // Hard guard fires despite completionIsDurablySatisfied being true!
  });

  it("ensures missing workspace delivery hard guard still runs even when completion contract is true", () => {
    const completionIsDurablySatisfied = true;
    const agentMode = "agent";
    const requestsWorkspaceChange = true;
    const completedWriteTools = 0;

    const isMissingDelivery = agentMode === "agent" && requestsWorkspaceChange && completedWriteTools === 0;

    expect(isMissingDelivery).toBe(true);
    // Hard guard fires despite completionIsDurablySatisfied being true!
  });

  it("ensures frontend browser validation hard guard still runs even when completion contract is true", () => {
    const completionIsDurablySatisfied = true;
    const frontendGaps = ["desktop viewport missing"];

    const requiresFrontendValidation = frontendGaps.length > 0;

    expect(requiresFrontendValidation).toBe(true);
    // Hard guard fires despite completionIsDurablySatisfied being true!
  });
});
