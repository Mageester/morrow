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

/**
 * Make a hand-copied pairing code match what hosted-api stored.
 *
 * Codes are generated from an uppercase alphabet with no separators, but
 * people type them lowercase, paste them with a trailing space out of the
 * dashboard, or insert a dash because short codes usually have one. Every one
 * of those produced a flat "Code not recognized or expired." — the same error
 * as a genuinely wrong code, so the user retyped a correct code and watched it
 * fail again. Normalising here keeps that judgement in one place, on the way
 * out to hosted-api.
 */
export function normalizePairingCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
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
