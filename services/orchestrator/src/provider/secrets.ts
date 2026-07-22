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
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { ProviderId } from "@morrow/contracts";

export interface ProviderEnvMapping {
  /** Env var holding the API key, if the provider authenticates with one. */
  apiKeyEnv?: string;
  /** Env var holding a custom base URL / endpoint. */
  baseUrlEnv?: string;
  /** Env var holding the persisted default model id. */
  modelEnv?: string;
  /** Env var holding a verified limit for the configured endpoint route. */
  contextLimitEnv?: string;
  /** True for local providers (Ollama) configured by URL with no key. */
  local?: boolean;
}

/**
 * Canonical env-var mapping per provider. The registry resolves status/builds
 * adapters from these same names, so configuring here is guaranteed to be the
 * value the registry reads.
 */
export const PROVIDER_ENV: Partial<Record<ProviderId, ProviderEnvMapping>> = {
  openai: { apiKeyEnv: "OPENAI_API_KEY", baseUrlEnv: "OPENAI_BASE_URL", modelEnv: "OPENAI_MODEL", contextLimitEnv: "OPENAI_CONTEXT_LIMIT" },
  anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY", baseUrlEnv: "ANTHROPIC_BASE_URL", modelEnv: "ANTHROPIC_MODEL", contextLimitEnv: "ANTHROPIC_CONTEXT_LIMIT" },
  gemini: { apiKeyEnv: "GEMINI_API_KEY", baseUrlEnv: "GEMINI_BASE_URL", modelEnv: "GEMINI_MODEL", contextLimitEnv: "GEMINI_CONTEXT_LIMIT" },
  openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", baseUrlEnv: "OPENROUTER_BASE_URL", modelEnv: "OPENROUTER_MODEL", contextLimitEnv: "OPENROUTER_CONTEXT_LIMIT" },
  deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY", baseUrlEnv: "DEEPSEEK_BASE_URL", modelEnv: "DEEPSEEK_MODEL", contextLimitEnv: "DEEPSEEK_CONTEXT_LIMIT" },
  "openai-compatible": { apiKeyEnv: "OPENAI_COMPAT_API_KEY", baseUrlEnv: "OPENAI_COMPAT_BASE_URL", modelEnv: "OPENAI_COMPAT_MODEL", contextLimitEnv: "OPENAI_COMPAT_CONTEXT_LIMIT" },
  ollama: { baseUrlEnv: "OLLAMA_BASE_URL", modelEnv: "OLLAMA_MODEL", contextLimitEnv: "OLLAMA_CONTEXT_LIMIT", local: true },
};

export function providerEnvMapping(id: ProviderId): ProviderEnvMapping | null {
  return PROVIDER_ENV[id] ?? null;
}

/** One-way identity used to bind cached health to the exact credential tested. */
export function providerCredentialIdentity(id: ProviderId, env: NodeJS.ProcessEnv = process.env): string | null {
  const apiKeyEnv = providerEnvMapping(id)?.apiKeyEnv;
  const value = apiKeyEnv ? env[apiKeyEnv]?.trim() : undefined;
  return value ? createHash("sha256").update(value).digest("hex") : null;
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

export interface CredentialFileOptions {
  platform?: NodeJS.Platform;
  applyWindowsAcl?: (path: string) => boolean;
}

/** Restrict a file to the current Windows user and LocalSystem using SID ACLs. */
export function applyWindowsCredentialAcl(path: string): boolean {
  try {
    const identity = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true });
    const sid = identity.match(/,"([^"]+)"\s*$/)?.[1];
    if (!sid || !/^S-1-\d+(?:-\d+)+$/i.test(sid)) return false;
    execFileSync("icacls.exe", [path, "/inheritance:r", "/grant:r", `*${sid}:(F)`, "*S-1-5-18:(F)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function writeSecretsFile(path: string, entries: Record<string, string>, options: CredentialFileOptions = {}): { securePermissions: boolean; credentialProtection: "windows-user-acl" | "posix-mode" } {
  mkdirSync(dirname(path), { recursive: true });
  const body =
    "# Morrow secrets — plaintext, not encrypted. Keep this file private.\n" +
    Object.entries(entries)
      .map(([k, v]) => `${k}=${v}`)
      .join("\n") +
    "\n";
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, body, { mode: 0o600, flag: "wx" });
  const platform = options.platform ?? process.platform;
  try {
    if (platform === "win32") {
      const applyAcl = options.applyWindowsAcl ?? applyWindowsCredentialAcl;
      if (!applyAcl(temporaryPath)) throw new Error("Unable to apply the current-user Windows ACL to the provider credential file.");
      renameSync(temporaryPath, path);
      return { securePermissions: true, credentialProtection: "windows-user-acl" };
    }
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
    return { securePermissions: true, credentialProtection: "posix-mode" };
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
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
  endpointContextLimit?: number | "" | undefined;
}

export interface ConfigureProviderResult {
  /** Env var names written (never values). */
  written: string[];
  /** Env var names removed because the caller passed an empty value. */
  cleared: string[];
  /** Whether the secrets file got owner-only (0600) permissions. */
  securePermissions: boolean;
  /** Enforced local file boundary; never contains a path, identity, or value. */
  credentialProtection: "windows-user-acl" | "posix-mode";
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
  env: NodeJS.ProcessEnv = process.env,
  options: CredentialFileOptions = {},
): ConfigureProviderResult {
  const mapping = providerEnvMapping(id);
  if (!mapping) {
    throw new Error(`Provider "${id}" cannot be configured (no env mapping).`);
  }

  const updates = providerConfigurationUpdates(mapping, input);
  validateProviderUpdates(updates);

  const existing = readSecretsFileSafe(secretsFile);
  const written: string[] = [];
  const cleared: string[] = [];
  const shadowedByEnv: string[] = [];

  for (const { envName, value } of updates) {
    const trimmed = value?.trim() ?? "";
    if (trimmed === "") {
      delete existing[envName];
      cleared.push(envName);
    } else {
      if (env[envName] !== undefined && env[envName] !== trimmed) shadowedByEnv.push(envName);
      existing[envName] = trimmed;
      written.push(envName);
    }
  }

  // Persist and enforce the platform boundary before promoting the candidate
  // values into the live process. A write/ACL failure leaves the live route as-is.
  const protection = writeSecretsFile(secretsFile, existing, options);
  for (const { envName, value } of updates) {
    const trimmed = value?.trim() ?? "";
    if (trimmed === "") delete env[envName];
    else env[envName] = trimmed;
  }
  return { written, cleared, ...protection, shadowedByEnv };
}

function providerConfigurationUpdates(mapping: ProviderEnvMapping, input: ConfigureProviderInput): Array<{ envName: string; value: string | undefined }> {
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
  if (input.endpointContextLimit !== undefined && mapping.contextLimitEnv) {
    const limit = input.endpointContextLimit;
    if (limit !== "" && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error(`${mapping.contextLimitEnv} must be a positive safe integer.`);
    }
    updates.push({ envName: mapping.contextLimitEnv, value: limit === "" ? "" : String(limit) });
  }

  return updates;
}

function validateProviderUpdates(updates: Array<{ envName: string; value: string | undefined }>): void {
  for (const { envName, value } of updates) {
    const trimmed = value?.trim() ?? "";
    if (trimmed !== "") assertPersistableSecretValue(envName, trimmed);
  }

}

/** Build an isolated candidate environment for authentication before persistence. */
export function buildProviderCandidateEnv(id: ProviderId, input: ConfigureProviderInput, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const mapping = providerEnvMapping(id);
  if (!mapping) throw new Error(`Provider "${id}" cannot be configured (no env mapping).`);
  const updates = providerConfigurationUpdates(mapping, input);
  validateProviderUpdates(updates);
  const candidate = { ...env };
  for (const { envName, value } of updates) {
    const trimmed = value?.trim() ?? "";
    if (trimmed === "") delete candidate[envName];
    else candidate[envName] = trimmed;
  }
  return candidate;
}

/** Remove all credentials for a provider from both the secrets file and env. */
export function removeProviderCredentials(
  secretsFile: string,
  id: ProviderId,
  env: NodeJS.ProcessEnv = process.env
): { removed: string[] } {
  const mapping = providerEnvMapping(id);
  if (!mapping) return { removed: [] };
  const names = [mapping.apiKeyEnv, mapping.baseUrlEnv, mapping.modelEnv, mapping.contextLimitEnv].filter(
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
