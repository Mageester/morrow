import { PairingStatusResponseSchema, RedeemPairingCodeResultSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

export const pairingQueries = {
  status() {
    return queryOptions({
      queryKey: ["pairing", "status"] as const,
      queryFn: () => api.get("/api/pairing/status", PairingStatusResponseSchema),
      // A local, cheap call (the orchestrator reports whatever its own
      // background poller last observed — this never blocks on hosted-api).
      // Poll so the banner reflects a poller update without a manual refresh.
      refetchInterval: 60_000,
    });
  },
};

export const pairingApi = {
  redeem(input: { code: string; deviceLabel?: string }) {
    return api.post("/api/pairing/redeem", input, RedeemPairingCodeResultSchema);
  },
};
