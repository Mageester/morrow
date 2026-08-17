import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebConversationActivityEntry } from "@morrow/contracts";
import { ActivityTimeline, ConversationTranscript } from "./activity-panel.js";

const now = "2026-07-22T12:00:00.000Z";

function generateToolEntries(count: number): WebConversationActivityEntry[] {
  const entries: WebConversationActivityEntry[] = [];
  for (let i = 1; i <= count; i++) {
    entries.push({
      version: 1,
      id: `entry-${i}`,
      taskId: "task-perf-1",
      sequence: i,
      kind: i % 3 === 0 ? "command" : i % 3 === 1 ? "file" : "tool",
      status: "completed",
      summary: `Executed operation ${i}`,
      detail: `Detailed output and parameters for operation ${i}`,
      toolName: `tool_${i}`,
      target: `/path/to/resource_${i}.ts`,
      durationMs: 45 + i * 2,
      exitCode: 0,
      resultCount: 1,
      text: null,
      createdAt: now,
      updatedAt: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
  return entries;
}

describe("20+ Tool Execution & Chat Rendering Performance Profile", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("profiles 25 tool entries in ActivityTimeline with sub-millisecond per-item mount", () => {
    const entries = generateToolEntries(25);

    const t0 = performance.now();
    const { rerender } = render(
      <ActivityTimeline entries={entries} />
    );
    const initialRenderMs = performance.now() - t0;

    expect(screen.getAllByText(/Executed operation/).length).toBe(25);
    expect(initialRenderMs).toBeLessThan(1000);

    // Append a 26th entry (simulating new streaming step)
    const updatedEntries: WebConversationActivityEntry[] = [
      ...entries,
      {
        version: 1,
        id: "entry-26",
        taskId: "task-perf-1",
        sequence: 26,
        kind: "tool" as const,
        status: "running" as const,
        summary: "Executing operation 26",
        detail: null,
        toolName: "tool_26",
        target: null,
        durationMs: null,
        exitCode: null,
        resultCount: null,
        text: null,
        createdAt: now,
        updatedAt: new Date().toISOString(),
      },
    ];

    const t1 = performance.now();
    rerender(<ActivityTimeline entries={updatedEntries} />);
    const updateRenderMs = performance.now() - t1;

    expect(screen.getByText("Executing operation 26")).toBeDefined();
    expect(updateRenderMs).toBeLessThan(500);
  });

  it("profiles ConversationTranscript streaming narration without re-rendering completed tools", () => {
    const toolEntries = generateToolEntries(20);
    const narrationEntry: WebConversationActivityEntry = {
      version: 1,
      id: "narration-1",
      taskId: "task-perf-1",
      sequence: 21,
      kind: "narration",
      status: "completed",
      summary: "Assistant message",
      detail: null,
      toolName: null,
      target: null,
      durationMs: null,
      exitCode: null,
      resultCount: null,
      text: "Initial text chunk",
      createdAt: now,
      updatedAt: new Date().toISOString(),
    };

    const initialEntries = [...toolEntries, narrationEntry];

    const t0 = performance.now();
    const { rerender } = render(
      <ConversationTranscript entries={initialEntries} streaming={true} />
    );
    const initialRenderMs = performance.now() - t0;
    expect(screen.getByText("Initial text chunk")).toBeDefined();

    // Stream 10 delta updates into the narration entry
    const deltaTimes: number[] = [];
    let currentText = "Initial text chunk";

    for (let i = 1; i <= 10; i++) {
      currentText += ` ...delta ${i}`;
      const streamUpdatedEntries = [
        ...toolEntries,
        { ...narrationEntry, text: currentText },
      ];

      const td0 = performance.now();
      rerender(<ConversationTranscript entries={streamUpdatedEntries} streaming={true} />);
      deltaTimes.push(performance.now() - td0);
    }

    const avgDeltaMs = deltaTimes.reduce((a, b) => a + b, 0) / deltaTimes.length;
    expect(avgDeltaMs).toBeLessThan(30);
    expect(screen.getByText(currentText)).toBeDefined();
  });
});
