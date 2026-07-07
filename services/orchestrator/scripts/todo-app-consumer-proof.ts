/**
 * Consumer proof for the YOLO usability fixes.
 *
 * Drives the REAL orchestrator agent pipeline (executeAgentChatTask) against the
 * exact target directory a user would launch Morrow in, using a scripted
 * provider that stands in for the model: it creates a full React + Vite +
 * TypeScript Todo app with create_file, then runs `npm install` and
 * `npm run build` with run_command — all under YOLO (auto-approve).
 *
 * This exercises every fix end to end: OneDrive workspace-boundary containment,
 * file creation, summary clamping, YOLO auto-approve, command execution with the
 * long-running timeout, and change-set capture that /changes and /diff read.
 *
 * Run: npx tsx scripts/todo-app-consumer-proof.ts
 */
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { taskRoutingRepository } from "../src/repositories/task-routing.js";
import { approvalsRepository } from "../src/repositories/approvals.js";
import { changeSetsRepository } from "../src/repositories/change-sets.js";
import { MockProvider } from "../src/provider/mock.js";
import { executeAgentChatTask } from "../src/execution/agent.js";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TODO_APP_FILES } from "./todo-app-files.js";

const TARGET = process.argv[2] || process.env.MORROW_PROOF_TARGET || "C:\\Users\\aidan\\OneDrive\\Documents\\Morrow\\Tests\\Todo-App";

const iso = () => new Date().toISOString();
const tool = (id: string, name: string, args: unknown) => ({
  type: "tool_call" as const,
  toolCalls: [{ id, index: 0, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }],
});
const done = { type: "done" as const };
const text = (t: string) => ({ type: "text" as const, text: t });

async function main() {
  // A user "launches Morrow inside this directory" — ensure it exists and is clean.
  mkdirSync(TARGET, { recursive: true });
  for (const entry of ["src", "node_modules", "dist", "package.json", "package-lock.json", "index.html", "vite.config.ts", "tsconfig.json"]) {
    rmSync(join(TARGET, entry), { recursive: true, force: true });
  }
  const workspacePath = realpathSync(TARGET);
  console.log(`workspace (realpath): ${workspacePath}`);

  const db: any = openDatabase(":memory:");
  projectRepository(db).createProject({ id: "p", name: "Todo-App", workspacePath, createdAt: iso() });
  conversationsRepository(db).createConversation({ id: "c", projectId: "p", title: "todo", createdAt: iso(), updatedAt: iso() });
  conversationsRepository(db).appendMessage({ id: "mu", conversationId: "c", role: "user", content: "Create a modern React + Vite + TypeScript Todo app in the current directory.", createdAt: iso(), updatedAt: iso() });
  taskRepository(db).createTask({ id: "t", projectId: "p", kind: "agent_chat", status: "queued", createdAt: iso() });
  conversationsRepository(db).appendMessage({ id: "ma", conversationId: "c", role: "assistant", content: "", taskId: "t", createdAt: iso(), updatedAt: iso() });
  taskRoutingRepository(db).upsert({
    taskId: "t", presetId: "best-quality", providerId: "mock", model: "mock-model", useMemory: false,
    decision: { version: 1, presetId: "best-quality", providerId: "mock", model: "mock-model", reason: "proof", fallbackUsed: false, overridden: false, privacy: "cloud", candidates: [], mode: "agent", autoApprove: true },
    createdAt: iso(),
  });
  taskRecordsRepository(db).transitionAgentState("t", { id: "s0", state: "idle", details: {}, createdAt: iso() });

  // Scripted "model": one create_file per file, then install + build, then done.
  const turns: any[][] = [];
  let n = 0;
  // Prove create_directory works too (parents are auto-made, but this is explicit).
  turns.push([tool(`d${n++}`, "create_directory", { path: "src" }), done]);
  for (const file of TODO_APP_FILES) {
    turns.push([tool(`f${n++}`, "create_file", { path: file.path, content: file.content, purpose: `scaffold ${file.path}` }), done]);
  }
  turns.push([tool(`c${n++}`, "run_command", { executable: "npm", args: ["install"], purpose: "install dependencies" }), done]);
  turns.push([tool(`c${n++}`, "run_command", { executable: "npm", args: ["run", "build"], purpose: "verify the build" }), done]);
  turns.push([text("Todo app created and built."), done]);

  const provider = new MockProvider({ chunks: turns, delayMs: 0 });
  const runner = new TaskRunner(db, async (d: any) => executeAgentChatTask({ db: d.db, taskId: d.taskId, provider, maxTurns: turns.length + 4 }));
  const startedAt = Date.now();
  runner.run("t");
  await runner.waitFor("t");
  console.log(`\nrun finished in ${Math.round((Date.now() - startedAt) / 1000)}s`);

  // ---- Report ----
  const task = taskRepository(db).getTaskById("t");
  console.log(`\ntask status: ${task!.status}`);

  const toolCalls = conversationsRepository(db).listToolCallsForTask("t");
  const parse = (s?: string | null) => { try { return JSON.parse(s || "{}"); } catch { return {}; } };
  console.log("\ntool calls:");
  let anyFailed = false;
  for (const tc of toolCalls) {
    const p = parse(tc.resultJson);
    const args = parse(tc.argsJson);
    const label = tc.toolName === "run_command" ? `${args.executable} ${(args.args || []).join(" ")}` : (args.path ?? "");
    const detail = tc.toolName === "run_command" ? `exit=${p.exitCode} (${p.terminationReason})` : (tc.status === "failed" ? tc.errorMessage : "ok");
    if (tc.status === "failed") anyFailed = true;
    console.log(`  [${tc.status}] ${tc.toolName} ${label} -> ${detail}`);
  }

  const events = taskRecordsRepository(db).listEvents("t");
  const approvalRequested = events.some((e: any) => e.type === "approval.requested");
  const approvals = approvalsRepository(db).listByTask("t");
  console.log(`\napprovals: ${approvals.length} total, all approved=${approvals.every((a) => a.status === "approved")}, any surfaced to human=${approvalRequested}`);

  const changeSets = changeSetsRepository(db).listByTask("t");
  const changedFiles = new Set<string>();
  for (const cs of changeSets) for (const f of Object.keys(cs.postApplyHashes ?? {})) changedFiles.add(f);
  console.log(`\nchange sets: ${changeSets.length}; files reflected in /changes & /diff:`);
  for (const f of [...changedFiles].sort()) console.log(`  ${f}`);

  const distExists = existsSync(join(workspacePath, "dist", "index.html"));
  const installCall = toolCalls.find((c: any) => c.toolName === "run_command" && (c.argsJson || "").includes("install"));
  const buildCall = toolCalls.find((c: any) => c.toolName === "run_command" && (c.argsJson || "").includes("build"));
  const installResult = installCall ? parse(installCall.resultJson) : null;
  const buildResult = buildCall ? parse(buildCall.resultJson) : null;
  const buildOk = buildResult?.exitCode === 0 && distExists;

  console.log("\n==== CONSUMER PROOF SUMMARY ====");
  console.log(`created inside target dir : ${existsSync(join(workspacePath, "src", "App.tsx"))}`);
  console.log(`no tool failed            : ${!anyFailed}`);
  console.log(`no human approval prompt  : ${!approvalRequested}`);
  console.log(`npm install exit code     : ${installResult?.exitCode}`);
  console.log(`npm run build exit code   : ${buildResult?.exitCode}`);
  console.log(`dist/index.html built     : ${distExists}`);
  console.log(`BUILD SUCCEEDED           : ${buildOk}`);
  console.log(`task completed            : ${task!.status === "completed"}`);
  console.log("================================");

  db.close();
  process.exit(buildOk && !anyFailed && task!.status === "completed" ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
