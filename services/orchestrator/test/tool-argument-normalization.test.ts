import { describe, expect, it } from "vitest";
import {
  normalizeToolArguments,
  repairAndParseToolArguments,
  validateToolArguments,
  type ToolSchemaLike,
} from "../src/tools/tool-argument-repair.js";
import { getTool } from "../src/tools/catalog.js";
import { buildProviderProjection } from "../src/execution/provider-projection.js";

/**
 * Regression coverage for tool calls that were refused over spelling.
 *
 * Observed signatures: `Invalid argument "content" for create_file`,
 * `Invalid argument "path" for create_file`, `Invalid argument "patch" for
 * propose_patch`, `Invalid argument "files" for propose_patch`, and
 * `Invalid tool arguments format`. Each of these can be produced by a call
 * that is unambiguous but not in the tool's declared shape.
 *
 * The contract these tests pin:
 *   - a valid `{ path, content }` call is passed through byte-identical;
 *   - an unambiguous variant is normalized losslessly and then validated with
 *     undiminished strictness;
 *   - genuinely ambiguous or wrong input is still refused, not guessed at.
 */

function schemaFor(name: string): ToolSchemaLike {
  const spec = getTool(name);
  if (!spec) throw new Error(`missing catalog entry: ${name}`);
  return { name, parameters: { properties: spec.parameters as Record<string, { type?: string }> } };
}

const CREATE_FILE = schemaFor("create_file");
const PROPOSE_PATCH = schemaFor("propose_patch");

/** Parse → normalize → validate, exactly as the agent boundary orders it. */
function throughBoundary(toolName: string, rawArguments: string, required: string[]) {
  const parsed = repairAndParseToolArguments(rawArguments);
  if (!parsed.ok) return { stage: "parse" as const, reason: parsed.reason };
  const normalized = normalizeToolArguments(toolName, parsed.value);
  const schema = toolName === "create_file" ? CREATE_FILE : PROPOSE_PATCH;
  const problem = validateToolArguments(schema, normalized.args, required);
  if (problem) return { stage: "validate" as const, problem, applied: normalized.applied };
  return { stage: "ok" as const, args: normalized.args, applied: normalized.applied };
}

describe("valid arguments are never touched", () => {
  it("passes an ordinary { path, content } create_file through unchanged", () => {
    const args = { path: "src/server.js", content: "export const port = 3000;\n", purpose: "API entrypoint" };
    const result = normalizeToolArguments("create_file", args);
    expect(result.args).toEqual(args);
    expect(result.applied).toEqual([]);
  });

  it("passes a large multi-line file body through byte-identical", () => {
    const content = Array.from({ length: 2_000 }, (_, i) => `line ${i}`).join("\n");
    const result = normalizeToolArguments("create_file", { path: "src/big.ts", content });
    expect(result.args.content).toBe(content);
    expect(result.applied).toEqual([]);
  });

  it("passes a well-formed propose_patch through unchanged", () => {
    const args = { patch: "--- a/x\n+++ b/x\n", explanation: "fix", files: ["x"] };
    expect(normalizeToolArguments("propose_patch", args)).toEqual({ args, applied: [] });
  });

  it("does not touch run_command, whose `args` array is genuinely an array", () => {
    const args = { executable: "npm", args: ["test"], purpose: "run tests" };
    expect(normalizeToolArguments("run_command", args)).toEqual({ args, applied: [] });
  });
});

describe("unambiguous variants are normalized, then validated strictly", () => {
  it("accepts file_path/contents instead of path/content", () => {
    const result = throughBoundary("create_file", JSON.stringify({ file_path: "src/app.js", contents: "console.log(1)\n" }), ["path", "content"]);
    expect(result.stage).toBe("ok");
    if (result.stage !== "ok") return;
    expect(result.args).toMatchObject({ path: "src/app.js", content: "console.log(1)\n" });
    expect(result.applied.map((entry) => entry.field).sort()).toEqual(["content", "path"]);
  });

  it("accepts content emitted as an array of lines", () => {
    const result = throughBoundary("create_file", JSON.stringify({ path: "README.md", content: ["# Taskflow", "", "Run `npm test`."] }), ["path", "content"]);
    expect(result.stage).toBe("ok");
    if (result.stage !== "ok") return;
    expect(result.args.content).toBe("# Taskflow\n\nRun `npm test`.");
    expect(result.applied).toContainEqual({ field: "content", from: "string[]", kind: "joined_lines" });
  });

  it("accepts `diff` as the patch field", () => {
    const result = throughBoundary("propose_patch", JSON.stringify({ diff: "--- a/x\n+++ b/x\n", files: ["x"] }), ["patch"]);
    expect(result.stage).toBe("ok");
    if (result.stage !== "ok") return;
    expect(result.args.patch).toBe("--- a/x\n+++ b/x\n");
    expect(result.args.diff).toBeUndefined();
  });

  it("accepts a single changed file given as a bare string", () => {
    const result = throughBoundary("propose_patch", JSON.stringify({ patch: "--- a/x\n+++ b/x\n", files: "src/x.ts" }), ["patch"]);
    expect(result.stage).toBe("ok");
    if (result.stage !== "ok") return;
    expect(result.args.files).toEqual(["src/x.ts"]);
  });

  it("accepts files given as objects carrying a path", () => {
    const result = throughBoundary("propose_patch", JSON.stringify({ patch: "d", files: [{ path: "a.ts" }, { path: "b.ts" }] }), ["patch"]);
    expect(result.stage).toBe("ok");
    if (result.stage !== "ok") return;
    expect(result.args.files).toEqual(["a.ts", "b.ts"]);
  });

  it("unwraps a sole `arguments` wrapper around the real object", () => {
    const result = throughBoundary("create_file", JSON.stringify({ arguments: { path: "a.txt", content: "x" } }), ["path", "content"]);
    expect(result.stage).toBe("ok");
    if (result.stage !== "ok") return;
    expect(result.args).toMatchObject({ path: "a.txt", content: "x" });
  });

  it("never overwrites a canonical field that is already present", () => {
    const result = normalizeToolArguments("create_file", { path: "real.txt", file_path: "decoy.txt", content: "keep" });
    expect(result.args.path).toBe("real.txt");
  });

  it("treats a blank canonical field as absent so the alias can fill it", () => {
    const result = normalizeToolArguments("create_file", { path: "   ", file_path: "src/app.js", content: "x" });
    expect(result.args.path).toBe("src/app.js");
  });
});

describe("ambiguous or wrong input is still refused", () => {
  it("keeps a numeric patch a type error rather than coercing it", () => {
    const result = throughBoundary("propose_patch", JSON.stringify({ patch: 123, files: [] }), ["patch"]);
    expect(result.stage).toBe("validate");
    if (result.stage !== "validate") return;
    expect(result.problem).toMatchObject({ field: "patch", problem: "wrong_type" });
  });

  it("leaves the absolute-vs-relative decision to the boundary that knows the workspace root", () => {
    // This validator has no workspace root, so it cannot tell an absolute path
    // inside the workspace from one outside it. It therefore passes the value
    // through unchanged; containment is enforced (and a contained absolute path
    // is normalized) by validateSafeReadPath / inspectWorkspace /
    // assertContainedRealPath, which do know the root and can say what a valid
    // value looks like. See tool-observation-visibility.test.ts for the
    // end-to-end rejection message the model actually receives.
    const result = throughBoundary("create_file", JSON.stringify({ file_path: "C:\\\\Windows\\\\evil.txt", content: "x" }), ["path", "content"]);
    expect(result.stage).toBe("ok");
    if (result.stage !== "ok") return;
    expect(result.args.path).toBe("C:\\\\Windows\\\\evil.txt");
  });

  it("still reports a genuinely missing field", () => {
    const result = throughBoundary("create_file", JSON.stringify({ content: "orphan" }), ["path", "content"]);
    expect(result.stage).toBe("validate");
    if (result.stage !== "validate") return;
    expect(result.problem).toMatchObject({ field: "path", problem: "missing" });
  });

  it("leaves a mixed content array alone rather than guessing a join", () => {
    const result = normalizeToolArguments("create_file", { path: "a", content: ["line", 7] });
    expect(result.args.content).toEqual(["line", 7]);
    expect(result.applied).toEqual([]);
  });

  it("leaves files objects alone when any entry has no usable path", () => {
    const result = normalizeToolArguments("propose_patch", { patch: "d", files: [{ path: "a.ts" }, { note: "?" }] });
    expect(result.args.files).toEqual([{ path: "a.ts" }, { note: "?" }]);
  });

  it("still refuses merged tool calls", () => {
    const result = throughBoundary("create_file", '{"path":"a.txt","content":"x"}{"path":"b.txt","content":"y"}', ["path", "content"]);
    expect(result.stage).toBe("parse");
    if (result.stage !== "parse") return;
    expect(result.reason).toBe("multiple_tool_calls_merged");
  });

  it("does not unwrap a wrapper key that is not the sole key", () => {
    const args = { executable: "npm", args: ["test"] };
    expect(normalizeToolArguments("run_command", args).args).toEqual(args);
  });
});

describe("a realistic multi-file build history survives persistence, replay and compaction", () => {
  const files = [
    { path: "package.json", content: '{\n  "name": "taskflow"\n}\n' },
    { path: "src/server.js", content: "import express from 'express';\n".repeat(40) },
    { path: "src/db.js", content: "export const tasks = [];\n".repeat(400) },
    { path: "test/api.test.js", content: "test('health', () => {});\n".repeat(30) },
    { path: "README.md", content: "# Taskflow\n".repeat(10) },
  ];

  it("round-trips every create_file call through JSON persistence unchanged", () => {
    for (const file of files) {
      const raw = JSON.stringify(file);
      const result = throughBoundary("create_file", raw, ["path", "content"]);
      expect(result.stage, `${file.path} must survive the boundary`).toBe("ok");
      if (result.stage !== "ok") continue;
      expect(result.args.content).toBe(file.content);
      expect(result.applied).toEqual([]);
    }
  });

  it("re-derives identical arguments when the durable turn is replayed", () => {
    // A replayed turn re-parses the persisted argsJson. Normalization is
    // deterministic, so a second pass must be a fixed point — otherwise an
    // interrupted turn would resume with different arguments than it started
    // with.
    for (const file of files) {
      const first = normalizeToolArguments("create_file", JSON.parse(JSON.stringify(file)));
      const second = normalizeToolArguments("create_file", JSON.parse(JSON.stringify(first.args)));
      expect(second.args).toEqual(first.args);
      expect(second.applied).toEqual([]);
    }
  });

  it("is a fixed point for normalized variants too, so a resumed turn does not drift", () => {
    const variants = [
      { tool: "create_file", args: { file_path: "src/a.ts", contents: "x" } },
      { tool: "create_file", args: { path: "src/b.ts", content: ["a", "b"] } },
      { tool: "propose_patch", args: { diff: "d", files: "src/c.ts" } },
    ];
    for (const variant of variants) {
      const first = normalizeToolArguments(variant.tool, variant.args);
      const second = normalizeToolArguments(variant.tool, first.args);
      expect(second.args).toEqual(first.args);
      expect(second.applied).toEqual([]);
    }
  });

  it("keeps arguments intact through the provider projection used by recovery and compaction", () => {
    // The projection is model-visible history, so an ordinary successful write
    // keeps its exact arguments. Only a body larger than the projection's
    // historical byte limit is replaced by a non-executable digest record —
    // never by a truncated body that could be replayed as content.
    const HISTORICAL_ARGUMENT_BYTE_LIMIT = 8 * 1024;
    const turns = files.map((file, index) => ({
      turnKey: `turn-${index}`,
      assistantText: `Writing ${file.path}`,
      toolCalls: [{ id: `call-${index}`, name: "create_file", arguments: JSON.stringify(file) }],
    }));
    const projected = buildProviderProjection({
      prefixMessages: [],
      turns,
      toolResults: files.map((_, index) => ({ id: `call-${index}`, toolName: "create_file", result: '{"created":true}' })),
    });

    const projectedCalls = projected.filter((message) => message.role === "assistant").flatMap((message) => message.toolCalls ?? []);
    expect(projectedCalls).toHaveLength(files.length);
    const oversized = files.filter((file) => Buffer.byteLength(JSON.stringify(file), "utf8") > HISTORICAL_ARGUMENT_BYTE_LIMIT);
    expect(oversized.length).toBeGreaterThan(0); // the fixture must exercise both sides
    projectedCalls.forEach((call, index) => {
      const file = files[index]!;
      const raw = JSON.stringify(file);
      if (Buffer.byteLength(raw, "utf8") <= HISTORICAL_ARGUMENT_BYTE_LIMIT) {
        const result = throughBoundary("create_file", call.function.arguments, ["path", "content"]);
        expect(result.stage, `${file.path} must survive the projection`).toBe("ok");
        if (result.stage !== "ok") return;
        expect(result.args.content).toBe(file.content);
        return;
      }
      // Oversized: the target and a durable digest remain, the body does not,
      // and the record is refused by validation rather than executed.
      const projectedArgs = JSON.parse(call.function.arguments) as Record<string, any>;
      expect(projectedArgs.path).toBe(file.path);
      expect(projectedArgs.content).toBeUndefined();
      expect(projectedArgs.durable_context).toMatchObject({
        kind: "completed_tool_arguments",
        tool: "create_file",
        payloadBytes: Buffer.byteLength(file.content, "utf8"),
      });
      expect(throughBoundary("create_file", call.function.arguments, ["path", "content"]).stage).toBe("validate");
    });
  });

  it("does not let a context-capped projection feed a truncated body back into execution", () => {
    // The projection may hand the *model* a placeholder for an oversized
    // argument, but execution and persistence use the raw call. This asserts
    // the capped form is never mistaken for an executable one: it is refused,
    // not silently written as the file's contents.
    const capped = JSON.stringify({
      path: "src/db.js",
      content: "",
      truncatedForContext: true,
      originalArgumentBytes: 40_000,
    });
    const result = throughBoundary("create_file", capped, ["path", "content"]);
    expect(result.stage).toBe("validate");
    if (result.stage !== "validate") return;
    expect(result.problem).toMatchObject({ field: "content", problem: "missing" });
  });
});
