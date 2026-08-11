import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database.js";
import { projectRepository } from "../src/repositories/projects.js";
import { taskRepository } from "../src/repositories/tasks.js";
import { delegationsRepository } from "../src/repositories/delegations.js";
import { handoffsRepository } from "../src/repositories/handoffs.js";
import { teamsRepository } from "../src/repositories/teams.js";
import { summarizeReadme, runReadmeSummarySample, ReadmeSummarySampleError } from "../src/mission/readme-summary-sample.js";

describe("summarizeReadme — pure, deterministic, no network/model", () => {
  it("extracts the first heading and first paragraph, truncated and stable across repeated calls", () => {
    const content = "# Morrow\n\nA private, local-first personal AI agent.\n\nMore details below that should not appear.\n";
    const first = summarizeReadme(content);
    const second = summarizeReadme(content);
    expect(first).toEqual(second); // determinism
    expect(first.title).toBe("Morrow");
    expect(first.excerpt).toContain("private, local-first personal AI agent");
    expect(first.excerpt).not.toContain("should not appear");
  });

  it("bounds excerpt length even for a very long paragraph", () => {
    const longParagraph = "word ".repeat(500).trim();
    const { excerpt } = summarizeReadme(`# Title\n\n${longParagraph}\n`);
    expect(excerpt.length).toBeLessThanOrEqual(500);
  });

  it("handles a README with no heading gracefully", () => {
    const { title, excerpt } = summarizeReadme("Just a plain paragraph, no heading at all.\n");
    expect(title).toBeNull();
    expect(excerpt).toContain("plain paragraph");
  });
});

describe("runReadmeSummarySample — deterministic end-to-end delegation", () => {
  let db: any;
  let workspace: string;

  beforeEach(() => {
    db = openDatabase(":memory:");
    workspace = mkdtempSync(join(tmpdir(), "morrow-readme-sample-"));
    projectRepository(db).createProject({ id: "p1", name: "P1", workspacePath: workspace, createdAt: new Date().toISOString() });
  });
  afterEach(() => {
    db.close();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("produces a completed handoff with real proof, not just prose", () => {
    writeFileSync(join(workspace, "README.md"), "# Sample Project\n\nThis project does exactly one thing well.\n");

    const result = runReadmeSummarySample({ db, projectId: "p1", workspacePath: workspace });

    expect(result.team.name).toBe("Research and verify");
    expect(result.parentTask.status).toBe("completed");
    expect(result.researcherTask.status).toBe("completed");
    expect(result.verifierTask.status).toBe("completed");
    expect(result.researcherTask.parentTaskId).toBe(result.parentTask.id);
    expect(result.verifierTask.parentTaskId).toBe(result.parentTask.id);

    expect(result.delegation.status).toBe("completed");
    expect(result.handoff.acceptanceCriteriaStatus.every((c) => c.met)).toBe(true);
    expect(result.handoff.resultSummary).toContain("Sample Project");
    expect(result.handoff.resultSummary).toContain("README.md");
    expect(result.handoff.artifactRefs).toHaveLength(1);
    expect(result.handoff.artifactRefs[0]?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.handoff.artifactRefs[0]?.contentHash)
      .toBe(`sha256:${createHash("sha256").update(readFileSync(join(workspace, "README.md"))).digest("hex")}`);
    expect(result.handoff.verificationEvidence).toBeTruthy();
    expect(result.handoff.sourceAgentId).toBe(result.researcherTask.agentId);
    expect(result.handoff.targetAgentId).toBe(result.verifierTask.agentId);

    // Durably persisted, inspectable via the ordinary repositories — not just
    // returned in-memory from this one call.
    const persistedDelegation = delegationsRepository(db).get(result.delegation.id);
    expect(persistedDelegation?.status).toBe("completed");
    const persistedHandoff = handoffsRepository(db).getByDelegation(result.delegation.id);
    expect(persistedHandoff?.id).toBe(result.handoff.id);
    expect(taskRepository(db).listChildren(result.parentTask.id).map((t) => t.id).sort())
      .toEqual([result.researcherTask.id, result.verifierTask.id].sort());
  });

  it("never fabricates success when the required artifact is missing — refuses rather than inventing a summary", () => {
    // No README.md written.
    expect(() => runReadmeSummarySample({ db, projectId: "p1", workspacePath: workspace }))
      .toThrow(ReadmeSummarySampleError);
    // No durable work of any status is left behind after the failed sample.
    expect(taskRepository(db).listTasksByProject("p1")).toHaveLength(0);
    expect(teamsRepository(db).listByProject("p1")).toHaveLength(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM delegations").get().count).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM handoffs").get().count).toBe(0);
  });

  it("is reusable — a second sample run creates its own team/delegation, not a duplicate of the first", () => {
    writeFileSync(join(workspace, "README.md"), "# Sample Project\n\nDetails.\n");
    const first = runReadmeSummarySample({ db, projectId: "p1", workspacePath: workspace });
    const second = runReadmeSummarySample({ db, projectId: "p1", workspacePath: workspace });
    expect(second.delegation.id).not.toBe(first.delegation.id);
    expect(second.handoff.resultSummary).toBe(first.handoff.resultSummary); // deterministic content
  });
});
