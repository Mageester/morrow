import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { taskRecordsRepository } from "../src/repositories/task-records.js";
import { conversationsRepository } from "../src/repositories/conversations.js";

/**
 * Records that share a timestamp must still be listed in the order they were
 * written.
 *
 * `created_at` is an ISO string with millisecond resolution, and the agent
 * routinely writes several rows inside one millisecond — three responsive
 * screenshots captured back to back, a user message and its assistant reply.
 * Tie-breaking on the random UUID primary key returned those rows in an
 * arbitrary order: measured at 164 out of 200 trials for evidence. The listings
 * tie-break on `rowid` (insertion order) instead.
 */
describe("listings with identical timestamps", () => {
  let db: Database.Database;
  const stamp = "2026-08-19T12:00:00.000Z";

  beforeEach(() => {
    db = openDatabase(":memory:");
    projectRepository(db).createProject({ id: "p1", name: "Order", workspacePath: "/tmp", createdAt: stamp } as never);
    taskRepository(db).createTask({ id: "t1", projectId: "p1", kind: "agent_chat", status: "queued", createdAt: stamp } as never);
  });
  afterEach(() => db.close());

  it("lists task evidence written in the same millisecond in insertion order", () => {
    const records = taskRecordsRepository(db);
    const labels = ["home-desktop", "home-tablet", "home-mobile"];
    for (const label of labels) {
      records.appendEvidence({ id: randomUUID(), taskId: "t1", type: "file", path: `${label}.png`, metadata: { kind: "browser_screenshot", label }, createdAt: stamp } as never);
    }
    expect(records.listEvidence("t1").map((item) => (item.metadata as { label: string }).label)).toEqual(labels);
  });

  it("lists conversation messages written in the same millisecond in insertion order", () => {
    const convs = conversationsRepository(db);
    convs.createConversation({ id: "c1", projectId: "p1", title: "Order", createdAt: stamp, updatedAt: stamp });
    const contents = ["first", "second", "third", "fourth"];
    for (const content of contents) {
      convs.appendMessage({ id: randomUUID(), conversationId: "c1", role: "user", content, createdAt: stamp, updatedAt: stamp });
    }
    expect(convs.listMessages("c1").map((message) => message.content)).toEqual(contents);
  });
});
