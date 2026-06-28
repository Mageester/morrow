/**
 * Server-side provider credential management.
 *
 * This is the single source of truth for which environment variables back each
 * provider, and the only module that writes the Morrow secrets file (a plain
 * `KEY=VALUE` file, same format the CLI reads at startup). Configuring a
 * provider here both persists the value AND hot-applies it to `process.env` so
 * the change takes effect immediately — no service restart required.
 *
 * Secrets never leave this process: the configure endpoint accepts a key and
 * returns only a non-secret status, and reads never echo a stored value back.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderId } from "@morrow/contracts";

export interface ProviderEnvMapping {
  /** Env var holding the API key, if the provider authenticates with one. */
  apiKeyEnv?: string;
  /** Env var holding a custom base URL / endpoint. */
  baseUrlEnv?: string;
  /** Env var holding the persisted default model id. */
  modelEnv?: string;
  /** True for local providers (Ollama) configured by URL with no key. */
  local?: boolean;
}

/**
 * Canonical env-var mapping per provider. The registry resolves status/builds
 * adapters from these same names, so configuring here is guaranteed to be the
 * value the registry reads.
 */
export const PROVIDER_ENV: Partial<Record<ProviderId, ProviderEnvMapping>> = {
  openai: { apiKeyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL", modelEnv: "OPENAI_MODEL" },
  anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", modelEnv: "ANTHROPIC_MODEL" },
  gemini: { apiKeyEnv: "GEMINI_API_KEY", baseUrlEnv: "GEMINI_BASE_URL", modelEnv: "GEMINI_MODEL" },
  openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", baseUrlEnv: "OPENROUTER_BASE_URL", modelEnv: "OPENROUTER_MODEL" },
  deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", modelEnv: "DEEPSEEK_MODEL" },
  "openai-compatible": { apiKeyEnv: "OPENAI_COMPAT_API_KEY", baseUrlEnv: "OPENAI_COMPAT_BASE_URL", modelEnv: "OPENAI_COMPAT_MODEL" },
  ollama: { baseUrlEnv: "OLLAMA_BASE_URL", modelEnv: "OLLAMA_MODEL", local: true },
};

export function providerEnvMapping(id: ProviderId): ProviderEnvMapping | null {
  return PROVIDER_ENV[id] ?? null;
}

/** Parse a simple KEY=VALUE secrets file. Ignores comments and blank lines. */
export function parseSecretsFile(content: string): Record<string, string> {
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

function readSecretsFileSafe(path: string): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    return parseSecretsFile(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

function writeSecretsFile(path: string, entries: Record<string, string>): { securePermissions: boolean } {
  mkdirSync(dirname(path), { recursive: true });
  const body =
    "# Morrow secrets — plaintext, not encrypted. Keep this file private.\n" +
    Object.entries(entries)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    "\n";
  writeFileSync(path, body, { mode: 0o600 });
  let securePermissions = false;
  try {
    chmodSync(path, 0o600);
    securePermissions = process.platform !== "win32"; // Windows ignores POSIX modes.
  } catch {
    securePermissions = false;
  }
  return { securePermissions };
}

/**
 * The secrets file is a line-oriented `KEY=VALUE` format. A value that contains
 * a line break (or other control character) would split into additional lines on
 * the next read, letting a single configured field smuggle in an arbitrary,
 * unrelated env var — e.g. setting `apiKey` could inject
 * `OPENAI_BASE_URL=http://attacker` and silently redirect a provider's traffic
 * (and its real key) to an attacker. No legitimate API key, base URL, or model
 * id contains a control character, so reject them at the single writer rather
 * than trusting every caller to pre-sanitize.
 */
function assertPersistableSecretValue(envName: string, value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) {
    throw new Error(`Value for ${envName} contains control characters and cannot be stored.`);
  }
}

export interface ConfigureProviderInput {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
}

export interface ConfigureProviderResult {
  /** Env var names written (never values). */
  written: string[];
  /** Env var names removed because the caller passed an empty value. */
  cleared: string[];
  /** Whether the secrets file got owner-only (0600) permissions. */
  securePermissions: boolean;
  /**
   * Env var names that were already set in the real process environment with a
   * DIFFERENT value (e.g. exported in the shell before launch). We still set
   * process.env so the change takes effect now, but the caller should warn that
   * on next restart the file value may be re-shadowed by the shell.
   */
  shadowedByEnv: string[];
}

/**
 * Persist provider credentials and hot-apply them to `process.env`.
 *
 * An explicitly-empty string for a field removes that env var (clears it).
 * Returns only non-secret metadata.
 */
export function configureProvider(
  secretsFile: string,
  id: ProviderId,
  input: ConfigureProviderInput,
  env: NodeJS.ProcessEnv = process.env
): ConfigureProviderResult {
  const mapping = providerEnvMapping(id);
  if (!mapping) {
    throw new Error(`Provider "${id}" cannot be configured (no env mapping).`);
  }

  const updates: Array<{ envName: string; value: string | undefined }> = [];
  if (input.apiKey !== undefined && mapping.apiKeyEnv) {
    updates.push({ envName: mapping.apiKeyEnv, value: input.apiKey });
  }
  if (input.baseUrl !== undefined && mapping.baseUrlEnv) {
    updates.push({ envName: mapping.baseUrlEnv, value: input.baseUrl });
  }
  if (input.model !== undefined && mapping.modelEnv) {
    updates.push({ envName: mapping.modelEnv, value: input.model });
  }

  // Validate every value BEFORE mutating env/file so a single bad value can
  // never leave a half-applied configuration behind.
  for (const { envName, value } of updates) {
    const trimmed = value?.trim() ?? "";
    if (trimmed !== "") assertPersistableSecretValue(envName, trimmed);
  }

  const existing = readSecretsFileSafe(secretsFile);
  const written: string[] = [];
  const cleared: string[] = [];
  const shadowedByEnv: string[] = [];

  for (const { envName, value } of updates) {
    const trimmed = value?.trim() ?? "";
    if (trimmed === "") {
      delete existing[envName];
      delete env[envName];
      cleared.push(envName);
    } else {
      if (env[envName] !== undefined && env[envName] !== trimmed) {
        shadowedByEnv.push(envName);
      }
      existing[envName] = trimmed;
      env[envName] = trimmed; // hot-apply: effective immediately, no restart.
      written.push(envName);
    }
  }

  const { securePermissions } = writeSecretsFile(secretsFile, existing);
  return { written, cleared, securePermissions, shadowedByEnv };
}

/** Remove all credentials for a provider from both the secrets file and env. */
export function removeProviderCredentials(
  secretsFile: string,
  id: ProviderId,
  env: NodeJS.ProcessEnv = process.env
): { removed: string[] } {
  const mapping = providerEnvMapping(id);
  if (!mapping) return { removed: [] };
  const names = [mapping.apiKeyEnv, mapping.baseUrlEnv, mapping.modelEnv].filter(
    (n): n is string => !!n
  );
  const existing = readSecretsFileSafe(secretsFile);
  const removed: string[] = [];
  for (const name of names) {
    if (existing[name] !== undefined) {
      delete existing[name];
      removed.push(name);
    }
    delete env[name];
  }
  writeSecretsFile(secretsFile, existing);
  return { removed };
}
