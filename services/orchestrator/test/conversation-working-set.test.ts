import { describe, expect, it } from "vitest";
import { buildConversationWorkingSet, WORKING_SET_DEFAULTS, type WorkingSetTurn } from "../src/execution/conversation-working-set.js";
import type { ToolCallRecord } from "../src/repositories/conversations.js";

function call(overrides: Partial<ToolCallRecord> & Pick<ToolCallRecord, "toolName">): ToolCallRecord {
  return {
    id: overrides.id ?? `call-${Math.random().toString(16).slice(2)}`,
    messageId: "message-1",
    taskId: overrides.taskId ?? "task-1",
    toolName: overrides.toolName,
    argsJson: overrides.argsJson ?? "{}",
    resultJson: overrides.resultJson ?? null,
    status: overrides.status ?? "completed",
    errorType: overrides.errorType ?? null,
    errorMessage: overrides.errorMessage ?? null,
    createdAt: "2026-08-01T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
  };
}

function turn(toolCalls: ToolCallRecord[], taskId = "task-1"): WorkingSetTurn {
  return { taskId, toolCalls };
}

describe("conversation working set", () => {
  it("returns nothing when no prior turn used a tool", () => {
    expect(buildConversationWorkingSet([]).content).toBeNull();
    expect(buildConversationWorkingSet([turn([])]).content).toBeNull();
    expect(buildConversationWorkingSet([turn([call({ toolName: "unknown_tool" })])]).content).toBeNull();
  });

  it("reports reads, writes, commands, and searches under labelled sections", () => {
    const { content } = buildConversationWorkingSet([
      turn([
        call({ toolName: "read_file", argsJson: JSON.stringify({ path: "src/config.ts" }), resultJson: "export const A = 1;" }),
        call({ toolName: "create_file", argsJson: JSON.stringify({ path: "CHANGELOG.md" }) }),
        call({ toolName: "run_command", argsJson: JSON.stringify({ executable: "npm", args: ["test"] }), resultJson: JSON.stringify({ exitCode: 0 }) }),
        call({ toolName: "search_text", argsJson: JSON.stringify({ query: "TIMEOUT" }), resultJson: JSON.stringify({ matches: [1, 2, 3] }) }),
        call({ toolName: "list_files", argsJson: JSON.stringify({ path: "src" }), resultJson: JSON.stringify({ entries: [1, 2] }) }),
      ]),
    ]);

    expect(content).toContain("Files you already read:\n- src/config.ts (19 B)");
    expect(content).toContain("Files you already created or edited:\n- created CHANGELOG.md");
    expect(content).toContain("`npm test` → exit 0");
    expect(content).toContain('searched text "TIMEOUT" → 3 results');
    expect(content).toContain("listed src (2 entries)");
  });

  it("names the files a patch touched, which the arguments never carry directly", () => {
    const patch = [
      "--- a/src/config.ts",
      "+++ b/src/config.ts",
      "@@ -1 +1 @@",
      "-export const A = 1;",
      "+export const A = 2;",
      "--- a/src/old.ts",
      "+++ /dev/null",
      "",
    ].join("\n");
    const { content } = buildConversationWorkingSet([turn([call({ toolName: "propose_patch", argsJson: JSON.stringify({ patch }) })])]);

    expect(content).toContain("patched src/config.ts");
    // A deletion delivers no file and must not be reported as one.
    expect(content).not.toContain("/dev/null");
    expect(content).not.toContain("src/old.ts");
  });

  it("keeps a failing command's exit code so it is not re-run blind", () => {
    const { content } = buildConversationWorkingSet([
      turn([
        call({
          toolName: "run_command",
          argsJson: JSON.stringify({ executable: "node", args: ["test.js"] }),
          resultJson: JSON.stringify({ exitCode: 1, stderr: "boom" }),
          status: "failed",
          errorMessage: "Command node exited with status 1.",
        }),
      ]),
    ]);

    expect(content).toContain("`node test.js` → exit 1");
  });

  it("records a failure reason when a tool failed without an exit code", () => {
    const { content } = buildConversationWorkingSet([
      turn([
        call({
          toolName: "read_file",
          argsJson: JSON.stringify({ path: "missing.ts" }),
          status: "failed",
          errorMessage: "File not found",
        }),
      ]),
    ]);

    expect(content).toContain("missing.ts");
    expect(content).toContain("FAILED: File not found");
  });

  it("replaces an earlier outcome when identical work runs again", () => {
    const failing = call({
      toolName: "run_command",
      argsJson: JSON.stringify({ executable: "npm", args: ["test"] }),
      resultJson: JSON.stringify({ exitCode: 1 }),
      status: "failed",
    });
    const passing = call({
      toolName: "run_command",
      argsJson: JSON.stringify({ executable: "npm", args: ["test"] }),
      resultJson: JSON.stringify({ exitCode: 0 }),
    });
    const { content, entryCount } = buildConversationWorkingSet([turn([failing], "task-1"), turn([passing], "task-2")]);

    expect(entryCount).toBe(1);
    expect(content).toContain("`npm test` → exit 0");
    expect(content).not.toContain("exit 1");
  });

  it("never carries file contents into the digest", () => {
    const secretish = "const API_TOKEN = 'squirrel-cannon-42';";
    const { content } = buildConversationWorkingSet([
      turn([call({ toolName: "read_file", argsJson: JSON.stringify({ path: "src/secrets.ts" }), resultJson: secretish })]),
    ]);

    expect(content).toContain("src/secrets.ts");
    expect(content).not.toContain("squirrel-cannon-42");
    expect(content).not.toContain("API_TOKEN");
  });

  it("strips credentials and query strings from browsed URLs", () => {
    const { content } = buildConversationWorkingSet([
      turn([call({ toolName: "browser_open", argsJson: JSON.stringify({ url: "https://user:pw@example.test/docs?token=abc" }) })]),
    ]);

    expect(content).toContain("opened https://example.test/docs");
    expect(content).not.toContain("token=abc");
    expect(content).not.toContain("pw@");
  });

  it("stays inside its character budget and says so when it truncates", () => {
    const many = Array.from({ length: 400 }, (_, index) =>
      call({ toolName: "read_file", argsJson: JSON.stringify({ path: `src/module-${index}/deeply/nested/file-${index}.ts` }), resultJson: "x" }),
    );
    const { content, truncated } = buildConversationWorkingSet([turn(many)]);

    expect(truncated).toBe(true);
    expect(content).not.toBeNull();
    expect(content!.length).toBeLessThan(WORKING_SET_DEFAULTS.maxChars + 600);
    expect(content).toContain("Older entries were dropped");
  });

  it("prefers changes and commands over exploration when space runs out", () => {
    const reads = Array.from({ length: 200 }, (_, index) =>
      call({ toolName: "list_files", argsJson: JSON.stringify({ path: `packages/really-quite-long-package-name-${index}/src` }) }),
    );
    const { content } = buildConversationWorkingSet([
      turn([
        call({ toolName: "create_file", argsJson: JSON.stringify({ path: "IMPORTANT.md" }) }),
        call({ toolName: "run_command", argsJson: JSON.stringify({ executable: "npm", args: ["run", "build"] }), resultJson: JSON.stringify({ exitCode: 0 }) }),
        ...reads,
      ]),
    ]);

    expect(content).toContain("created IMPORTANT.md");
    expect(content).toContain("`npm run build` → exit 0");
  });

  it("only considers the most recent turns", () => {
    const turns = Array.from({ length: WORKING_SET_DEFAULTS.maxTurns + 3 }, (_, index) =>
      turn([call({ toolName: "read_file", argsJson: JSON.stringify({ path: `file-${index}.ts` }), resultJson: "x" })], `task-${index}`),
    );
    const { content } = buildConversationWorkingSet(turns);

    expect(content).not.toContain("file-0.ts");
    expect(content).toContain(`file-${turns.length - 1}.ts`);
  });
});
