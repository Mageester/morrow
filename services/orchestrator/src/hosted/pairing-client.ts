/**
 * All calls here are OUTBOUND from this orchestrator to hosted-api — there is
 * no inbound path. This is deliberate: the local-guard's loopback-only trust
 * model (security/local-guard.ts) is not touched by any of this. See
 * Plans/generic-sprouting-dragon.md Phase 4.
 */
import type { EntitlementResponse } from "@morrow/hosted-contracts";

export interface PairingClientOptions {
  hostedApiUrl: string;
  fetchImpl?: typeof fetch;
}

interface HostedApiErrorBody {
  error?: { code?: string; message?: string };
}

async function parseErrorBody(response: Response): Promise<{ code: string; message: string }> {
  const body = (await response.json().catch(() => null)) as HostedApiErrorBody | null;
  return {
    code: body?.error?.code ?? "UNKNOWN_ERROR",
    message: body?.error?.message ?? `hosted-api responded ${response.status}`,
  };
}

export type RedeemResult =
  | { ok: true; pairedAgentId: string; deviceToken: string; accountId: string }
  | { ok: false; status: number; code: string; message: string };

export async function redeemPairingCode(
  options: PairingClientOptions,
  input: { code: string; deviceLabel: string; orchestratorVersion?: string },
): Promise<RedeemResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/pair/redeem", options.hostedApiUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    return { ok: false, status: 0, code: "NETWORK_ERROR", message: error instanceof Error ? error.message : "Network error." };
  }
  if (!response.ok) {
    const { code, message } = await parseErrorBody(response);
    return { ok: false, status: response.status, code, message };
  }
  const body = (await response.json()) as { pairedAgentId: string; deviceToken: string; accountId: string };
  return { ok: true, pairedAgentId: body.pairedAgentId, deviceToken: body.deviceToken, accountId: body.accountId };
}

export type EntitlementResult =
  | { ok: true; entitlement: EntitlementResponse }
  | { ok: false; status: number; code: string; message: string };

export async function fetchEntitlement(
  options: PairingClientOptions,
  deviceToken: string,
): Promise<EntitlementResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL("/api/entitlement", options.hostedApiUrl), {
      headers: { authorization: `Bearer ${deviceToken}` },
    });
  } catch (error) {
    return { ok: false, status: 0, code: "NETWORK_ERROR", message: error instanceof Error ? error.message : "Network error." };
  }
  if (!response.ok) {
    const { code, message } = await parseErrorBody(response);
    return { ok: false, status: response.status, code, message };
  }
  const entitlement = (await response.json()) as EntitlementResponse;
  return { ok: true, entitlement };
}
