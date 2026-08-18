import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { startShell } from "../src/terminal/ink/shell.js";
import type { RawTaskEvent } from "../src/terminal/task-event-adapter.js";
import type { SessionBackend } from "../src/terminal/session-types.js";

/**
 * The approval round-trip, driven through the real shell.
 *
 * This exists because of a specific defect: the runtime emits
 * `approval.requested` with an `approvalId`, and the shell read `id`. Every
 * approval therefore resolved to null and was discarded — no prompt appeared,
 * the keystroke meant to answer it landed in the composer, and the task waited
 * forever for a decision nobody could see. A terminal that hangs in silence on
 * a hidden permission request is the worst thing this surface can do, so the
 * wiring is asserted rather than assumed.
 */

const session = {
  projectId: "p",
  projectName: "morrow",
  workspacePath: "C:/work",
  conversationId: "c",
  conversationTitle: "Session",
  serviceUrl: "http://127.0.0.1:4317",
  version: "0.1.0",
};

function backendEmitting(events: RawTaskEvent[], getApproval: SessionBackend["getApproval"]): SessionBackend {
  return {
    send: async () => ({ taskId: "task-1" }),
    subscribe: async function* () {
      for (const event of events) yield event;
    },
    cancel: async () => {},
    resume: async () => {},
    getApproval,
    resolveApproval: async () => {},
    getPlan: async () => [],
    // A running task, so the shell adopts `initialTaskId` and consumes the
    // stream. Adoption is deliberately gated on live status, so a fake that
    // reports "completed" would (correctly) subscribe to nothing.
    getTask: async () => ({ task: { id: "task-1", status: "running" } }) as never,
    getTaskTree: async () => {
      throw new Error("no tree");
    },
  } as SessionBackend;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** Streams good enough for Ink, with no terminal behind them. */
function fakeIo() {
  const stdout = Object.assign(new EventEmitter(), {
    columns: 100,
    rows: 40,
    write: () => true,
    isTTY: true,
  });
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setEncoding: () => {},
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
    read: () => null,
  });
  return { stdout, stdin, stderr: stdout } as never;
}

describe("approval requests reach the surface", () => {
  it("loads the approval named by `approvalId`", async () => {
    const getApproval = vi.fn(async (id: string) => ({
      id,
      kind: "command" as const,
      details: { command: "node -e 1" },
      projectId: "p",
    }));
    const shell = startShell({
      backend: backendEmitting(
        [{ type: "approval.requested", payload: { approvalId: "approval-7", kind: "command" } } as RawTaskEvent],
        getApproval,
      ),
      sendOptions: { mode: "agent", autoApprove: false, preset: "balanced", useMemory: true },
      session,
      cwdLabel: "morrow",
      unicode: false,
      initialTaskId: "task-1",
      io: fakeIo(),
    });
    await settle();
    // The whole point: the id the runtime actually sends is the one fetched.
    expect(getApproval).toHaveBeenCalledWith("approval-7");
    shell.stop();
  });

  it("still accepts a bare `id`, rather than assuming one spelling", async () => {
    const getApproval = vi.fn(async (id: string) => ({
      id,
      kind: "command" as const,
      details: {},
      projectId: "p",
    }));
    const shell = startShell({
      backend: backendEmitting(
        [{ type: "approval.requested", payload: { id: "approval-9" } } as RawTaskEvent],
        getApproval,
      ),
      sendOptions: { mode: "agent", autoApprove: false, preset: "balanced", useMemory: true },
      session,
      cwdLabel: "morrow",
      unicode: false,
      initialTaskId: "task-1",
      io: fakeIo(),
    });
    await settle();
    expect(getApproval).toHaveBeenCalledWith("approval-9");
    shell.stop();
  });

  it("complains loudly when an approval arrives without an id", async () => {
    const getApproval = vi.fn();
    const shell = startShell({
      backend: backendEmitting(
        [{ type: "approval.requested", payload: { kind: "command" } } as RawTaskEvent],
        getApproval as never,
      ),
      sendOptions: { mode: "agent", autoApprove: false, preset: "balanced", useMemory: true },
      session,
      cwdLabel: "morrow",
      unicode: false,
      initialTaskId: "task-1",
      io: fakeIo(),
    });
    await settle();
    expect(getApproval).not.toHaveBeenCalled();
    shell.stop();
  });
});
