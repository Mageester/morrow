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

  it("uses collision-free structured scope identities", () => {
    const dottedProject = { projectId: "a.b", conversationId: "c" };
    const dottedConversation = { projectId: "a", conversationId: "b.c" };
    const absentConversation = { projectId: "a" };
    const literalNewConversation = { projectId: "a", conversationId: "new" };
    const unicode = { projectId: "私の.計画", conversationId: "会話/😀" };

    saveChatDraft(dottedProject, "dotted project");
    saveChatDraft(dottedConversation, "dotted conversation");
    saveChatDraft(absentConversation, "new chat");
    saveChatDraft(literalNewConversation, "literal new chat");
    saveChatDraft(unicode, "unicode scope");

    expect(loadChatDraft(dottedProject)).toBe("dotted project");
    expect(loadChatDraft(dottedConversation)).toBe("dotted conversation");
    expect(loadChatDraft(absentConversation)).toBe("new chat");
    expect(loadChatDraft(literalNewConversation)).toBe("literal new chat");
    expect(loadChatDraft(unicode)).toBe("unicode scope");
    expect(localStorage).toHaveLength(5);
  });

  it("fails closed on malformed or unsupported stored values", () => {
    saveChatDraft(first, "valid");
    const key = localStorage.key(0)!;
    localStorage.setItem(key, "not-json");
    expect(loadChatDraft(first)).toBe("");

    localStorage.setItem(
      key,
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
