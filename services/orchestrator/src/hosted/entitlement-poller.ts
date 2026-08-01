import type { EntitlementResponse } from "@morrow/hosted-contracts";
import type { PairingStatus } from "@morrow/contracts";
import { fetchEntitlement } from "./pairing-client.js";
import { readHostedPairing } from "./pairing-store.js";

export interface EntitlementSnapshot {
  status: PairingStatus;
  accountId: string | null;
  planId: EntitlementResponse["planId"] | null;
  checkedAt: string | null;
  lastError: string | null;
}

const UNPAIRED_SNAPSHOT: EntitlementSnapshot = {
  status: "unpaired",
  accountId: null,
  planId: null,
  checkedAt: null,
  lastError: null,
};

/**
 * Periodically verifies this install's paired entitlement against hosted-api.
 * A failed check (network blip, hosted-api hiccup) NEVER flips a previously
 * "active" snapshot to "inactive" — it preserves the last known state and
 * only records the error. Local work must never brick on a transient remote
 * failure. See Plans/generic-sprouting-dragon.md Phase 4.
 */
export class EntitlementPoller {
  private snapshot: EntitlementSnapshot = UNPAIRED_SNAPSHOT;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly secretsFile: string,
    private readonly hostedApiUrl: string | undefined,
    private readonly fetchImpl?: typeof fetch,
  ) {}

  getSnapshot(): EntitlementSnapshot {
    return this.snapshot;
  }

  async checkNow(): Promise<EntitlementSnapshot> {
    const pairing = readHostedPairing(this.secretsFile);
    const checkedAt = new Date().toISOString();

    if (!pairing) {
      this.snapshot = UNPAIRED_SNAPSHOT;
      return this.snapshot;
    }
    if (!this.hostedApiUrl) {
      this.snapshot = {
        status: "unknown",
        accountId: pairing.accountId,
        planId: this.snapshot.planId,
        checkedAt,
        lastError: "MORROW_HOSTED_API_URL is not configured on this install.",
      };
      return this.snapshot;
    }

    const result = await fetchEntitlement(
      { hostedApiUrl: this.hostedApiUrl, ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}) },
      pairing.deviceToken,
    );
    if (!result.ok) {
      this.snapshot = { ...this.snapshot, accountId: pairing.accountId, checkedAt, lastError: result.message };
      return this.snapshot;
    }

    this.snapshot = {
      status: result.entitlement.active ? "active" : "inactive",
      accountId: result.entitlement.accountId,
      planId: result.entitlement.planId,
      checkedAt,
      lastError: null,
    };
    return this.snapshot;
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    void this.checkNow();
    this.timer = setInterval(() => {
      void this.checkNow();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
