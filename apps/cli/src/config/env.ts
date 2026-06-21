import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Parse a simple KEY=VALUE .env file. Ignores comments and blank lines. */
export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function readEnvFileSafe(path: string): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    return parseEnvFile(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Layer Morrow's dedicated secrets file into process.env WITHOUT overriding values that
 * are already present (the real shell environment always wins). Returns the
 * names (never the values) of keys that were applied.
 */
export function loadSecretsIntoEnv(opts: { secretsFile: string }): string[] {
  const applied: string[] = [];
  const parsed = readEnvFileSafe(opts.secretsFile);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      applied.push(k);
    }
  }
  return applied;
}

/**
 * Persist a single secret to the user secrets file with best-effort restrictive
 * permissions. Returns whether secure (0600) permissions were actually applied
 * so callers can be honest about plaintext-at-rest on platforms that ignore them.
 */
export function writeSecret(secretsFile: string, key: string, value: string): { securePermissions: boolean } {
  mkdirSync(dirname(secretsFile), { recursive: true });
  const existing = readEnvFileSafe(secretsFile);
  existing[key] = value;
  const body =
    "# Morrow secrets — plaintext, not encrypted. Keep this file private.\n" +
    Object.entries(existing)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    "\n";
  writeFileSync(secretsFile, body, { mode: 0o600 });
  let securePermissions = false;
  try {
    chmodSync(secretsFile, 0o600);
    securePermissions = process.platform !== "win32"; // Windows ignores POSIX modes.
  } catch {
    securePermissions = false;
  }
  return { securePermissions };
}

/** List secret key names present in the secrets file (never values). */
export function listSecretKeys(secretsFile: string): string[] {
  return Object.keys(readEnvFileSafe(secretsFile));
}
