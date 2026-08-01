import { describe, expect, it } from "vitest";
import { normalizeTrailingLegacyToolCalls } from "../src/execution/legacy-tool-call.js";

describe("legacy tool-call normalization", () => {
  const exposed = new Set(["read_file", "run_command"]);

  it("normalizes a trailing exposed XML tool block", () => {
    expect(normalizeTrailingLegacyToolCalls(
      "Checking type definition.\n<read_file><path>task-report/src/types.ts</path></read_file>",
      exposed,
    )).toEqual({
      text: "Checking type definition.",
      toolCalls: [{ name: "read_file", arguments: JSON.stringify({ path: "task-report/src/types.ts" }) }],
    });
  });

  it("normalizes booleans and numbers for command arguments", () => {
    const result = normalizeTrailingLegacyToolCalls(
      "<run_command><command>npm test</command><timeoutMs>30000</timeoutMs><background>false</background></run_command>",
      exposed,
    );
    expect(JSON.parse(result!.toolCalls[0]!.arguments)).toEqual({
      command: "npm test",
      timeoutMs: 30000,
      background: false,
    });
  });

  it("ignores unexposed, incomplete, or non-trailing markup", () => {
    expect(normalizeTrailingLegacyToolCalls("<create_file><path>x</path></create_file>", exposed)).toBeNull();
    expect(normalizeTrailingLegacyToolCalls("<read_file>missing args</read_file>", exposed)).toBeNull();
    expect(normalizeTrailingLegacyToolCalls("<read_file><path>x</path></read_file>\nfinal answer", exposed)).toBeNull();
  });
});
