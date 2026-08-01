/**
 * Persists this install's hosted-account pairing (device token + account id)
 * in the same plain KEY=VALUE secrets file used for provider API keys —
 * same file, same 0600/Windows-ACL protection, same "never echo a stored
 * value back" discipline (see provider/secrets.ts). A separate file would
 * just be a second thing to protect identically for no benefit.
 */
import { readSecretsFileSafe, writeSecretsFile } from "../provider/secrets.js";

const DEVICE_TOKEN_KEY = "MORROW_HOSTED_DEVICE_TOKEN";
const ACCOUNT_ID_KEY = "MORROW_HOSTED_ACCOUNT_ID";
const PAIRED_AGENT_ID_KEY = "MORROW_HOSTED_PAIRED_AGENT_ID";

export interface HostedPairing {
  deviceToken: string;
  accountId: string;
  pairedAgentId: string;
}

export function readHostedPairing(secretsFile: string): HostedPairing | null {
  const entries = readSecretsFileSafe(secretsFile);
  const deviceToken = entries[DEVICE_TOKEN_KEY];
  const accountId = entries[ACCOUNT_ID_KEY];
  const pairedAgentId = entries[PAIRED_AGENT_ID_KEY];
  if (!deviceToken || !accountId || !pairedAgentId) return null;
  return { deviceToken, accountId, pairedAgentId };
}

export function writeHostedPairing(secretsFile: string, pairing: HostedPairing): void {
  const existing = readSecretsFileSafe(secretsFile);
  existing[DEVICE_TOKEN_KEY] = pairing.deviceToken;
  existing[ACCOUNT_ID_KEY] = pairing.accountId;
  existing[PAIRED_AGENT_ID_KEY] = pairing.pairedAgentId;
  writeSecretsFile(secretsFile, existing);
}

export function clearHostedPairing(secretsFile: string): void {
  const existing = readSecretsFileSafe(secretsFile);
  delete existing[DEVICE_TOKEN_KEY];
  delete existing[ACCOUNT_ID_KEY];
  delete existing[PAIRED_AGENT_ID_KEY];
  writeSecretsFile(secretsFile, existing);
}
