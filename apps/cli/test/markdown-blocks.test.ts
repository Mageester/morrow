import { describe, expect, it } from "vitest";
import { parseBlocks, parseInline } from "../src/terminal/markdown-blocks.js";

describe("markdown inline spans", () => {
  it("splits bold out of surrounding text", () => {
    expect(parseInline("a **bold** c")).toEqual([
      { kind: "text", text: "a " },
      { kind: "bold", text: "bold" },
      { kind: "text", text: " c" },
    ]);
  });

  it("reads inline code and links", () => {
    expect(parseInline("run `pnpm test` see [docs](http://x)")).toEqual([
      { kind: "text", text: "run " },
      { kind: "code", text: "pnpm test" },
      { kind: "text", text: " see " },
      { kind: "link", text: "docs", href: "http://x" },
    ]);
  });

  it("leaves unmatched markers as text rather than dropping them", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ kind: "text", text: "2 * 3 * 4" }]);
  });
});

describe("markdown blocks", () => {
  it("parses the shape of a typical assistant answer", () => {
    const blocks = parseBlocks(["# Title", "", "- **Build** — does a thing", "1. first", "> note"].join("\n"));
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "blank", "bullet", "numbered", "quote"]);
  });

  it("captures a fenced block with its language and stops at the close", () => {
    const blocks = parseBlocks(["before", "```bash", "pnpm test", "```", "after"].join("\n"));
    expect(blocks[1]).toEqual({ kind: "code", lang: "bash", lines: ["pnpm test"] });
    expect(blocks[2]).toEqual({ kind: "paragraph", spans: [{ kind: "text", text: "after" }] });
  });

  it("runs an unterminated fence to the end instead of losing the rest", () => {
    const blocks = parseBlocks(["```ts", "const a = 1;", "const b = 2;"].join("\n"));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ kind: "code", lang: "ts", lines: ["const a = 1;", "const b = 2;"] });
  });

  it("recognises a horizontal rule without eating a bullet", () => {
    expect(parseBlocks("---")[0]!.kind).toBe("rule");
    expect(parseBlocks("- item")[0]!.kind).toBe("bullet");
  });

  it("tracks nesting depth on indented lists", () => {
    const blocks = parseBlocks(["- top", "  - nested"].join("\n"));
    expect(blocks.map((b) => (b.kind === "bullet" ? b.depth : -1))).toEqual([0, 1]);
  });
});
