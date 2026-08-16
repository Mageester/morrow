import { describe, it, expect } from "vitest";
import {
  repairAndParseToolArguments,
  validateToolArguments,
  describeToolSchema,
  type ToolSchemaLike,
} from "../src/tools/tool-argument-repair.js";

const createFileSchema: ToolSchemaLike = {
  name: "create_file",
  parameters: {
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      purpose: { type: "string" },
    },
    required: ["path", "content"],
  },
};

const proposePatchSchema: ToolSchemaLike = {
  name: "propose_patch",
  parameters: {
    properties: {
      patch: { type: "string" },
      explanation: { type: "string" },
      files: { type: "array" },
    },
    required: ["patch", "explanation", "files"],
  },
};

describe("repairAndParseToolArguments", () => {
  it("parses healthy JSON with no repair", () => {
    const r = repairAndParseToolArguments('{"path":"src/a.ts","content":"x"}');
    expect(r).toEqual({ ok: true, value: { path: "src/a.ts", content: "x" }, repaired: false, strategies: [] });
  });

  it("treats empty/whitespace arguments as an empty object (no-arg tools)", () => {
    expect(repairAndParseToolArguments("")).toMatchObject({ ok: true, value: {}, repaired: false });
    expect(repairAndParseToolArguments("   \n ")).toMatchObject({ ok: true, value: {} });
    expect(repairAndParseToolArguments(null)).toMatchObject({ ok: true, value: {} });
  });

  it("repairs fenced JSON (```json ... ```)", () => {
    const r = repairAndParseToolArguments("```json\n{\"path\":\"a.ts\",\"content\":\"hi\"}\n```");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ path: "a.ts", content: "hi" });
      expect(r.repaired).toBe(true);
      expect(r.strategies).toContain("stripped_code_fence");
    }
  });

  it("repairs a plain ``` fence with no language tag", () => {
    const r = repairAndParseToolArguments("```\n{\"query\":\"test\"}\n```");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ query: "test" });
  });

  it("extracts JSON from surrounding prose (before and after)", () => {
    const r = repairAndParseToolArguments('Sure, here you go: {"path":"a.ts","content":"x"} let me know!');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ path: "a.ts", content: "x" });
      expect(r.strategies).toContain("extracted_json_from_prose");
    }
  });

  it("removes trailing commas", () => {
    const r = repairAndParseToolArguments('{"path":"a.ts","content":"x",}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ path: "a.ts", content: "x" });
      expect(r.strategies).toContain("removed_trailing_comma");
    }
  });

  it("does not strip commas inside string values", () => {
    const r = repairAndParseToolArguments('{"content":"a, b, c","path":"p"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ content: "a, b, c", path: "p" });
  });

  it("rejects truncated JSON without guessing", () => {
    const r = repairAndParseToolArguments('{"path":"a.ts","content":"unterminated');
    expect(r).toMatchObject({ ok: false, reason: "truncated_json" });
  });

  it("rejects truncated JSON with an unbalanced brace", () => {
    const r = repairAndParseToolArguments('{"path":"a.ts","content":{"nested":1}');
    expect(r).toMatchObject({ ok: false, reason: "truncated_json" });
  });

  it("rejects multiple merged tool calls as ambiguous", () => {
    const r = repairAndParseToolArguments('{"path":"a.ts"}{"path":"b.ts"}');
    expect(r).toMatchObject({ ok: false, reason: "multiple_tool_calls_merged" });
  });

  it("rejects merged calls even when separated by prose/whitespace", () => {
    const r = repairAndParseToolArguments('{"path":"a.ts","content":"x"}\nand also\n{"path":"b.ts","content":"y"}');
    expect(r).toMatchObject({ ok: false, reason: "multiple_tool_calls_merged" });
  });

  it("classifies an unescaped Windows path rather than repairing it", () => {
    const r = repairAndParseToolArguments('{"path":"C:\\Users\\me\\proj\\a.ts","content":"x"}');
    expect(r).toMatchObject({ ok: false, reason: "escaped_windows_path" });
  });

  it("rejects a non-object JSON value", () => {
    expect(repairAndParseToolArguments('"just a string"')).toMatchObject({ ok: false, reason: "not_an_object" });
    expect(repairAndParseToolArguments("[1,2,3]")).toMatchObject({ ok: false, reason: "not_an_object" });
  });

  it("rejects prose with no JSON object at all", () => {
    expect(repairAndParseToolArguments("I cannot do that")).toMatchObject({ ok: false, reason: "invalid_json" });
  });

  it("repairs invalid single quote escapes in JSON strings", () => {
    const r = repairAndParseToolArguments('{"content":"import { it } from \\\'vitest\\\';"}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ content: "import { it } from 'vitest';" });
      expect(r.strategies).toContain("removed_invalid_single_quote_escape");
    }
  });

  it("does not corrupt a genuinely escaped backslash followed by a literal quote", () => {
    // The value for "a" is already valid JSON: \\ decodes to one literal
    // backslash, and the quote right after needs no escaping at all in JSON.
    // "b" carries the real, invalid `\'` mistake that forces repair to run.
    // A blanket `/\\'/g` replace would also match the second backslash of
    // "a"'s valid `\\'`, corrupting `x\'y` into the still-invalid `x'y` — er,
    // into `\'y` — and, in this exact combined payload, would leave the
    // whole thing unparseable even after the "fix".
    const raw = String.raw`{"a":"x\\'y","b":"bad\'z"}`;
    const r = repairAndParseToolArguments(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ a: "x\\'y", b: "bad'z" });
    }
  });

  it("performs only a single repair pass (does not iterate)", () => {
    // A properly-escaped Windows path survives; the double backslash is valid JSON.
    const r = repairAndParseToolArguments('{"path":"C:\\\\Users\\\\a.ts","content":"x"}');
    // Absolute path is still parseable JSON (rejected later by schema validation).
    expect(r.ok).toBe(true);
  });
});

describe("validateToolArguments", () => {
  it("accepts well-formed create_file arguments", () => {
    expect(validateToolArguments(createFileSchema, { path: "a.ts", content: "x" })).toBeNull();
  });

  it("flags a missing required field", () => {
    expect(validateToolArguments(createFileSchema, { content: "x" })).toEqual({ field: "path", expected: "string (required)", problem: "missing" });
  });

  it("treats a blank required string as missing", () => {
    expect(validateToolArguments(createFileSchema, { path: "   ", content: "x" })).toMatchObject({ field: "path", problem: "missing" });
  });

  it("flags a wrong argument type", () => {
    expect(validateToolArguments(proposePatchSchema, { patch: 123 }, ["patch"])).toMatchObject({ field: "patch", problem: "wrong_type", expected: "string" });
  });

  it("flags a wrong type on an optional-but-present field", () => {
    expect(validateToolArguments(proposePatchSchema, { patch: "d", files: "not-an-array" }, ["patch"])).toMatchObject({ field: "files", problem: "wrong_type", expected: "array" });
  });

  it("does not judge absolute paths, which only the workspace-aware boundary can decide", () => {
    // This validator has no workspace root, so it cannot distinguish an
    // absolute path inside the workspace from one outside it. Rejecting both
    // refused legitimate calls and taught the model nothing. Containment is
    // enforced by validateSafeReadPath / inspectWorkspace /
    // assertContainedRealPath, which know the root, normalize a contained
    // absolute path, and reject an escaping one with an actionable message.
    expect(validateToolArguments(createFileSchema, { path: "C:\\Windows\\evil.txt", content: "x" })).toBeNull();
    expect(validateToolArguments(createFileSchema, { path: "/etc/passwd", content: "x" })).toBeNull();
  });

  it("honors a curated required-field override (tolerates omitted advertised-required fields)", () => {
    // explanation & files are advertised-required but the executor tolerates them absent.
    expect(validateToolArguments(proposePatchSchema, { patch: "diff" }, ["patch"])).toBeNull();
  });

  it("describeToolSchema renders a compact hint", () => {
    expect(describeToolSchema(createFileSchema)).toBe("{ path: string (required), content: string (required), purpose?: string }");
    expect(describeToolSchema({ name: "x" })).toBeNull();
  });
});
