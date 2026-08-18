import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERSATION_TITLE,
  deriveConversationTitle,
  isDefaultConversationTitle,
} from "../src/web/conversation-title.js";

describe("deriveConversationTitle", () => {
  it("names a conversation after what was actually asked", () => {
    expect(deriveConversationTitle("Rebuild the homepage hero.")).toBe("Rebuild the homepage hero");
    expect(deriveConversationTitle("hello")).toBe("hello");
  });

  it("strips markup so a formatted prompt does not become a formatted title", () => {
    expect(deriveConversationTitle("## Fix the **login** flow")).toBe("Fix the login flow");
    expect(deriveConversationTitle("- Run `pnpm test` and report")).toBe("Run pnpm test and report");
    expect(deriveConversationTitle("Check [the docs](https://example.test) first")).toBe(
      "Check the docs first",
    );
  });

  it("cuts long prompts at a word boundary rather than mid-word", () => {
    const prompt =
      "Please refactor the entire provider routing subsystem so that fallback selection is deterministic";
    const title = deriveConversationTitle(prompt);

    expect(title).not.toBeNull();
    expect(title!.length).toBeLessThanOrEqual(61);
    expect(title!.endsWith("…")).toBe(true);
    // The kept text is a prefix of the prompt that ends exactly where a word
    // does — the next character in the prompt is a space, not more letters.
    const kept = title!.slice(0, -1);
    expect(prompt.startsWith(kept)).toBe(true);
    expect(prompt[kept.length]).toBe(" ");
  });

  it("declines to name a conversation it has nothing to name it from", () => {
    expect(deriveConversationTitle("")).toBeNull();
    expect(deriveConversationTitle("   \n  ")).toBeNull();
    expect(deriveConversationTitle("```\nconst a = 1;\n```")).toBeNull();
  });
});

describe("isDefaultConversationTitle", () => {
  it("only ever replaces a title nobody chose", () => {
    expect(isDefaultConversationTitle(DEFAULT_CONVERSATION_TITLE)).toBe(true);
    expect(isDefaultConversationTitle("   ")).toBe(true);
    expect(isDefaultConversationTitle("Perf Test")).toBe(false);
  });
});
