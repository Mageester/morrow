import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { MockProvider } from "../src/provider/mock.js";

describe("agent git tools", () => {
  let db = openDatabase(":memory:");
  let root = "";

  afterEach(() => {
    db.close();
    if (root) rmSync(root, { recursive: true, force: true });
    db = openDatabase(":memory:");
    root = "";
  });

  it("runs bounded git status through the shared agent tool loop", async () => {
    root = mkdtempSync(join(tmpdir(), "morrow-agent-git-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Morrow Test");
    writeFileSync(join(root, "src.ts"), "export const value = 1;\n");
    git("add", "src.ts");
    git("commit", "-m", "initial");
    writeFileSync(join(root, "src.ts"), "export const value = 2;\n");

    const createdAt = new Date().toISOString();
    projectRepository(db).createProject({ id: "project", name: "Project", workspacePath: root, createdAt });
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "conversation", projectId: "project", title: "Chat", createdAt, updatedAt: createdAt });
    conversations.appendMessage({ id: "user", conversationId: "conversation", role: "user", content: "Show status", createdAt, updatedAt: createdAt });
    taskRepository(db).createTask({ id: "task", projectId: "project", kind: "agent_chat", status: "queued", createdAt });
    conversations.appendMessage({ id: "assistant", conversationId: "conversation", role: "assistant", content: "", taskId: "task", streamingState: "queued", provider: "mock", model: "mock", createdAt, updatedAt: createdAt });

    const provider = new MockProvider({ chunks: [
      [{ type: "tool_call", toolCalls: [{ id: "git-status", index: 0, type: "function", function: { name: "git_status", arguments: "{}" } }] }, { type: "done" }],
      [{ type: "text", text: "Status inspected." }, { type: "done" }],
    ] });
    await executeAgentChatTask({ db, taskId: "task", provider });

    const call = conversations.listToolCallsForTask("task")[0];
    expect(call).toMatchObject({ toolName: "git_status", status: "completed" });
    expect(call?.resultJson).toContain("src.ts");
  });

  it("scopes agent git status to a registered child workspace inside an ancestor repo", async () => {
    root = mkdtempSync(join(tmpdir(), "morrow-agent-git-parent-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
    git("init");
    git("checkout", "-b", "parent-branch");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Morrow Test");
    writeFileSync(join(root, "parent.ts"), "export const parent = 1;\n");
    git("add", "parent.ts");
    git("commit", "-m", "initial");
    writeFileSync(join(root, "parent.ts"), "export const parent = 2;\n");
    const child = join(root, "Tests", "Beta26-Nested-Workspace");
    mkdirSync(child, { recursive: true });

    const createdAt = new Date().toISOString();
    projectRepository(db).createProject({ id: "project", name: "Project", workspacePath: child, createdAt });
    const conversations = conversationsRepository(db);
    conversations.createConversation({ id: "conversation", projectId: "project", title: "Chat", createdAt, updatedAt: createdAt });
    conversations.appendMessage({ id: "user", conversationId: "conversation", role: "user", content: "Show status", createdAt, updatedAt: createdAt });
    taskRepository(db).createTask({ id: "task", projectId: "project", kind: "agent_chat", status: "queued", createdAt });
    conversations.appendMessage({ id: "assistant", conversationId: "conversation", role: "assistant", content: "", taskId: "task", streamingState: "queued", provider: "mock", model: "mock", createdAt, updatedAt: createdAt });

    const provider = new MockProvider({ chunks: [
      [{ type: "tool_call", toolCalls: [{ id: "git-status", index: 0, type: "function", function: { name: "git_status", arguments: "{}" } }] }, { type: "done" }],
      [{ type: "text", text: "Status inspected." }, { type: "done" }],
    ] });
    await executeAgentChatTask({ db, taskId: "task", provider });

    const call = conversations.listToolCallsForTask("task")[0];
    expect(call).toMatchObject({ toolName: "git_status", status: "completed" });
    expect(call?.resultJson).toContain("ancestor Git repository detected");
    expect(call?.resultJson).not.toContain("parent-branch");
    expect(call?.resultJson).not.toContain("parent.ts");
  });
});
