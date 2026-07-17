import { EventEmitter } from "node:events";

/**
 * Wakes a live, in-process task when its approval is resolved. A naive
 * emitter loses the wakeup if `resolveApproval` fires before the task has
 * registered its listener (a fast user, or resolution on the same tick the
 * approval is created). To prevent lost wakeups we latch the decision: a
 * resolution that arrives before anyone is waiting is stored and delivered to
 * the next `awaitApproval` call.
 */
export class ApprovalContinuationRegistry {
  private static emitter = new EventEmitter();
  private static latched = new Map<string, string>();

  static awaitApproval(approvalId: string, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error("AbortError"));
    const alreadyResolved = this.latched.get(approvalId);
    if (alreadyResolved !== undefined) {
      this.latched.delete(approvalId);
      return Promise.resolve(alreadyResolved);
    }
    return new Promise((resolve, reject) => {
      const eventName = `resolved:${approvalId}`;
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        this.emitter.off(eventName, onResolved);
        reject(new Error("AbortError"));
      };
      const onResolved = (decision: string) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        this.latched.delete(approvalId);
        resolve(decision);
      };
      this.emitter.once(eventName, onResolved);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  static resolveApproval(approvalId: string, decision: string) {
    // Latch first so a waiter that registers a moment later still sees it,
    // then notify any listener already waiting.
    this.latched.set(approvalId, decision);
    this.emitter.emit(`resolved:${approvalId}`, decision);
  }

  /** Drop a latched decision that will never be consumed (task ended). */
  static clear(approvalId: string) {
    this.latched.delete(approvalId);
  }
}
