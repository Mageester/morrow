import type { SendMessageInput } from "@morrow/contracts";
import type { ChatComposerSubmission } from "./chat-composer.js";

/**
 * Keep the page-level API boundary aligned with the composer contract.
 * Conversation and project identity are supplied by conversationApi; the
 * selected reasoning override belongs in the message body.
 */
export function toConversationMessageInput(
  submission: ChatComposerSubmission,
): Omit<SendMessageInput, "idempotencyKey"> {
  return {
    content: submission.content,
    mode: submission.mode,
    autoApprove: submission.autoApprove,
    ...(submission.preset ? { preset: submission.preset } : {}),
    ...(submission.providerId ? { providerId: submission.providerId } : {}),
    ...(submission.model ? { model: submission.model } : {}),
    ...(submission.reasoning ? { reasoning: submission.reasoning } : {}),
  };
}
