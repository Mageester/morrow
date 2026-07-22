import { beforeEach, describe, expect, it } from "vitest";
import {
  clearChatDraft,
  loadChatDraft,
  saveChatDraft,
  type ChatDraftScope,
} from "./draft-store.js";

const first: ChatDraftScope = { projectId: "project/a", conversationId: "chat:1" };
const second: ChatDraftScope = { projectId: "project/a", conversationId: "chat:2" };

beforeEach(() => localStorage.clear());

describe("chat draft storage", () => {
  it("keeps text isolated by project and conversation without storing routing data", () => {
    saveChatDraft(first, "private draft text");
    saveChatDraft(second, "another draft");

    expect(loadChatDraft(first)).toBe("private draft text");
    expect(loadChatDraft(second)).toBe("another draft");
    expect(Object.values(localStorage).join(" ")).not.toContain("provider");
  });

  it("uses a separate project-scoped key before a conversation exists", () => {
    const newChat = { projectId: "project/a" };
    saveChatDraft(newChat, "new conversation draft");

    expect(loadChatDraft(newChat)).toBe("new conversation draft");
    expect(loadChatDraft(first)).toBe("");
  });

  it("fails closed on malformed or unsupported stored values", () => {
    localStorage.setItem("morrow.chat-draft.v1.project%2Fa.chat%3A1", "not-json");
    expect(loadChatDraft(first)).toBe("");

    localStorage.setItem(
      "morrow.chat-draft.v1.project%2Fa.chat%3A1",
      JSON.stringify({ version: 99, text: "stale" }),
    );
    expect(loadChatDraft(first)).toBe("");
  });

  it("removes empty and explicitly cleared drafts", () => {
    saveChatDraft(first, "temporary");
    saveChatDraft(first, "");
    expect(loadChatDraft(first)).toBe("");

    saveChatDraft(first, "temporary");
    clearChatDraft(first);
    expect(loadChatDraft(first)).toBe("");
  });
});
