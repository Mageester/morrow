import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Markdown, normalizeStreamingMarkdown } from "./markdown.js";

function renderMarkdown(text: string, streaming = false) {
  return render(<Markdown streaming={streaming} text={text} />);
}

describe("Markdown", () => {
  it("renders headings with correct levels", () => {
    renderMarkdown("# One\n\n## Two\n\n### Three");
    expect(screen.getByRole("heading", { level: 1, name: "One" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Two" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Three" })).toBeInTheDocument();
  });

  it("renders bold and italic without showing raw asterisks", () => {
    const { container } = renderMarkdown("This is **bold** and *italic* text.");
    expect(container.querySelector("strong")).toHaveTextContent("bold");
    expect(container.querySelector("em")).toHaveTextContent("italic");
    expect(container).not.toHaveTextContent("**");
  });

  it("does not italicize snake_case identifiers", () => {
    const { container } = renderMarkdown("Call `read_file` then write_file_next please.");
    expect(container.querySelector("em")).toBeNull();
  });

  it("renders unordered, ordered, and nested lists", () => {
    const { container } = renderMarkdown("- a\n- b\n  - b1\n  - b2\n\n1. first\n2. second");
    expect(container.querySelectorAll("ul").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll("ol")).toHaveLength(1);
    expect(screen.getByText("b1")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("renders blockquotes and horizontal rules", () => {
    const { container } = renderMarkdown("> quoted wisdom\n\n---\n\nafter");
    expect(container.querySelector("blockquote")).toHaveTextContent("quoted wisdom");
    expect(container.querySelector("hr")).toBeInTheDocument();
  });

  it("renders inline code in monospace styling hooks", () => {
    const { container } = renderMarkdown("Run `pnpm test` now.");
    const code = container.querySelector("code");
    expect(code).toHaveTextContent("pnpm test");
    expect(code?.closest("pre")).toBeNull();
  });

  it("renders fenced code with language label and copy control", async () => {
    const user = userEvent.setup();
    renderMarkdown("```ts\nconst answer: number = 42;\n```");
    expect(screen.getByText("ts")).toBeInTheDocument();
    const copy = screen.getByRole("button", { name: /copy code/i });
    await user.click(copy);
    expect(await screen.findByRole("button", { name: /copy code/i })).toHaveTextContent(/copied/i);
  });

  it("renders GFM tables inside a containment region", () => {
    renderMarkdown("| Col A | Col B |\n| --- | --- |\n| 1 | 2 |");
    expect(screen.getByRole("region", { name: "Table" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Col A" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "2" })).toBeInTheDocument();
  });

  it("marks external links safe and keeps relative links plain", () => {
    const { container } = renderMarkdown("[ext](https://example.com) and [rel](./docs)");
    const ext = screen.getByRole("link", { name: "ext" });
    expect(ext).toHaveAttribute("target", "_blank");
    expect(ext).toHaveAttribute("rel", expect.stringContaining("noopener"));
    const rel = screen.getByRole("link", { name: "rel" });
    expect(rel).not.toHaveAttribute("target");
    expect(container.querySelector('a[href="javascript:alert(1)"]')).toBeNull();
  });

  it("renders GFM task lists as disabled checkboxes", () => {
    renderMarkdown("- [x] done\n- [ ] todo");
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toBeChecked();
    expect(boxes[1]).not.toBeChecked();
    boxes.forEach((box) => expect(box).toBeDisabled());
  });

  it("preserves escaped characters literally", () => {
    const { container } = renderMarkdown("\\*not italic\\*");
    expect(container.querySelector("em")).toBeNull();
    expect(container).toHaveTextContent("*not italic*");
  });

  it("sanitizes raw HTML instead of rendering it", () => {
    const { container } = renderMarkdown("Safe text\n\n<script>alert('xss')</script>\n\n<img src=x onerror=alert(1)>");
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container).not.toHaveTextContent("alert('xss')");
  });

  it("blocks javascript: URLs from model output", () => {
    const { container } = renderMarkdown("[click](javascript:alert(document.cookie))");
    expect(container.querySelector('a[href*="javascript"]')).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
    expect(container).toHaveTextContent("click");
  });

  it("handles malformed and deeply nested markdown without crashing", () => {
    const nasty = `${"- ".repeat(40)}deep\n\n**unclosed bold\n\n| broken | table\n| --- |\n\n~~~\nfence tilde`;
    const { container } = renderMarkdown(nasty);
    expect(container.querySelector(".morrow-markdown")).toBeInTheDocument();
  });

  it("normalizes an unclosed fence only while streaming", () => {
    const partial = "Here is code:\n\n```ts\nconst x = 1;";
    expect(normalizeStreamingMarkdown(partial)).toBe(`${partial}\n\`\`\``);
    expect(normalizeStreamingMarkdown("```ts\nok\n```")).toBe("```ts\nok\n```");
    // Completed render of the same partial text must use the raw source.
    const { container } = renderMarkdown(partial, false);
    expect(container.querySelectorAll("pre")).toHaveLength(1);
  });

  it("renders streaming partial bold without crashing and resolves on completion", () => {
    const { container, rerender } = render(<Markdown streaming text={"Starting **bol"} />);
    expect(container.querySelector(".morrow-markdown")).toBeInTheDocument();
    rerender(<Markdown text={"Starting **bold** done"} />);
    expect(container.querySelector("strong")).toHaveTextContent("bold");
  });

  it("renders identically under light and dark theme attributes", () => {
    for (const theme of ["light", "dark"]) {
      document.documentElement.dataset.theme = theme;
      const { container, unmount } = renderMarkdown("# Title\n\n**bold** `code`");
      expect(container.querySelector("strong")).toBeInTheDocument();
      expect(container.querySelector("code")).toBeInTheDocument();
      unmount();
    }
    delete document.documentElement.dataset.theme;
  });
});
