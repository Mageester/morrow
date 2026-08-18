import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../database.js";
import { executeAgentChatTask } from "../execution/agent.js";
import { dispatchAgentTask } from "../mission/task-dispatcher.js";
import { WORKING_SET_DEFAULTS } from "../execution/conversation-working-set.js";
import { conversationsRepository } from "../repositories/conversations.js";
import { projectRepository } from "../repositories/projects.js";
import { taskRecordsRepository } from "../repositories/task-records.js";
import { taskRepository } from "../repositories/tasks.js";
import type { AiProvider, ChatMessage, ProviderChunk } from "../provider/base.js";

/**
 * Long-session efficiency scenario.
 *
 * Unit tests exercise one agent run at a time. Real use is a long chat: many
 * user turns against one project, where the expensive failure is not a crash
 * but waste — re-listing the same directories, re-reading the same files, and
 * re-running a command that already failed, once per turn, forever.
 *
 * This scenario drives the real production path (`dispatchAgentTask` ->
 * `executeAgentChatTask`) through one conversation: six scripted turns that
 * explore, locate, edit, verify, retry, and document, then a sustained tail of
 * further turns that keeps the session growing. It measures that waste
 * directly. The only injected boundary is the external model turn.
 *
 * The stand-in model is deliberately *reactive*, not scripted: on every turn it
 * inspects the transcript it was actually handed and follows one rule a
 * competent model follows — do not rediscover what the transcript already
 * tells you, and do not re-run a command the transcript already shows failing
 * against unchanged files. So the metrics below measure what Morrow carried
 * across turns, not what a script decided to emit.
 */

const DISCOVERY_TOOLS = new Set(["inspect_workspace", "list_files", "search_text", "search_files", "search_symbols"]);

export interface LongSessionAcceptanceResult {
  scenarioId: "long-session-efficiency-v1";
  passed: boolean;
  message: string | null;
  userTurns: number;
  totalToolCalls: number;
  /** Discovery calls issued after the first turn. A session with working memory needs none. */
  redundantDiscoveryCalls: number;
  /** Re-runs of a command the durable record already showed failing on unchanged files. */
  repeatedFailingCommands: number;
  /** Turns that answered from carried memory instead of re-exploring. */
  turnsAnsweredFromMemory: number;
  /**
   * Turns Morrow itself failed to carry out. A turn whose verification command
   * honestly failed is NOT counted here: refusing to call an unverified result
   * complete is the product working, not breaking.
   */
  failedTurns: number;
  /** Turns stopped by an honestly reported failing verification. */
  honestlyBlockedTurns: number;
  timeoutPatched: boolean;
  changelogCreated: boolean;
  /** Largest working-set contribution seen on any turn, in characters. */
  maxWorkingSetChars: number;
  /** Largest opening request seen on any turn, in characters. */
  maxPromptChars: number;
  /** Per-turn record, so a failing run is diagnosable from the report alone. */
  turns: TurnTrace[];
}

export interface TurnTrace {
  prompt: string;
  taskId: string;
  status: string;
  /** Interrupt reason when the turn did not reach a terminal success state. */
  interruptReason: string | null;
  toolNames: string[];
  discoveryCalls: number;
  answeredFromMemory: boolean;
  /** Characters in the opening request of this turn. */
  promptChars: number;
  /** Characters the carried working set contributed to that request. */
  workingSetChars: number;
}

/** Turns appended after the scripted phase, to keep the session honestly long. */
const SUSTAINED_TURNS = 20;

/** Stopping short because a verification command failed is correct behavior. */
const HONEST_BLOCK_REASONS = new Set(["unverified_completion"]);

function writeFixture(workspace: string): void {
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "long-session-fixture", private: true, scripts: { test: "node test.js" } }, null, 2)}\n`,
  );
  writeFileSync(join(workspace, "src/config.js"), "exports.REQUEST_TIMEOUT_MS = 1000;\n");
  // Second, deliberately unrepaired defect: the effective timeout is zeroed
  // here, so the suite keeps failing after the config change. That is what
  // makes "run it again" a measurably wasted turn without working memory.
  writeFileSync(join(workspace, "src/client.js"), "const { REQUEST_TIMEOUT_MS } = require('./config.js');\nexports.timeout = () => REQUEST_TIMEOUT_MS * 0;\n");
  writeFileSync(join(workspace, "src/server.js"), "const { timeout } = require('./client.js');\nexports.start = () => timeout();\n");
  writeFileSync(join(workspace, "src/index.js"), "const { start } = require('./server.js');\nconsole.log(start());\n");
  writeFileSync(
    join(workspace, "test.js"),
    [
      "const { start } = require('./src/server.js');",
      "const effective = start();",
      "if (effective !== 5000) {",
      "  console.error('expected an effective timeout of 5000, got ' + effective);",
      "  process.exit(1);",
      "}",
      "console.log('ok');",
      "",
    ].join("\n"),
  );
}

function workingSetText(messages: ChatMessage[]): string {
  return messages
    .filter((message) => message.role === "system" && message.content.startsWith("Work you already completed"))
    .map((message) => message.content)
    .join("\n");
}

function toolResultsThisTurn(messages: ChatMessage[]): string[] {
  return messages.filter((message) => message.role === "tool").map((message) => message.content);
}

function call(id: string, name: string, args: Record<string, unknown>): ProviderChunk {
  return {
    type: "tool_call",
    toolCalls: [{ id, index: 0, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  };
}

const SOURCE_FILES = ["src/config.js", "src/client.js", "src/server.js", "src/index.js"];

/**
 * One reactive stand-in model shared by every turn. `intent` selects what the
 * user asked for; every decision inside a turn is taken from the transcript.
 */
function reactiveModel(intent: string): (messages: ChatMessage[]) => ProviderChunk[] {
  return (messages) => {
    const memory = workingSetText(messages);
    const done = toolResultsThisTurn(messages);
    const knowsSources = SOURCE_FILES.every((file) => memory.includes(file));
    const knowsTestFailed = /`node test\.js`[^\n]*exit 1/.test(memory) || /`npm test`[^\n]*exit 1/.test(memory);

    switch (intent) {
      case "explore": {
        // First turn: nothing is known yet, so discovery is legitimate work.
        if (done.length === 0) return [call("t1-inspect", "inspect_workspace", {}), { type: "done" }];
        if (done.length === 1) return [call("t1-list", "list_files", { path: "src" }), { type: "done" }];
        if (done.length - 2 < SOURCE_FILES.length) {
          const next = SOURCE_FILES[done.length - 2]!;
          return [call(`t1-read-${done.length - 2}`, "read_file", { path: next }), { type: "done" }];
        }
        return [{ type: "text", text: "A tiny request client whose timeout comes from a shared config module." }, { type: "done" }];
      }

      case "locate": {
        // Answering "which file defines the timeout" needs no new discovery
        // when the record already names the files this conversation read.
        if (knowsSources) {
          return [{ type: "text", text: "src/config.js defines REQUEST_TIMEOUT_MS; src/client.js consumes it." }, { type: "done" }];
        }
        if (done.length === 0) return [call("t2-inspect", "inspect_workspace", {}), { type: "done" }];
        if (done.length === 1) return [call("t2-list", "list_files", { path: "src" }), { type: "done" }];
        if (done.length - 2 < SOURCE_FILES.length) {
          const next = SOURCE_FILES[done.length - 2]!;
          return [call(`t2-read-${done.length - 2}`, "read_file", { path: next }), { type: "done" }];
        }
        return [{ type: "text", text: "src/config.js defines REQUEST_TIMEOUT_MS." }, { type: "done" }];
      }

      case "patch": {
        // Without the record this turn has to rediscover where the constant
        // lives; with it, the read goes straight to the known file.
        const step = knowsSources ? done.length : done.length - 1;
        if (step < 0) return [call("t3-list", "list_files", { path: "src" }), { type: "done" }];
        if (step === 0) return [call("t3-read", "read_file", { path: "src/config.js" }), { type: "done" }];
        if (step === 1) {
          return [
            call("t3-patch", "propose_patch", {
              patch: [
                "--- a/src/config.js",
                "+++ b/src/config.js",
                "@@ -1 +1 @@",
                "-exports.REQUEST_TIMEOUT_MS = 1000;",
                "+exports.REQUEST_TIMEOUT_MS = 5000;",
                "",
              ].join("\n"),
            }),
            { type: "done" },
          ];
        }
        return [{ type: "text", text: "Raised REQUEST_TIMEOUT_MS to 5000 in src/config.js." }, { type: "done" }];
      }

      case "verify": {
        if (done.length === 0) {
          return [call("t4-test", "run_command", { executable: "node", args: ["test.js"], purpose: "verify the timeout change" }), { type: "done" }];
        }
        return [{ type: "text", text: "Ran the test suite; it still reports a failure." }, { type: "done" }];
      }

      case "retry": {
        // The point of the record: a command already shown failing against an
        // unchanged tree is not worth re-running blind.
        if (knowsTestFailed && done.length === 0) {
          return [{ type: "text", text: "`node test.js` already failed on this exact tree — src/client.js zeroes the timeout, so that has to be repaired before another run means anything." }, { type: "done" }];
        }
        if (done.length === 0) {
          return [call("t5-test", "run_command", { executable: "node", args: ["test.js"], purpose: "re-run the test suite" }), { type: "done" }];
        }
        return [{ type: "text", text: "Re-ran the test suite." }, { type: "done" }];
      }

      case "document": {
        const step = knowsSources ? done.length : done.length - 1;
        if (step < 0) return [call("t6-list", "list_files", { path: "." }), { type: "done" }];
        if (step === 0) {
          return [call("t6-write", "create_file", { path: "CHANGELOG.md", content: "# Changelog\n\n- Raised REQUEST_TIMEOUT_MS to 5000.\n" }), { type: "done" }];
        }
        return [{ type: "text", text: "Recorded the change in CHANGELOG.md." }, { type: "done" }];
      }

      default:
        return [{ type: "text", text: "No action." }, { type: "done" }];
    }
  };
}

class ReactiveProvider implements AiProvider {
  readonly id = "mock";
  readonly route = {
    providerId: "mock",
    protocol: "mock" as const,
    endpointKind: "injected" as const,
    endpointHost: null,
    endpointLimitTokens: 200_000,
    endpointLimitSource: "fallback" as const,
  };
  readonly requests: ChatMessage[][] = [];
  constructor(private readonly decide: (messages: ChatMessage[]) => ProviderChunk[]) {}
  async *streamChat(messages: ChatMessage[]): AsyncIterable<ProviderChunk> {
    this.requests.push(messages.map((message) => ({ ...message })));
    for (const chunk of this.decide(messages)) yield chunk;
  }
}

export async function runLongSessionAcceptance(input: { root: string }): Promise<LongSessionAcceptanceResult> {
  const workspace = join(input.root, "workspace");
  const home = join(input.root, "product-home");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFixture(workspace);

  const priorHome = process.env.MORROW_HOME;
  const priorMock = process.env.MOCK_PROVIDER;
  process.env.MORROW_HOME = home;
  process.env.MOCK_PROVIDER = "true";

  const db = openDatabase(join(input.root, "long-session.db"));
  const projectId = "project-long-session";
  const conversationId = "conversation-long-session";
  const now = new Date().toISOString();

  try {
    projectRepository(db).createProject({ id: projectId, name: "Long session", workspacePath: workspace, createdAt: now });
    const convs = conversationsRepository(db);
    convs.createConversation({ id: conversationId, projectId, title: "Long session", createdAt: now, updatedAt: now });

    const tasks = taskRepository(db);
    const records = taskRecordsRepository(db);
    const runner = { run: () => {}, cancel: () => {} };
    const traces: TurnTrace[] = [];

    const turn = async (prompt: string, decide: (messages: ChatMessage[]) => ProviderChunk[]) => {
      const dispatched = dispatchAgentTask({ db, runner, env: process.env }, { conversationId, content: prompt, mode: "agent" as const, autoApprove: true });
      const provider = new ReactiveProvider(decide);
      await executeAgentChatTask({ db, taskId: dispatched.task.id, provider, maxTurns: 12 });
      const toolCalls = convs.listToolCallsForTask(dispatched.task.id);
      const toolNames = toolCalls.map((entry) => entry.toolName);
      const interrupt = records
        .getAggregate(dispatched.task.id)
        .events.filter((entry) => entry.type === "task.interrupted" || entry.type === "task.failed")
        .at(-1);
      const opening = provider.requests[0] ?? [];
      traces.push({
        prompt,
        taskId: dispatched.task.id,
        status: tasks.getTaskById(dispatched.task.id)?.status ?? "missing",
        interruptReason: typeof interrupt?.payload.reason === "string" ? interrupt.payload.reason : null,
        toolNames,
        discoveryCalls: toolNames.filter((name) => DISCOVERY_TOOLS.has(name)).length,
        // A turn answered from memory reached its answer without any discovery.
        answeredFromMemory: toolNames.every((name) => !DISCOVERY_TOOLS.has(name)),
        promptChars: opening.reduce((sum, message) => sum + message.content.length, 0),
        workingSetChars: workingSetText(opening).length,
      });
    };

    await turn("Explore this project and tell me what it does.", reactiveModel("explore"));
    await turn("Which file defines the request timeout?", reactiveModel("locate"));
    await turn("Raise that timeout to 5000 and change nothing else.", reactiveModel("patch"));
    await turn("Run the tests.", reactiveModel("verify"));
    await turn("Try the tests again.", reactiveModel("retry"));
    await turn("Add a CHANGELOG.md entry for that change.", reactiveModel("document"));

    // Sustained phase: keep the same conversation going well past the point
    // where a chat is "short". Each turn touches a distinct new file, so the
    // durable record keeps growing and the bounding actually has to hold.
    const scratch = join(workspace, "notes");
    mkdirSync(scratch, { recursive: true });
    for (let index = 0; index < SUSTAINED_TURNS; index++) {
      writeFileSync(join(scratch, `note-${index}.md`), `# Note ${index}\n\nBackground for topic ${index}.\n`);
      const path = `notes/note-${index}.md`;
      await turn(`Read ${path} and summarize it in one line.`, (messages) =>
        toolResultsThisTurn(messages).length === 0
          ? [call(`sustain-${index}`, "read_file", { path }), { type: "done" }]
          : [{ type: "text", text: `Note ${index} covers topic ${index}.` }, { type: "done" }],
      );
    }

    const followUps = traces.slice(1);
    const redundantDiscoveryCalls = followUps.reduce((sum, trace) => sum + trace.discoveryCalls, 0);
    const repeatedFailingCommands = (traces[4]?.toolNames ?? []).filter((name) => name === "run_command").length;
    const turnsAnsweredFromMemory = followUps.filter((trace) => trace.answeredFromMemory).length;
    const unfinished = traces.filter((trace) => trace.status !== "completed" && trace.status !== "verified");
    const honestlyBlockedTurns = unfinished.filter((trace) => trace.interruptReason !== null && HONEST_BLOCK_REASONS.has(trace.interruptReason)).length;
    const failedTurns = unfinished.length - honestlyBlockedTurns;
    const totalToolCalls = traces.reduce((sum, trace) => sum + trace.toolNames.length, 0);

    const timeoutPatched = (traces[2]?.toolNames ?? []).includes("propose_patch");
    const changelogCreated = (traces[5]?.toolNames ?? []).includes("create_file");
    const maxWorkingSetChars = Math.max(...traces.map((trace) => trace.workingSetChars));
    const maxPromptChars = Math.max(...traces.map((trace) => trace.promptChars));

    const problems: string[] = [];
    // Carried memory must be bounded: a session that keeps chatting cannot pay
    // an ever-growing per-turn tax for remembering what it already did.
    if (maxWorkingSetChars > WORKING_SET_DEFAULTS.maxChars + 600) {
      problems.push(`the carried working set grew to ${maxWorkingSetChars} characters`);
    }
    if (failedTurns > 0) {
      const detail = unfinished
        .filter((trace) => trace.interruptReason === null || !HONEST_BLOCK_REASONS.has(trace.interruptReason))
        .map((trace) => `${trace.status}/${trace.interruptReason ?? "unrecorded"}`)
        .join(", ");
      problems.push(`${failedTurns} turn(s) failed to carry out the request (${detail})`);
    }
    if (redundantDiscoveryCalls > 0) problems.push(`${redundantDiscoveryCalls} redundant discovery call(s) after the first turn`);
    if (repeatedFailingCommands > 0) problems.push(`re-ran a command already recorded as failing (${repeatedFailingCommands}x)`);
    if (!timeoutPatched) problems.push("the patch turn did not patch");
    if (!changelogCreated) problems.push("the documentation turn did not write CHANGELOG.md");

    return {
      scenarioId: "long-session-efficiency-v1",
      passed: problems.length === 0,
      message: problems.length === 0 ? null : problems.join("; "),
      userTurns: traces.length,
      totalToolCalls,
      redundantDiscoveryCalls,
      repeatedFailingCommands,
      turnsAnsweredFromMemory,
      failedTurns,
      honestlyBlockedTurns,
      timeoutPatched,
      changelogCreated,
      maxWorkingSetChars,
      maxPromptChars,
      turns: traces,
    };
  } finally {
    db.close();
    if (priorHome === undefined) delete process.env.MORROW_HOME;
    else process.env.MORROW_HOME = priorHome;
    if (priorMock === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = priorMock;
  }
}
