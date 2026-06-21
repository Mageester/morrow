import { EventEmitter } from "node:events";

export class ApprovalContinuationRegistry {
  private static emitter = new EventEmitter();

  static async awaitApproval(approvalId: string): Promise<string> {
    return new Promise((resolve) => {
      const listener = (decision: string) => {
        resolve(decision);
      };
      this.emitter.once(`resolved:${approvalId}`, listener);
    });
  }

  static resolveApproval(approvalId: string, decision: string) {
    this.emitter.emit(`resolved:${approvalId}`, decision);
  }
}
