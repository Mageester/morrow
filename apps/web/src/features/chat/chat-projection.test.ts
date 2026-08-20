import type { WebConversationActivityEntry } from "@morrow/contracts";
import { describe, expect, it } from "vitest";
import {
  chatEntryRole,
  formatElapsed,
  projectTurnWork,
  workSummaryLabel,
} from "./chat-projection.js";

const base = {
  version: 1 as const,
  taskId: "task-1",
  status: "completed" as const,
  detail: null,
  target: null,
  text: null,
  toolName: null,
  durationMs: null,
  exitCode: null,
  resultCount: null,
  evidenceRef: null,
  createdAt: "2026-07-22T12:00:00.000Z",
  updatedAt: "2026-07-22T12:00:00.000Z",
};

function entry(over: Partial<WebConversationActivityEntry> & { id: string; sequence: number; kind: WebConversationActivityEntry["kind"]; summary: string }): WebConversationActivityEntry {
  return { ...base, ...over } as WebConversationActivityEntry;
}

describe("chatEntryRole", () => {
  it("hides the routine telemetry that turned the transcript into an event feed", () => {
    const routine: WebConversationActivityEntry[] = [
      entry({ id: "1", sequence: 1, kind: "provider", summary: "Route selected", detail: "nvidia-nim / model" }),
      entry({ id: "2", sequence: 2, kind: "context", summary: "Context budget calculated" }),
      entry({ id: "3", sequence: 3, kind: "context", summary: "Context window updated" }),
      entry({ id: "4", sequence: 4, kind: "provider", summary: "Provider failure classified", status: "warning" }),
      entry({ id: "5", sequence: 5, kind: "assistant", summary: "Thinking", detail: "Planning next step", status: "running" }),
      entry({ id: "6", sequence: 6, kind: "memory", summary: "Updated memory" }),
      entry({ id: "7", sequence: 7, kind: "recovery", summary: "Repeat noted for the model", status: "running" }),
      entry({ id: "8", sequence: 8, kind: "evidence", summary: "Evidence recorded" }),
    ];
    for (const item of routine) {
      expect(chatEntryRole(item), item.summary).toBe("hidden");
    }
  });

  it("keeps the exceptional transitions a reader must not miss", () => {
    const notable: WebConversationActivityEntry[] = [
      entry({ id: "1", sequence: 1, kind: "provider", summary: "Route fallback used", status: "warning" }),
      entry({ id: "2", sequence: 2, kind: "provider", summary: "Provider or model changed" }),
      entry({ id: "3", sequence: 3, kind: "context", summary: "Context compacted", detail: "84,000 → 31,000 tokens" }),
      entry({ id: "4", sequence: 4, kind: "approval", summary: "Approval requested", status: "blocked" }),
      entry({ id: "5", sequence: 5, kind: "system", summary: "Task failed", status: "failed" }),
      entry({ id: "6", sequence: 6, kind: "checkpoint", summary: "Checkpoint saved" }),
    ];
    for (const item of notable) {
      expect(chatEntryRole(item), item.summary).toBe("notable");
    }
  });

  it("treats real tool work as steps and the assistant's words as narration", () => {
    expect(chatEntryRole(entry({ id: "a", sequence: 1, kind: "command", summary: "Ran pnpm test" }))).toBe("step");
    expect(chatEntryRole(entry({ id: "b", sequence: 2, kind: "diff", summary: "Edited src/a.ts" }))).toBe("step");
    expect(chatEntryRole(entry({ id: "c", sequence: 3, kind: "narration", summary: "Assistant message" }))).toBe("narration");
  });
});

describe("projectTurnWork", () => {
  const reads = Array.from({ length: 8 }, (_, index) => entry({
    id: `read-${index}`,
    sequence: index + 1,
    kind: "file",
    summary: `Read src/file-${index}.ts`,
    target: `src/file-${index}.ts`,
    toolName: "read_file",
  }));

  it("collapses repeated read-only operations and keeps everything else on its own row", () => {
    const work = projectTurnWork([
      ...reads,
      entry({ id: "edit", sequence: 9, kind: "diff", summary: "Edited src/home.tsx", target: "src/home.tsx", toolName: "propose_patch" }),
      entry({ id: "test", sequence: 10, kind: "command", summary: "Ran pnpm test", toolName: "run_command" }),
    ]);

    expect(work.steps).toHaveLength(3);
    const group = work.steps[0]!;
    expect(group.type).toBe("group");
    if (group.type === "group") {
      expect(group.label).toBe("Files read");
      expect(group.entries).toHaveLength(8);
    }
    expect(work.steps[1]).toMatchObject({ type: "single" });
    // The count a reader recognises is the number of tool calls, not of rows.
    expect(work.toolCount).toBe(10);
    expect(work.filesChanged).toBe(1);
  });

  it("never folds away a failed or still-running operation", () => {
    const work = projectTurnWork([
      ...reads.slice(0, 3),
      entry({ id: "bad", sequence: 4, kind: "file", summary: "Read src/missing.ts — failed", target: "src/missing.ts", toolName: "read_file", status: "failed" }),
      entry({ id: "live", sequence: 5, kind: "file", summary: "Reading src/live.ts", target: "src/live.ts", toolName: "read_file", status: "running" }),
    ]);

    const singles = work.steps.filter((step) => step.type === "single");
    expect(singles.map((step) => (step.type === "single" ? step.entry.id : ""))).toEqual(["bad", "live"]);
    expect(work.status).toBe("failed");
    expect(work.runningEntry?.id).toBe("live");
  });

  it("de-duplicates a transition the runtime reported twice", () => {
    const work = projectTurnWork([
      entry({ id: "r1", sequence: 1, kind: "provider", summary: "Provider rate limit detected", status: "warning" }),
      entry({ id: "r2", sequence: 2, kind: "provider", summary: "Provider rate limit detected", status: "warning" }),
    ]);
    expect(work.notables).toHaveLength(1);
  });

  it("times a settled turn from its records and leaves a running one to the wall clock", () => {
    const settled = projectTurnWork([
      entry({ id: "a", sequence: 1, kind: "file", summary: "Read a", toolName: "read_file", createdAt: "2026-07-22T12:00:00.000Z", updatedAt: "2026-07-22T12:00:00.000Z" }),
      entry({ id: "b", sequence: 2, kind: "file", summary: "Read b", toolName: "read_file", createdAt: "2026-07-22T12:00:03.000Z", updatedAt: "2026-07-22T12:00:05.000Z" }),
    ]);
    expect(settled.durationMs).toBe(5000);
    expect(settled.startedAt).toBe(Date.parse("2026-07-22T12:00:00.000Z"));

    // A running turn reports no recorded duration: timing it from the newest
    // event would freeze the counter for the whole time the model is thinking.
    const running = projectTurnWork([entry({ id: "a", sequence: 1, kind: "file", summary: "Reading a", toolName: "read_file", status: "running" })], true);
    expect(running.durationMs).toBeNull();
    expect(running.startedAt).not.toBeNull();
  });
});

describe("workSummaryLabel", () => {
  it("states the outcome, and omits a figure it does not have", () => {
    const work = projectTurnWork([
      entry({ id: "a", sequence: 1, kind: "diff", summary: "Edited a", target: "a.ts", toolName: "propose_patch", createdAt: "2026-07-22T12:00:00.000Z", updatedAt: "2026-07-22T12:01:24.000Z" }),
    ]);
    expect(workSummaryLabel(work)).toBe("Completed · 1m 24s · 1 tool · 1 file changed");

    const bare = projectTurnWork([entry({ id: "a", sequence: 1, kind: "tool", summary: "Used tool", toolName: "load_skill" })]);
    expect(workSummaryLabel(bare)).toBe("Completed · 1 tool");
  });

  it("does not describe a failed run as completed", () => {
    const work = projectTurnWork([
      entry({ id: "a", sequence: 1, kind: "command", summary: "Ran pnpm test — failed", toolName: "run_command", status: "failed" }),
    ]);
    expect(workSummaryLabel(work)).toContain("Stopped on an error");
  });
});

describe("formatElapsed", () => {
  it("keeps durations short and refuses to render an unknown one as zero", () => {
    expect(formatElapsed(820)).toBe("820ms");
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(84_000)).toBe("1m 24s");
    expect(formatElapsed(120_000)).toBe("2m");
    expect(formatElapsed(null)).toBeNull();
    expect(formatElapsed(-1)).toBeNull();
  });
});
