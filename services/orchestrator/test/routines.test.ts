import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";
import { renderRoutineAsMessage } from "../src/web/routine-proposal.js";
import { RoutineRecordingStateSchema, RoutineSchema } from "@morrow/contracts";

function ts() { return new Date().toISOString(); }

describe("renderRoutineAsMessage", () => {
  it("hands the teammate the objective, with the observed steps as context rather than a script", () => {
    const message = renderRoutineAsMessage({
      name: "Weekly report",
      objective: "Summarise what changed this week.",
      steps: [
        { summary: "Inspected Git", target: "git log --since=7.days", toolName: "git_log" },
        { summary: "Read CHANGELOG.md", target: "CHANGELOG.md", toolName: "read_file" },
      ],
    });
    expect(message).toContain('Run the routine "Weekly report"');
    expect(message).toContain("Summarise what changed this week.");
    expect(message).toContain("1. Inspected Git — git log --since=7.days");
    expect(message).toContain("2. Read CHANGELOG.md — CHANGELOG.md");
    // The honest framing is load-bearing: this is not a replay harness.
    expect(message).toContain("context, not as a script");
  });

  it("omits the step list entirely when nothing was observed", () => {
    const message = renderRoutineAsMessage({ name: "Ping", objective: "Say hello.", steps: [] });
    expect(message).not.toContain("Last time");
  });
});

describe("Record mode", () => {
  let db: any;
  let app: any;
  let previousMockProvider: string | undefined;
  let conversationId: string;
  let agentId: string;

  const recordingUrl = () => `/api/projects/p1/conversations/${conversationId}/recording`;

  beforeEach(async () => {
    previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
    agentId = (await app.inject({
      method: "POST", url: "/api/projects/p1/agents", payload: { name: "Reporter", role: "writer" },
    })).json().id;
    conversationId = (await app.inject({
      method: "POST", url: "/api/projects/p1/conversations", payload: { agentId },
    })).json().id;
  });
  afterEach(() => {
    app.close();
    db.close();
    if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = previousMockProvider;
  });

  it("reports a thread that has never been recorded as having nothing to propose", async () => {
    const state = RoutineRecordingStateSchema.parse((await app.inject({ method: "GET", url: recordingUrl() })).json());
    expect(state.recording).toBeNull();
    expect(state.proposal).toBeNull();
  });

  it("records a span, and proposes a routine from what the teammate was actually seen doing", async () => {
    const started = await app.inject({ method: "POST", url: recordingUrl() });
    expect(started.statusCode, started.body).toBe(201);

    // A turn inside the recorded span, with two real steps recorded against it.
    const send = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversationId}/messages`,
      payload: { content: "Summarise what changed this week." },
    });
    const taskId = send.json().task.id;
    const records = taskRecordsRepository(db);
    records.appendEvent({ id: "e1", taskId, type: "tool.started", payload: { id: "c1", toolName: "read_file", target: "CHANGELOG.md" }, createdAt: ts() });
    records.appendEvent({ id: "e2", taskId, type: "tool.completed", payload: { id: "c1", toolName: "read_file", status: "completed", elapsedMs: 12 }, createdAt: ts() });
    records.appendEvent({ id: "e3", taskId, type: "tool.started", payload: { id: "c2", toolName: "git_log", target: "git log" }, createdAt: ts() });
    records.appendEvent({ id: "e4", taskId, type: "tool.completed", payload: { id: "c2", toolName: "git_log", status: "completed", elapsedMs: 30 }, createdAt: ts() });

    const stopped = await app.inject({ method: "DELETE", url: recordingUrl() });
    expect(stopped.statusCode, stopped.body).toBe(200);
    const state = RoutineRecordingStateSchema.parse(stopped.json());
    expect(state.recording!.stoppedAt).not.toBeNull();
    expect(state.proposal!.objective).toContain("Summarise what changed this week.");
    expect(state.proposal!.taskCount).toBe(1);
    expect(state.proposal!.steps.map((step) => step.toolName)).toEqual(["read_file", "git_log"]);
    expect(state.proposal!.suggestedName.length).toBeGreaterThan(0);
  });

  it("leaves a failed step out of the proposal, so a routine cannot learn a mistake", async () => {
    await app.inject({ method: "POST", url: recordingUrl() });
    const send = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversationId}/messages`,
      payload: { content: "Run the suite." },
    });
    const taskId = send.json().task.id;
    const records = taskRecordsRepository(db);
    records.appendEvent({ id: "f1", taskId, type: "tool.started", payload: { id: "c1", toolName: "run_command", target: "pnpm tset" }, createdAt: ts() });
    records.appendEvent({ id: "f2", taskId, type: "tool.completed", payload: { id: "c1", toolName: "run_command", status: "failed", elapsedMs: 5 }, createdAt: ts() });
    records.appendEvent({ id: "f3", taskId, type: "tool.started", payload: { id: "c2", toolName: "run_command", target: "pnpm test" }, createdAt: ts() });
    records.appendEvent({ id: "f4", taskId, type: "tool.completed", payload: { id: "c2", toolName: "run_command", status: "completed", elapsedMs: 900 }, createdAt: ts() });

    const state = RoutineRecordingStateSchema.parse((await app.inject({ method: "DELETE", url: recordingUrl() })).json());
    expect(state.proposal!.steps).toHaveLength(1);
    expect(state.proposal!.steps[0]!.target).toBe("pnpm test");
  });

  it("excludes work that happened before the recording started", async () => {
    const before = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversationId}/messages`,
      payload: { content: "Something unrelated I did first." },
    });
    expect(before.statusCode).toBe(202);
    // A recording started now must not claim the turn above.
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.inject({ method: "POST", url: recordingUrl() });

    const state = RoutineRecordingStateSchema.parse((await app.inject({ method: "DELETE", url: recordingUrl() })).json());
    expect(state.proposal!.objective).not.toContain("Something unrelated");
    expect(state.proposal!.taskCount).toBe(0);
  });

  it("refuses a second open recording on the same thread, and a stop with nothing running", async () => {
    await app.inject({ method: "POST", url: recordingUrl() });
    const second = await app.inject({ method: "POST", url: recordingUrl() });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("ALREADY_RECORDING");

    await app.inject({ method: "DELETE", url: recordingUrl() });
    const stopAgain = await app.inject({ method: "DELETE", url: recordingUrl() });
    expect(stopAgain.statusCode).toBe(409);
    expect(stopAgain.json().error.code).toBe("NOT_RECORDING");
  });
});

describe("Routines", () => {
  let db: any;
  let app: any;
  let previousMockProvider: string | undefined;
  let agentId: string;

  beforeEach(async () => {
    previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
    agentId = (await app.inject({
      method: "POST", url: "/api/projects/p1/agents", payload: { name: "Reporter", role: "writer" },
    })).json().id;
  });
  afterEach(() => {
    app.close();
    db.close();
    if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = previousMockProvider;
  });

  async function createRoutine(overrides: Record<string, unknown> = {}) {
    const res = await app.inject({
      method: "POST", url: "/api/projects/p1/routines",
      payload: {
        name: "Weekly report",
        objective: "Summarise what changed this week.",
        steps: [{ summary: "Read CHANGELOG.md", target: "CHANGELOG.md", toolName: "read_file" }],
        agentId,
        ...overrides,
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return RoutineSchema.parse(res.json());
  }

  it("saves a routine against the teammate that learned it, and lists it", async () => {
    const routine = await createRoutine();
    expect(routine).toMatchObject({ name: "Weekly report", agentId, runCount: 0, lastRunAt: null });

    const listed = (await app.inject({ method: "GET", url: "/api/projects/p1/routines" })).json();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(routine.id);
  });

  it("runs a routine as its own teammate, in a fresh thread bound to them", async () => {
    const routine = await createRoutine();
    const run = await app.inject({ method: "POST", url: `/api/routines/${routine.id}/run` });
    expect(run.statusCode, run.body).toBe(202);

    const { conversationId, taskId } = run.json();
    const conversation = conversationsRepository(db).getConversation(conversationId)!;
    expect(conversation.agentId).toBe(agentId);
    expect(taskRepository(db).getTaskById(taskId)!.agentId).toBe(agentId);

    // The opening message is the routine written out, not a replay.
    const opening = conversationsRepository(db).listMessages(conversationId).find((m) => m.role === "user")!;
    expect(opening.content).toContain('Run the routine "Weekly report"');
    expect(opening.content).toContain("context, not as a script");

    const after = (await app.inject({ method: "GET", url: "/api/projects/p1/routines" })).json();
    expect(after[0].runCount).toBe(1);
    expect(after[0].lastRunAt).not.toBeNull();
  });

  it("refuses to run a routine whose teammate has been switched off", async () => {
    const routine = await createRoutine();
    await app.inject({ method: "PUT", url: `/api/agents/${agentId}`, payload: { projectId: "p1", enabled: false } });
    const run = await app.inject({ method: "POST", url: `/api/routines/${routine.id}/run` });
    expect(run.statusCode).toBe(409);
    expect(run.json().error.code).toBe("AGENT_DISABLED");
  });

  it("refuses a routine bound to an agent from another project", async () => {
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: ts() });
    const foreign = (await app.inject({
      method: "POST", url: "/api/projects/p2/agents", payload: { name: "Foreign", role: "writer" },
    })).json();
    const res = await app.inject({
      method: "POST", url: "/api/projects/p1/routines",
      payload: { name: "X", objective: "Y", steps: [], agentId: foreign.id },
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a routine only from its own project", async () => {
    const routine = await createRoutine();
    projectRepository(db).createProject({ id: "p2", name: "P2", workspacePath: process.cwd(), createdAt: ts() });
    const wrongProject = await app.inject({
      method: "DELETE", url: `/api/routines/${routine.id}`, payload: { projectId: "p2" },
    });
    expect(wrongProject.statusCode).toBe(404);

    const right = await app.inject({
      method: "DELETE", url: `/api/routines/${routine.id}`, payload: { projectId: "p1" },
    });
    expect(right.statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/projects/p1/routines" })).json()).toEqual([]);
  });
});
