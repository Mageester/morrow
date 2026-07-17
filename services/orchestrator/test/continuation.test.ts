import { describe, it, expect } from "vitest";
import { ApprovalContinuationRegistry } from "../src/execution/continuation.js";

describe("ApprovalContinuationRegistry", () => {
  it("delivers a wakeup even when resolution arrives before the waiter (no lost wakeup)", async () => {
    const id = "approval-race-1";
    // Resolve first, then await — the latch must still deliver the decision.
    ApprovalContinuationRegistry.resolveApproval(id, "allow_once");
    const decision = await ApprovalContinuationRegistry.awaitApproval(id);
    expect(decision).toBe("allow_once");
  });

  it("delivers a wakeup to a waiter that registered first", async () => {
    const id = "approval-race-2";
    const pending = ApprovalContinuationRegistry.awaitApproval(id);
    ApprovalContinuationRegistry.resolveApproval(id, "deny");
    expect(await pending).toBe("deny");
  });

  it("clear() drops a latched decision so it is not delivered later", async () => {
    const id = "approval-race-3";
    ApprovalContinuationRegistry.resolveApproval(id, "allow_once");
    ApprovalContinuationRegistry.clear(id);
    // Now a fresh resolve should win; the cleared one must not leak.
    const pending = ApprovalContinuationRegistry.awaitApproval(id);
    ApprovalContinuationRegistry.resolveApproval(id, "deny");
    expect(await pending).toBe("deny");
  });

  it("rejects and removes a pending waiter when its task is aborted", async () => {
    const id = "approval-cancelled-task";
    const controller = new AbortController();
    const pending = ApprovalContinuationRegistry.awaitApproval(id, controller.signal);

    controller.abort();

    await expect(pending).rejects.toThrow("AbortError");
    ApprovalContinuationRegistry.resolveApproval(id, "allow_once");
    ApprovalContinuationRegistry.clear(id);
  });
});
