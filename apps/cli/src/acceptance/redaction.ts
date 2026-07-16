const REDACTED = "[REDACTED]";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactAcceptanceText(input: string, secrets: readonly string[] = []): string {
  let output = input;
  for (const secret of secrets) {
    if (secret.length >= 4) output = output.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  output = output.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, REDACTED);
  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{6,}/gi, REDACTED);
  output = output.replace(/\b(sk|pk)-[A-Za-z0-9_-]{12,}/g, REDACTED);
  output = output.replace(/\b([A-Z0-9_]*(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD)|password)\s*([:=])\s*([^\s,;]+)/gi, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`);
  return output;
}

export function redactAcceptanceValue<T>(value: T, secrets: readonly string[] = []): T {
  if (typeof value === "string") return redactAcceptanceText(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactAcceptanceValue(item, secrets)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactAcceptanceValue(item, secrets)])) as T;
  }
  return value;
}
