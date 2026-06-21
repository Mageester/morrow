import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { MockProvider } from "../src/provider/mock.js";
import { IncomingMessage } from "node:http";
import * as http from "node:http";

async function run() {
  // The server routes a chat to the mock provider when MOCK_PROVIDER is set; the
  // injected MockProvider below is what actually streams the deterministic turns.
  process.env.MOCK_PROVIDER = "true";
  const tempDir = mkdtempSync(join(tmpdir(), "morrow-agent-smoke-"));
  const wsDir = join(tempDir, "workspace");
  mkdirSync(wsDir);
  writeFileSync(join(wsDir, "evidence.txt"), "Morrow Agent Smoke Test Content");
  
  const dbPath = join(tempDir, "morrow.db");
  const db = openDatabase(dbPath);
  
  const mockProvider = new MockProvider({
    chunks: [
      // Turn 0: LLM decides to call the tool
      [
        {
          type: "tool_call",
          toolCalls: [
            {
              id: "call-smoke-1",
              index: 0,
              type: "function",
              function: { name: "read_file", arguments: JSON.stringify({ path: "evidence.txt" }) }
            }
          ]
        },
        { type: "done" }
      ],
      // Turn 1: LLM answers based on tool call
      [
        { type: "text", text: "Smoke response content: Morrow verified." },
        { type: "done" }
      ]
    ]
  });

  const runner = new TaskRunner(db, async (deps) => {
    const task = taskRepository(db).getTaskById(deps.taskId);
    if (task?.kind === "agent_chat") {
      const { executeAgentChatTask } = await import("../src/execution/agent.js");
      await executeAgentChatTask({
        db,
        taskId: deps.taskId,
        provider: mockProvider,
        ...(deps.abortSignal ? { abortSignal: deps.abortSignal } : {})
      });
    }
  });
  
  const app = buildServer({ db, runner, sseIntervalMs: 10 });

  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as any;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  console.log("Started agent orchestrator smoke at", baseUrl);

  try {
    // 1. Create project
    const createProjectRes = await fetch(`${baseUrl}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Agent Smoke Project", workspacePath: wsDir })
    });
    const project = await createProjectRes.json();
    if (![200, 201].includes(createProjectRes.status)) {
      throw new Error(`Failed to create project: ${JSON.stringify(project)}`);
    }

    // 2. Create conversation
    const createConvRes = await fetch(`${baseUrl}/api/projects/${project.id}/conversations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Smoke Chat" })
    });
    const conversation = await createConvRes.json();
    if (createConvRes.status !== 200) throw new Error("Failed to create conversation");

    // 3. Send message (which starts the task)
    const sendMsgRes = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Smoke message content" })
    });
    const { task, assistantMessage } = await sendMsgRes.json();
    if (sendMsgRes.status !== 202) throw new Error(`Expected 202 Accepted, got ${sendMsgRes.status}`);

    const sseEvents: any[] = [];
    const streamPromise = new Promise<void>((resolve, reject) => {
      http.get(`${baseUrl}/api/tasks/${task.id}/events/stream`, (res: IncomingMessage) => {
        if (res.statusCode !== 200) return reject(new Error(`SSE status ${res.statusCode}`));
        let buffer = '';
        res.on('data', chunk => {
          buffer += chunk.toString();
          const parts = buffer.split('\n\n');
          buffer = parts.pop() || '';
          
          for (const part of parts) {
            const lines = part.split('\n');
            const idLine = lines.find(l => l.startsWith('id: '));
            const eventLine = lines.find(l => l.startsWith('event: '));
            const dataLine = lines.find(l => l.startsWith('data: '));
            
            if (idLine && eventLine && dataLine) {
              const event = JSON.parse(dataLine.substring(6));
              sseEvents.push(event);
            }
          }
        });
        
        res.on('end', () => resolve());
        res.on('error', reject);
      }).on('error', reject);
    });

    // Wait for stream and execution
    await runner.waitFor(task.id);
    await streamPromise;

    // Verify task aggregate
    const aggRes = await fetch(`${baseUrl}/api/tasks/${task.id}`);
    const agg = await aggRes.json();

    if (agg.task.status !== "completed") throw new Error(`Expected completed status, got ${agg.task.status}`);
    if (agg.plan.length !== 3) throw new Error("Expected 3 plan steps");
    if (agg.evidence.length !== 1) throw new Error("Expected 1 evidence file");
    if (agg.evidence[0].path !== "evidence.txt") throw new Error("Evidence mismatch");
    if (agg.disclosure.provider !== "mock") throw new Error("Expected mock provider disclosure");

    // Verify conversation message completion
    const messagesRes = await fetch(`${baseUrl}/api/conversations/${conversation.id}/messages`);
    const messages = await messagesRes.json();
    const assistantMsg = messages.find((m: any) => m.role === "assistant");
    if (!assistantMsg) throw new Error("Assistant message not found");
    if (assistantMsg.content !== "Smoke response content: Morrow verified.") throw new Error("Response content mismatch");
    if (assistantMsg.streamingState !== "completed") throw new Error("Expected completed streaming state");

    console.log("Agent Alpha E2E smoke test passed successfully!");
  } finally {
    await app.close();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

run().catch(e => {
  console.error("Agent Alpha smoke test failed:", e);
  process.exit(1);
});
