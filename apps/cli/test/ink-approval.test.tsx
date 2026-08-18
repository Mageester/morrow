import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/terminal/ink/app.js";
import { ApprovalStore } from "../src/terminal/ink/approval-store.js";
import { TerminalStore } from "../src/terminal/ink/store.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function plain(frame: string | undefined): string {
  return (frame ?? "").replace(new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[a-zA-Z]", "g"), "");
}

function mount() {
  const store = new TerminalStore();
  const approvals = new ApprovalStore();
  const onApprovalDecision = vi.fn();
  const onSubmit = vi.fn();
  const view = render(
    <App
      approvals={approvals}
      cwdLabel="~/p"
      onApprovalDecision={onApprovalDecision}
      onInterrupt={vi.fn()}
      onSubmit={onSubmit}
      store={store}
      unicode
    />,
  );
  return { store, approvals, view, onApprovalDecision, onSubmit };
}

describe("approval prompt", () => {
  it("surfaces a command approval instead of waiting silently", async () => {
    const { approvals, view } = mount();

    approvals.set({
      id: "a1",
      kind: "command",
      projectId: "p1",
      details: { command: "rm -rf build", cwd: "/repo" },
    });
    await tick();

    const frame = plain(view.lastFrame());
    expect(frame).toContain("Run this command?");
    expect(frame).toContain("rm -rf build");
  });

  it("takes the keyboard entirely, so the composer cannot swallow the decision", async () => {
    const { approvals, view, onApprovalDecision, onSubmit } = mount();

    approvals.set({ id: "a1", kind: "command", projectId: "p1", details: { command: "ls" } });
    await tick();

    view.stdin.write("y");
    await tick();

    expect(onApprovalDecision).toHaveBeenCalledWith("allow_once");
    // The "y" must not have landed in the draft and must not have been sent.
    expect(onSubmit).not.toHaveBeenCalled();
    expect(plain(view.lastFrame())).not.toContain("> y");
  });

  it("ignores Enter and Space, so a queued keystroke never approves by accident", async () => {
    const { approvals, view, onApprovalDecision } = mount();

    approvals.set({ id: "a1", kind: "change_set", projectId: "p1", details: { files: ["a.ts"] } });
    await tick();

    view.stdin.write(String.fromCharCode(13));
    view.stdin.write(" ");
    await tick();

    expect(onApprovalDecision).not.toHaveBeenCalled();
  });

  it("describes a change set by what it will touch", async () => {
    const { approvals, view } = mount();

    approvals.set({
      id: "a2",
      kind: "change_set",
      projectId: "p1",
      details: { files: ["src/a.ts", "src/b.ts"], explanation: "Add the health endpoint" },
    });
    await tick();

    const frame = plain(view.lastFrame());
    expect(frame).toContain("Apply changes to 2 files?");
    expect(frame).toContain("Add the health endpoint");
    expect(frame).toContain("src/a.ts");
  });
});
