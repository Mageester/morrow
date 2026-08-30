import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { normalizeRunCommandArguments } from "../src/execution/run-command-arguments.js";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { TOOL_CATALOG } from "../src/tools/catalog.js";

describe("normalizeRunCommandArguments", () => {
  it("leaves a correctly shaped call untouched", () => {
    expect(normalizeRunCommandArguments({ executable: "python3", args: ["--version"] }))
      .toEqual({ executable: "python3", args: ["--version"] });
  });

  /** The exact misuse observed on a fresh workspace. */
  it("reads the program off the head of args when executable is missing", () => {
    expect(normalizeRunCommandArguments({ args: ["python3", "--version"] }))
      .toEqual({ executable: "python3", args: ["--version"], normalizedFrom: "args_head" });
  });

  it("accepts a plain `command` program name", () => {
    expect(normalizeRunCommandArguments({ command: "node", args: ["--version"] }))
      .toEqual({ executable: "node", args: ["--version"], normalizedFrom: "command_field" });
  });

  /**
   * The case that must keep failing loudly. `node -e "<script>"` sent without
   * an executable does not say what to run; inventing "-e" as a program would
   * turn a clear error into a wrong command.
   */
  it("refuses to guess when the leading token is a flag", () => {
    expect(normalizeRunCommandArguments({ args: ["-e", "console.log(1)"] }))
      .toEqual({ args: ["-e", "console.log(1)"] });
  });

  it("refuses a command line rather than shell-splitting it", () => {
    // Quoting and metacharacters have more than one reading; there is no shell.
    expect(normalizeRunCommandArguments({ command: "python3 --version" }).executable).toBeUndefined();
    expect(normalizeRunCommandArguments({ command: "ls | wc -l" }).executable).toBeUndefined();
    expect(normalizeRunCommandArguments({ args: ["rm -rf /", "x"] }).executable).toBeUndefined();
  });

  /**
   * The shape that killed a live run: `args` arrives as a JSON *string*
   * describing the array. Seven consecutive refusals before the task was
   * abandoned. It has exactly one reading, so it is decoded, not refused.
   */
  it("decodes a JSON-encoded args array", () => {
    expect(normalizeRunCommandArguments({ executable: "node", args: '["rex/smoke.js"]' }))
      .toEqual({ executable: "node", args: ["rex/smoke.js"], normalizedFrom: "json_encoded_args" });
  });

  it("decodes a JSON-encoded argv list, program first", () => {
    expect(normalizeRunCommandArguments({ argv: '["node", "rex/smoke.js"]' }))
      .toEqual({ executable: "node", args: ["rex/smoke.js"], normalizedFrom: "argv_field" });
  });

  it("pairs a JSON-encoded args array with a `command` field", () => {
    expect(normalizeRunCommandArguments({ command: "node", args: '["--version"]' }))
      .toEqual({ executable: "node", args: ["--version"], normalizedFrom: "command_field" });
  });

  it("still refuses a string that is not a JSON array", () => {
    // "--check script.js" could be one argument or two; splitting it is a guess.
    expect(normalizeRunCommandArguments({ executable: "node", args: "--check script.js" }).args).toEqual([]);
    expect(normalizeRunCommandArguments({ executable: "node", args: '["a", 2]' }).args).toEqual([]);
  });

  it("keeps a path-shaped program", () => {
    expect(normalizeRunCommandArguments({ args: ["./scripts/build.sh"] }))
      .toEqual({ executable: "./scripts/build.sh", args: [], normalizedFrom: "args_head" });
  });
});

describe("the run_command schema shows its canonical shape", () => {
  it("gives a worked example in both the tool description and the fields", () => {
    const tool = TOOL_CATALOG.find((entry) => entry.name === "run_command")!;
    const parameters = tool.parameters as unknown as { executable: { description: string }; args: { description: string } };
    expect(parameters.executable.description).toContain('"python3"');
    expect(parameters.args.description).toContain('["--version"]');
    // The split, and the absence of a shell, are the two things a model gets
    // wrong; both must be stated where the model actually reads them.
    expect(parameters.executable.description).toMatch(/no arguments in it/i);
  });
});

function seed(db: any, workspacePath: string, prompt: string) {
  const iso = new Date().toISOString();
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: iso });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: iso, updatedAt: iso });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: prompt, createdAt: iso, updatedAt: iso });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: iso });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: iso, updatedAt: iso });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: iso,
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: iso });
}

const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

describe("an environment check succeeds on the first attempt", () => {
  let db: any;
  let ws: string;
  beforeEach(() => { ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-runcmd-"))); db = openDatabase(":memory:"); });
  afterEach(() => { try { db.close(); } catch {} rmSync(ws, { recursive: true, force: true }); });

  it("runs the command a model shaped as one argv array", async () => {
    seed(db, ws, "check the environment and report what is available");
    const provider = new MockProvider({
      chunks: [
        // No `executable`: the shape that used to fail three times in a row.
        [tool("probe", "run_command", { args: [process.execPath, "--version"], purpose: "check the runtime version" }), done],
        [text("The runtime is available."), done],
        [text("Nothing else to check."), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 8 });

    const call = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.id === "probe");
    expect(call?.status).toBe("completed");
    expect(JSON.parse(call!.resultJson!).exitCode).toBe(0);
    // The reshaping is recorded rather than silent.
    expect(taskRecordsRepository(db).listEvents("t").some((e: any) =>
      e.type === "tool.arguments_normalized" && e.payload?.from === "args_head")).toBe(true);
  });

  it("still refuses, with a usable instruction, when the intent is genuinely ambiguous", async () => {
    seed(db, ws, "check the environment and report what is available");
    const provider = new MockProvider({
      chunks: [
        [tool("bad", "run_command", { args: ["-e", "console.log(1)"], purpose: "probe" }), done],
        [text("I could not run that."), done],
        [text("There is nothing further to probe."), done],
      ],
      delayMs: 1,
    });

    await executeAgentChatTask({ db, taskId: "t", provider, maxTurns: 8 });

    const call = conversationsRepository(db).listToolCallsForTask("t").find((c: any) => c.id === "bad");
    expect(call?.status).toBe("failed");
    const result = JSON.parse(call!.resultJson!);
    expect(result.invalidField).toBe("executable");
    expect(result.instruction).toContain('"executable"');
  });
});
