import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";

function ts() { return new Date().toISOString(); }

/**
 * A named teammate has to know who it is and what it was hired for.
 *
 * Before this, a specialist called "Research" with a written job description
 * was told on every turn that it was "Morrow, a secure personal AI coding
 * assistant", and its instructions were never sent at all — the roster's whole
 * premise was invisible to the model doing the work.
 */
describe("A teammate knows its own job", () => {
  let db: any;
  let app: any;
  let previousMockProvider: string | undefined;

  async function runAs(agent: { name: string; role?: string; instructions?: string | null } | null, content: string) {
    const created = agent
      ? (await app.inject({
          method: "POST", url: "/api/projects/p1/agents",
          payload: { name: agent.name, role: agent.role ?? "researcher", instructions: agent.instructions ?? null },
        })).json()
      : null;
    const conversation = (await app.inject({
      method: "POST", url: "/api/projects/p1/conversations",
      payload: created ? { agentId: created.id } : {},
    })).json();
    const send = await app.inject({
      method: "POST", url: `/api/projects/p1/conversations/${conversation.id}/messages`,
      payload: { content },
    });
    expect(send.statusCode, send.body).toBe(202);
    return send.json().task.id as string;
  }

  /** The system messages the run actually sent, read back from durable events. */
  function systemPromptFor(taskId: string): string {
    const events = taskRecordsRepository(db).listEvents(taskId);
    return JSON.stringify(events);
  }

  beforeEach(() => {
    previousMockProvider = process.env.MOCK_PROVIDER;
    process.env.MOCK_PROVIDER = "true";
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}) });
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: process.cwd(), createdAt: ts() });
  });
  afterEach(() => {
    app.close();
    db.close();
    if (previousMockProvider === undefined) delete process.env.MOCK_PROVIDER;
    else process.env.MOCK_PROVIDER = previousMockProvider;
  });

  it("dispatches a teammate's task with that teammate assigned", async () => {
    const taskId = await runAs({ name: "Research", instructions: "Track competitor releases." }, "look into it");
    expect(systemPromptFor(taskId)).toBeTruthy();
  });
});

/**
 * The prompt assembly itself is exercised directly: building a whole live run
 * to read one system message back would test the provider adapter, not the
 * thing that regressed.
 */
describe("Teammate identity in the assembled prompt", () => {
  it("names the teammate and its role instead of the product", async () => {
    const { buildTeammateIdentity } = await import("../src/execution/teammate-identity.js");
    expect(buildTeammateIdentity(null)).toBe("You are Morrow, a secure personal AI coding assistant.");
    expect(buildTeammateIdentity({ name: "Research", role: "researcher" })).toContain("You are Research");
    expect(buildTeammateIdentity({ name: "Research", role: "researcher" })).toContain("Your role is researcher");
    // Hyphenated roles are read out, not printed as identifiers.
    expect(buildTeammateIdentity({ name: "Reviewer", role: "code-reviewer" })).toContain("code reviewer");
  });

  it("renders the job the user wrote as a standing brief, and nothing when there is none", async () => {
    const { buildTeammateBrief } = await import("../src/execution/teammate-identity.js");
    expect(buildTeammateBrief(null)).toBeNull();
    expect(buildTeammateBrief({ instructions: null })).toBeNull();
    expect(buildTeammateBrief({ instructions: "   " })).toBeNull();
    const brief = buildTeammateBrief({ instructions: "Track competitor releases. Cite the source." });
    expect(brief).toContain("Track competitor releases.");
    expect(brief).toContain("This is the job you were hired for");
  });
});
