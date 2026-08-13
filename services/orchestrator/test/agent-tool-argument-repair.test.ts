import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask, proposePatchTarget, isEchoedAppliedWrite } from "../src/execution/agent.js";
import { processesRepository } from "../src/repositories/processes.js";
import { ProcessSupervisor } from "../src/processes/supervisor.js";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function seedYolo(db: any, workspacePath: string) {
  projectRepository(db).createProject({ id: "p", name: "P", workspacePath, createdAt: new Date().toISOString() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "make a file", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: new Date().toISOString() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "t", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: new Date().toISOString(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: new Date().toISOString() });
}

const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });
const tool = (id: string, name: string, args: unknown) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }] });
const rawTool = (id: string, name: string, rawArguments: string) => ({ type: "tool_call" as const, toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: rawArguments } }] });

function run(db: any, provider: MockProvider, maxTurns = 8) {
  const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns }));
  runner.run("t");
  return runner.waitFor("t");
}
function calls(db: any) { return conversationsRepository(db).listToolCallsForTask("t"); }
function states(db: any) { return taskRecordsRepository(db).listAgentStates("t").map((s: any) => s.state); }
function argEvents(db: any) { return taskRecordsRepository(db).listEvents("t").filter((e: any) => e.type === "tool.arguments_rejected"); }

describe("proposePatchTarget", () => {
  it("keys on the files array (deduped, order-independent)", () => {
    expect(proposePatchTarget({ files: ["b.ts", "a.ts", "b.ts"] }, "")).toBe("a.ts,b.ts");
  });
  it("keys on a single file given as a bare string", () => {
    expect(proposePatchTarget({ files: "only.ts" }, "")).toBe("only.ts");
  });
  it("falls back to unified-diff +++ headers when files is absent", () => {
    const patch = "--- a/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n";
    expect(proposePatchTarget({ patch }, "")).toBe("src/x.ts");
  });
  it("recovers a target from raw malformed JSON text", () => {
    expect(proposePatchTarget(undefined, '{"files":["raw.ts"],"patch":')).toBe("raw.ts");
  });
  it("returns null when no target is derivable", () => {
    expect(proposePatchTarget({ explanation: "x" }, '{"explanation":"x"}')).toBeNull();
  });
  it("ignores /dev/null headers", () => {
    expect(proposePatchTarget({ patch: "--- a\n+++ /dev/null\n" }, "")).toBeNull();
  });
});

describe("isEchoedAppliedWrite", () => {
  const marker = { kind: "create_file", contentBytes: 2958, contentSha256: "abc", instruction: "Historical applied write." };
  it("is true for a create_file echoing the externalized marker with no content", () => {
    expect(isEchoedAppliedWrite("create_file", { path: "src/App.tsx", _morrowAppliedWrite: marker })).toBe(true);
  });
  it("is true for a propose_patch echoing the marker with no patch", () => {
    expect(isEchoedAppliedWrite("propose_patch", { files: ["a.ts"], _morrowAppliedWrite: { kind: "propose_patch" } })).toBe(true);
  });
  it("is false when real content is present alongside the marker", () => {
    expect(isEchoedAppliedWrite("create_file", { path: "a.ts", content: "real", _morrowAppliedWrite: marker })).toBe(false);
  });
  it("is false without the marker", () => {
    expect(isEchoedAppliedWrite("create_file", { path: "a.ts" })).toBe(false);
  });
  it("is false for non-write tools", () => {
    expect(isEchoedAppliedWrite("read_file", { _morrowAppliedWrite: marker })).toBe(false);
  });
});

describe("agent tool-argument recovery", () => {
  let db: any;
  let ws: string;
  let warn: any;

  beforeEach(() => {
    ws = realpathSync(mkdtempSync(join(tmpdir(), "morrow-toolargs-")));
    db = openDatabase(":memory:");
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    try { db.close(); } catch {}
    rmSync(ws, { recursive: true, force: true });
  });

  it("repairs fenced arguments transparently and completes without a rejection", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [rawTool("fenced", "create_file", "```json\n{\"path\":\"note.txt\",\"content\":\"hello\"}\n```"), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(readFileSync(join(ws, "note.txt"), "utf8")).toBe("hello");
    expect(calls(db).find((c: any) => c.id === "fenced")!.status).toBe("completed");
    expect(argEvents(db)).toHaveLength(0);
  });

  it("accepts a large valid create_file payload without entering repair", async () => {
    seedYolo(db, ws);
    const content = "invoice-line\n".repeat(8000);
    const provider = new MockProvider({
      chunks: [
        [tool("large", "create_file", { path: "script.js", content }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(readFileSync(join(ws, "script.js"), "utf8")).toBe(content);
    expect(calls(db).find((c: any) => c.id === "large")!.status).toBe("completed");
    expect(argEvents(db)).toHaveLength(0);
  });

  it("normalizes a legacy command string without executing through a shell", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("legacy-command", "run_command", {
          command: "node --version",
          working_directory: "/home/user",
          purpose: "Verify Node is available",
        }), done],
        [text("finished"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const command = calls(db).find((c: any) => c.id === "legacy-command")!;
    expect(command.status).toBe("completed");
    expect(JSON.parse(command.resultJson!)).toMatchObject({ exitCode: 0 });
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("treats a run_command missing executable as a retryable arg error, then completes on the corrected retry", async () => {
    // Live regression (deepseek-v4-flash, task 97dfe323): the model sent
    // run_command with args ["-e", "<node http server>"] but omitted
    // `executable: "node"`. Thrown as a bare Error it was unretryable and — as
    // the last verify-or-write call — became a `failed_final_verification`
    // completion blocker that INTERRUPTED a fully-built, browser-verified app.
    // It must instead be a recoverable invalid_tool_arguments correction.
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("noexec", "run_command", { args: ["--version"], purpose: "check node" }), done],
        [tool("fixed", "run_command", { executable: "node", args: ["--version"], purpose: "check node" }), done],
        [text("finished"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const noexec = calls(db).find((c: any) => c.id === "noexec")!;
    expect(noexec.status).toBe("failed");
    expect(JSON.parse(noexec.resultJson!)).toMatchObject({
      kind: "invalid_tool_arguments",
      invalidField: "executable",
    });
    // Recovered, not interrupted: the corrected retry runs and the task closes.
    expect(calls(db).find((c: any) => c.id === "fixed")!.status).toBe("completed");
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
  });

  it("clears a stale invalid_tool_arguments failure once the corrected retry is a running background process", async () => {
    // Live regression (deepseek-v4-flash, converter build): the model's
    // purpose text for a static-file-server command said "...for browser
    // verification", so BOTH the rejected call (missing "executable") and
    // its corrected retry were classified verification-shaped by that
    // wording alone. The successful retry was then (correctly) excluded from
    // independentVerifications as a running background process with no
    // pass/fail outcome — but that left the stale rejection as the only
    // entry in the list, and a fully browser-verified frontend app was
    // rejected as failed_final_verification on a mistake fixed three turns
    // earlier.
    seedYolo(db, ws);
    const logsDir = mkdtempSync(join(tmpdir(), "morrow-toolargs-logs-"));
    const supervisor = new ProcessSupervisor(processesRepository(db), logsDir);
    const purpose = "Serve the production build for browser verification";
    const provider = new MockProvider({
      chunks: [
        [tool("noexec", "run_command", { args: ["-e", "require('http').createServer(()=>{}).listen(0);setInterval(()=>{},1000);"], purpose }), done],
        [tool("fixed", "run_command", { executable: "node", args: ["-e", "require('http').createServer(()=>{}).listen(0);setInterval(()=>{},1000);"], purpose, background: true }), done],
        [text("finished"), done],
      ],
      delayMs: 1,
    });
    const runner = new TaskRunner(db, async (d) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, supervisor, maxTurns: 8 }));
    runner.run("t");
    await runner.waitFor("t");

    const noexec = calls(db).find((c: any) => c.id === "noexec")!;
    expect(noexec.status).toBe("failed");
    expect(JSON.parse(noexec.resultJson!)).toMatchObject({ kind: "invalid_tool_arguments", invalidField: "executable" });
    const fixed = calls(db).find((c: any) => c.id === "fixed")!;
    expect(fixed.status).toBe("completed");
    const fixedResult = JSON.parse(fixed.resultJson!);
    expect(fixedResult.status).toBe("running");
    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");

    await supervisor.terminate(fixedResult.processId, { force: true });
    await new Promise((r) => setTimeout(r, 300));
    rmSync(logsDir, { recursive: true, force: true });
  });

  it("returns structured feedback for truncated arguments, then applies a corrected retry", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [rawTool("bad", "create_file", "{\"path\":\"note.txt\",\"content\":\"hi"), done],
        [tool("good", "create_file", { path: "note.txt", content: "hi" }), done],
        [text("finished"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(readFileSync(join(ws, "note.txt"), "utf8")).toBe("hi");

    const bad = calls(db).find((c: any) => c.id === "bad")!;
    expect(bad.status).toBe("failed");
    const feedback = JSON.parse(bad.resultJson!);
    expect(feedback).toMatchObject({
      kind: "malformed_tool_arguments",
      toolName: "create_file",
      reason: "truncated_json",
      retryExhausted: false,
    });
    expect(feedback.expectedSchema).toContain("path");
    // Truncation feedback must name the real cause (cut off / size), not tell
    // the model to fix formatting, and must steer it to a smaller payload.
    expect(feedback.instruction).toMatch(/cut off/i);
    expect(feedback.instruction).toMatch(/smaller/i);
    expect(feedback.instruction).not.toMatch(/single valid JSON object/);

    expect(calls(db).find((c: any) => c.id === "good")!.status).toBe("completed");
    expect(argEvents(db)).toHaveLength(1);
    expect(states(db)).toEqual([
      "idle",
      "understanding",
      "planning",
      "executing_tool",
      "observing",
      "executing_tool",
      "proposing_changes",
      "applying_changes",
      "observing",
      "completed",
    ]);
  });

  it("stops cleanly after a second malformed retry for the same tool", async () => {
    seedYolo(db, ws);
    // Genuinely malformed (not truncated) input: no JSON object at all. This
    // exercises the generic exhausted-budget instruction, distinct from the
    // size-specific guidance truncation now receives (next test).
    const provider = new MockProvider({
      chunks: [
        [rawTool("bad1", "create_file", "garbage, not json"), done],
        [rawTool("bad2", "create_file", "still not json"), done],
        [text("could not parse arguments"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const second = JSON.parse(calls(db).find((c: any) => c.id === "bad2")!.resultJson!);
    expect(second).toMatchObject({ kind: "malformed_tool_arguments", reason: "invalid_json", retryExhausted: true });
    expect(second.instruction).toMatch(/Stop cleanly/);
    expect(argEvents(db)).toHaveLength(2);
    // Nothing was written for either malformed attempt.
    expect(readdirSync(ws)).toHaveLength(0);
    expect(states(db)).not.toContain("applying_changes");
  });

  it("tells a repeatedly-truncated create_file to split into smaller calls, not to fix formatting", async () => {
    // Live bug (Pomodoro build, deepseek-v4-flash): a large multi-line
    // create_file scaffold was cut off mid-string on output-token exhaustion,
    // classified truncated_json, and given the generic "emit valid JSON, no
    // fences/commas" hint — useless, because the JSON was never malformed, only
    // incomplete. The model self-diagnosed ("the first call got truncated") and
    // fell back to raw `node -e` shell writes. Truncation feedback must name the
    // size cause and prescribe a smaller payload at BOTH attempts.
    seedYolo(db, ws);
    const bigOpen = `{"path":"index.html","content":"${"a".repeat(4000)}`; // never closes: truncated mid-string
    const provider = new MockProvider({
      chunks: [
        [rawTool("cut1", "create_file", bigOpen), done],
        [rawTool("cut2", "create_file", bigOpen), done],
        [text("splitting into smaller writes"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const first = JSON.parse(calls(db).find((c: any) => c.id === "cut1")!.resultJson!);
    expect(first).toMatchObject({ kind: "malformed_tool_arguments", reason: "truncated_json", retryExhausted: false });
    expect(first.instruction).toMatch(/cut off/i);
    expect(first.instruction).toMatch(/smaller|single file/i);
    expect(first.instruction).not.toMatch(/Stop cleanly|single valid JSON object/);

    const second = JSON.parse(calls(db).find((c: any) => c.id === "cut2")!.resultJson!);
    expect(second).toMatchObject({ kind: "malformed_tool_arguments", reason: "truncated_json", retryExhausted: true });
    // Even when the budget is exhausted, truncation guidance is about size, not
    // a formatting stop-clean message.
    expect(second.instruction).toMatch(/Split the work|smaller/i);
    expect(second.instruction).not.toMatch(/could not be parsed/i);
    expect(readdirSync(ws)).toHaveLength(0);
  });

  it("rejects a missing required field without mutating the filesystem", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("nopath", "create_file", { content: "orphan" }), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const nopath = JSON.parse(calls(db).find((c: any) => c.id === "nopath")!.resultJson!);
    expect(nopath).toMatchObject({
      kind: "invalid_tool_arguments",
      toolName: "create_file",
      invalidField: "path",
      problem: "missing",
    });
    expect(readdirSync(ws)).toHaveLength(0);
    expect(states(db)).not.toContain("applying_changes");
  });

  it("keeps a failed create_file body in provider context for field repair", async () => {
    seedYolo(db, ws);
    const content = "important body\n".repeat(100);
    const provider = new MockProvider({
      chunks: [
        [tool("missing-path", "create_file", { content }), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const retryRequest = provider.requests[1]!;
    const historical = retryRequest
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.toolCalls ?? [])
      .find((call) => call.id === "missing-path");
    expect(JSON.parse(historical!.function.arguments)).toEqual({ content });
  });

  it("counts parallel invalid calls for one tool as one correction attempt", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [{
          type: "tool_call",
          toolCalls: ["a", "b", "c", "d"].map((id, index) => ({
            id,
            index,
            type: "function" as const,
            function: { name: "create_file", arguments: JSON.stringify({ path: `${id}.txt` }) },
          })),
        }, done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(argEvents(db).map((event: any) => event.payload.attempts)).toEqual([1, 1, 1, 1]);
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) => event.payload.reason === "tool_arguments_unrecoverable")).toBe(false);
  });

  it("keeps correction budgets independent across sequential file targets", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("a", "create_file", { path: "a.txt" }), done],
        [tool("b", "create_file", { path: "b.txt" }), done],
        [tool("c", "create_file", { path: "c.txt" }), done],
        [tool("good", "create_file", { path: "done.txt", content: "done\n" }), done],
        [text("finished"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(argEvents(db).map((event: any) => event.payload.attempts)).toEqual([1, 1, 1]);
    expect(readFileSync(join(ws, "done.txt"), "utf8")).toBe("done\n");
    expect(taskRecordsRepository(db).listEvents("t").some((event: any) => event.payload.reason === "tool_arguments_unrecoverable")).toBe(false);
  });

  const echoedMarker = (path: string) => ({
    path,
    _morrowAppliedWrite: {
      kind: "create_file",
      contentBytes: 2958,
      contentSha256: "da9e3471b3688c7ed78a3e9167519ff6b32dfab65926e86ea288567ed53e47f2",
      instruction: "Historical applied write. Read workspace file for current content.",
    },
    truncatedForContext: true,
    originalArgumentBytes: 3326,
  });

  it("treats an echoed applied-write for an existing file as an idempotent no-op, not a missing-content failure", async () => {
    // Reproduces the production deepseek-v4-pro failure: after really writing a
    // file, the model copies Morrow's own externalized history entry (content
    // stripped, replaced by _morrowAppliedWrite) back as a fresh create_file.
    // Previously the echo was rejected as "content missing", burned the
    // correction budget, and interrupted the whole task.
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("real", "create_file", { path: "src/App.tsx", content: "export default function App(){return null}\n" }), done],
        [tool("echo", "create_file", echoedMarker("src/App.tsx")), done],
        [text("all done"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    const call = calls(db).find((c: any) => c.id === "echo")!;
    expect(call.status).toBe("completed");
    expect(JSON.parse(call.resultJson!).status).toBe("already_applied");
    expect(argEvents(db)).toHaveLength(0);
    expect(
      taskRecordsRepository(db).listEvents("t").some((e: any) => e.payload.reason === "tool_arguments_unrecoverable"),
    ).toBe(false);
    // The no-op must not overwrite the real content already on disk.
    expect(readFileSync(join(ws, "src/App.tsx"), "utf8")).toContain("export default function App");
  });

  it("never exposes Morrow's applied-write marker to the provider after a successful write", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("real", "create_file", { path: "src/App.tsx", content: "export default function App(){return null}\n" }), done],
        [text("all done"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(provider.requests).toHaveLength(2);
    const secondRequest = JSON.stringify(provider.requests[1]);
    expect(secondRequest).not.toContain("_morrowAppliedWrite");
    expect(secondRequest).not.toContain("export default function App");
    expect(secondRequest).toContain("create_file completed for src/App.tsx");
    expect(secondRequest).toContain("historical record, not a tool request");
  });

  it("does NOT no-op an applied-write placeholder for a file that was never written", async () => {
    // A model that has learned the placeholder shape can emit it for a file it
    // never actually created. Skipping it as "already applied" would silently
    // drop a required file, so this must fall through to a real content
    // correction instead of a false success.
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("ghost", "create_file", echoedMarker("src/Missing.tsx")), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const ghost = calls(db).find((c: any) => c.id === "ghost")!;
    expect(ghost.status).toBe("failed");
    const feedback = JSON.parse(ghost.resultJson!);
    expect(feedback).toMatchObject({ invalidField: "content", problem: "missing" });
    // The correction must name the placeholder confusion explicitly so the
    // model stops copying the marker and writes real content.
    expect(feedback.instruction).toMatch(/_morrowAppliedWrite/);
    expect(feedback.instruction).toMatch(/does not exist/);
    expect(existsSync(join(ws, "src/Missing.tsx"))).toBe(false);
  });

  it("still writes normally when real content accompanies the applied-write marker", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("real", "create_file", { path: "note.txt", content: "hello world", _morrowAppliedWrite: { kind: "create_file" } }), done],
        [text("done"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(taskRepository(db).getTaskById("t")!.status).toBe("completed");
    expect(readFileSync(join(ws, "note.txt"), "utf8")).toBe("hello world");
  });

  it("does not let an echoed-placeholder loop for a missing file kill the whole task", async () => {
    // deepseek-v4-pro mimics Morrow's compaction marker for a file it never
    // wrote and ignores corrections. That self-inflicted confusion must not
    // spend the whole-task budget and interrupt an otherwise-recoverable run;
    // the model can still recover by writing real content.
    seedYolo(db, ws);
    const ph = (bytes: number) => ({
      path: "src/Ghost.tsx",
      _morrowAppliedWrite: { kind: "create_file", contentBytes: bytes, contentSha256: `sha${bytes}`, instruction: "Historical applied write." },
      truncatedForContext: true,
      originalArgumentBytes: bytes + 40,
    });
    const provider = new MockProvider({
      chunks: [
        [tool("g1", "create_file", ph(100)), done],
        [tool("g2", "create_file", ph(200)), done],
        [tool("g3", "create_file", ph(300)), done],
        [tool("real", "create_file", { path: "src/Ghost.tsx", content: "export default () => null\n" }), done],
        [text("wrote the file for real"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider, 12);

    expect(
      taskRecordsRepository(db).listEvents("t").some((e: any) => e.payload.reason === "tool_arguments_unrecoverable"),
    ).toBe(false);
    expect(existsSync(join(ws, "src/Ghost.tsx"))).toBe(true);
  });

  it("bounds invented applied-write placeholders across changing file targets", async () => {
    seedYolo(db, ws);
    const ph = (path: string, bytes: number) => ({
      path,
      _morrowAppliedWrite: { kind: "create_file", contentBytes: bytes, contentSha256: `fake-${bytes}`, instruction: "Historical applied write." },
      truncatedForContext: true,
    });
    const provider = new MockProvider({
      chunks: [
        [tool("g1", "create_file", ph("_part_wm.js", 100)), done],
        [tool("g2", "create_file", ph("_part_a_wm.js", 200)), done],
        [tool("g3", "create_file", ph("_part01.js", 300)), done],
        [tool("g4", "create_file", ph("_part02.js", 400)), done],
        [tool("should-not-run", "create_file", { path: "late.txt", content: "late" }), done],
      ],
      delayMs: 1,
    });
    await run(db, provider, 12);

    expect(taskRepository(db).getTaskById("t")!.status).toBe("interrupted");
    expect(calls(db).some((call: any) => call.id === "should-not-run")).toBe(false);
    expect(taskRecordsRepository(db).listEvents("t")).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "task.progress_warning",
        payload: expect.objectContaining({ reason: "tool_arguments_unrecoverable", toolName: "create_file" }),
      }),
    ]));
  });

  it("does not let an echoed propose_patch placeholder loop kill the whole task", async () => {
    seedYolo(db, ws);
    const ph = (bytes: number) => ({
      files: ["src/Ghost.tsx"],
      explanation: "e",
      _morrowAppliedWrite: { kind: "propose_patch", patchBytes: bytes, patchSha256: `sha${bytes}`, instruction: "Historical applied patch." },
      truncatedForContext: true,
      originalArgumentBytes: bytes + 40,
    });
    const provider = new MockProvider({
      chunks: [
        [tool("p1", "propose_patch", ph(100)), done],
        [tool("p2", "propose_patch", ph(200)), done],
        [tool("p3", "propose_patch", ph(300)), done],
        [tool("real", "create_file", { path: "src/Ghost.tsx", content: "export default () => null\n" }), done],
        [text("recovered"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider, 12);

    expect(
      taskRecordsRepository(db).listEvents("t").some((e: any) => e.payload.reason === "tool_arguments_unrecoverable"),
    ).toBe(false);
    expect(existsSync(join(ws, "src/Ghost.tsx"))).toBe(true);
  });

  it("keeps propose_patch correction budgets independent across target files", async () => {
    // Reproduces the production deepseek-v4-pro failure (task 98159b5c): three
    // propose_patch calls on THREE DIFFERENT files, each with a missing patch,
    // collapsed onto one shared correction budget (propose_patch has no `path`),
    // climbed 1→2→3, and interrupted the whole task as
    // `tool_arguments_unrecoverable` even though each was a distinct first
    // attempt on a distinct file.
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("pa", "propose_patch", { files: ["a.ts"], explanation: "e" }), done],
        [tool("pb", "propose_patch", { files: ["b.ts"], explanation: "e" }), done],
        [tool("pc", "propose_patch", { files: ["c.ts"], explanation: "e" }), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    expect(argEvents(db).map((event: any) => event.payload.attempts)).toEqual([1, 1, 1]);
    expect(
      taskRecordsRepository(db)
        .listEvents("t")
        .some((event: any) => event.payload.reason === "tool_arguments_unrecoverable"),
    ).toBe(false);
  });

  it("redirects an unrecoverable propose_patch to create_file for the same file", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("p1", "propose_patch", { files: ["x.ts"], explanation: "e" }), done],
        [tool("p2", "propose_patch", { files: ["x.ts"], explanation: "e" }), done],
        [text("ok"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const p2 = JSON.parse(calls(db).find((c: any) => c.id === "p2")!.resultJson!);
    expect(p2).toMatchObject({
      kind: "invalid_tool_arguments",
      toolName: "propose_patch",
      invalidField: "patch",
      retryExhausted: true,
    });
    expect(p2.instruction).toMatch(/create_file/);
  });

  it("rejects an absolute path argument as a structured correction", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("abs", "create_file", { path: "C:\\Windows\\evil.txt", content: "x" }), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const abs = JSON.parse(calls(db).find((c: any) => c.id === "abs")!.resultJson!);
    expect(abs).toMatchObject({ kind: "invalid_tool_arguments", invalidField: "path", problem: "absolute_path" });
    expect(existsSync(join(ws, "evil.txt"))).toBe(false);
    expect(states(db)).not.toContain("applying_changes");
  });

  it("rejects a wrong argument type before dispatch", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [tool("wtype", "propose_patch", { patch: 123, explanation: "x", files: [] }), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const wtype = JSON.parse(calls(db).find((c: any) => c.id === "wtype")!.resultJson!);
    expect(wtype).toMatchObject({ kind: "invalid_tool_arguments", invalidField: "patch", problem: "wrong_type", expected: "string" });
    expect(states(db)).not.toContain("applying_changes");
  });

  it("rejects merged tool calls as ambiguous and writes nothing", async () => {
    seedYolo(db, ws);
    const provider = new MockProvider({
      chunks: [
        [rawTool("merged", "create_file", "{\"path\":\"a.txt\",\"content\":\"x\"}{\"path\":\"b.txt\",\"content\":\"y\"}"), done],
        [text("stopped"), done],
      ],
      delayMs: 1,
    });
    await run(db, provider);

    const merged = JSON.parse(calls(db).find((c: any) => c.id === "merged")!.resultJson!);
    expect(merged).toMatchObject({ kind: "malformed_tool_arguments", reason: "multiple_tool_calls_merged" });
    expect(readdirSync(ws)).toHaveLength(0);
    expect(states(db)).not.toContain("applying_changes");
  });
});
