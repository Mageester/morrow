/**
 * Hermes → Morrow configuration import.
 *
 * Reads a Hermes-style config file (`.env` `KEY=VALUE` lines and/or
 * `key: value` YAML-ish lines) and maps the keys Morrow genuinely understands
 * into a Morrow-shaped result. Two hard rules:
 *
 *  1. **Never invent.** A key we don't recognize goes to `unmapped` — it is
 *     surfaced to the user, never silently dropped and never guessed at.
 *  2. **Never leak secrets.** Secret values are not copied into the human
 *     summary; we record only the env-var *name* and whether it was set, so the
 *     user keeps custody of their own credentials.
 */

export type HermesConfig = Record<string, string>;

/** Parse `KEY=VALUE` and `key: value` lines, ignoring comments and blanks. */
export function parseHermesEnv(text: string): HermesConfig {
  const config: HermesConfig = {};
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();

    const eq = line.indexOf("=");
    const colon = line.indexOf(":");
    let key: string;
    let value: string;
    if (eq !== -1 && (colon === -1 || eq < colon)) {
      key = line.slice(0, eq).trim();
      value = line.slice(eq + 1).trim();
    } else if (colon !== -1) {
      key = line.slice(0, colon).trim();
      value = line.slice(colon + 1).trim();
    } else {
      continue;
    }
    value = value.replace(/^["']|["']$/g, "");
    if (key) config[key] = value;
  }
  return config;
}

export interface SecretRef {
  envName: string;
  present: boolean;
}

export interface MorrowImport {
  provider: string | null;
  model: string | null;
  settings: Record<string, string>;
  secrets: SecretRef[];
  unmapped: string[];
}

const PROVIDER_KEYS = new Set(["PROVIDER", "MODEL_PROVIDER", "LLM_PROVIDER"]);
const MODEL_KEYS = new Set(["MODEL", "MODEL_NAME", "DEFAULT_MODEL"]);
const SETTING_KEYS = new Set(["TEMPERATURE", "MAX_TOKENS", "BASE_URL", "API_BASE", "OPENAI_BASE_URL"]);

function isSecretKey(upper: string): boolean {
  return upper.endsWith("_API_KEY") || upper.endsWith("_TOKEN") || upper.endsWith("_SECRET") || upper.endsWith("_KEY") || upper === "APIKEY";
}

export function mapToMorrow(config: HermesConfig): MorrowImport {
  const result: MorrowImport = { provider: null, model: null, settings: {}, secrets: [], unmapped: [] };
  for (const [key, value] of Object.entries(config)) {
    const upper = key.toUpperCase();
    if (isSecretKey(upper)) {
      result.secrets.push({ envName: key, present: value.length > 0 });
    } else if (PROVIDER_KEYS.has(upper)) {
      result.provider = value;
    } else if (MODEL_KEYS.has(upper)) {
      result.model = value;
    } else if (SETTING_KEYS.has(upper)) {
      result.settings[key] = value;
    } else {
      result.unmapped.push(key);
    }
  }
  return result;
}

/** A human-readable summary that NEVER contains secret values. */
export function summarizeImport(imported: MorrowImport): string {
  const lines: string[] = [];
  if (imported.provider) lines.push(`provider: ${imported.provider}`);
  if (imported.model) lines.push(`model: ${imported.model}`);
  for (const [key, value] of Object.entries(imported.settings)) lines.push(`setting ${key}: ${value}`);
  for (const secret of imported.secrets) lines.push(`secret ${secret.envName}: ${secret.present ? "set (value not imported)" : "empty"}`);
  if (imported.unmapped.length > 0) lines.push(`unmapped (${imported.unmapped.length}): ${imported.unmapped.join(", ")}`);
  return lines.join("\n");
}
