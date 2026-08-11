import { describe, expect, it } from "vitest";
import type { ChatComposerSubmission } from "./chat-composer.js";
import { toConversationMessageInput } from "./conversation-submit.js";

const baseSubmission: ChatComposerSubmission = {
  content: "Explain the failing harness write",
  projectId: "project-1",
  conversationId: "conversation-1",
  mode: "agent",
  autoApprove: false,
  providerId: "deepseek",
  model: "deepseek-v4-flash",
};

describe("toConversationMessageInput", () => {
  it("preserves the selected reasoning configuration in the API payload", () => {
    expect(
      toConversationMessageInput({
        ...baseSubmission,
        reasoning: { mode: "effort", effort: "high" },
      }),
    ).toEqual({
      content: baseSubmission.content,
      mode: baseSubmission.mode,
      autoApprove: baseSubmission.autoApprove,
      providerId: baseSubmission.providerId,
      model: baseSubmission.model,
      reasoning: { mode: "effort", effort: "high" },
    });
  });

  it("does not send an undefined reasoning override", () => {
    expect(toConversationMessageInput(baseSubmission)).toEqual({
      content: baseSubmission.content,
      mode: baseSubmission.mode,
      autoApprove: baseSubmission.autoApprove,
      providerId: baseSubmission.providerId,
      model: baseSubmission.model,
    });
  });
});
