import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolvePaths, type MorrowPaths } from "./paths.js";
import { CliError, EXIT } from "../cli/errors.js";

/**
 * Layered configuration with a strict precedence:
 *   command-line flags > project config > user config > environment > defaults
 *
 * Secrets are NEVER stored here — they live in the secrets file (see env.ts) and
 * never appear in `config list`. This module only holds non-secret preferences.
 */

export interface CustomPreset {
  id: string;
  label: string;
  /** Built-in preset whose execution budgets this custom preset inherits. */
  base: string;
  provider?: string;
  model?: string;
  useMemory?: boolean;
}

export interface MorrowConfig {
  defaults?: {
    project?: string;
    preset?: string;
    provider?: string;
    model?: string;
    useMemory?: boolean;
    mode?: string;
    autoApprove?: boolean;
  };
  service?: {
    host?: string;
    port?: number;
    dbPath?: string;
    baseUrl?: string;
  };
  ui?: {
    color?: boolean;
    unicode?: boolean;
  };
  /** Local-only personalization (stored under MORROW_HOME, never a secret). */
  user?: {
    name?: string;
    onboarded?: boolean;
    onboardingStep?: string;
    useCase?: string;
  };
  presets?: CustomPreset[];
}

const ALLOWED_KEYS = new Set([
  "defaults.project",
  "defaults.preset",
  "defaults.provider",
  "defaults.model",
  "defaults.useMemory",
  "defaults.mode",
  "defaults.autoApprove",
  "service.host",
  "service.port",
  "service.dbPath",
  "service.baseUrl",
  "ui.color",
  "ui.unicode",
  "user.name",
  "user.onboarded",
  "user.onboardingStep",
  "user.useCase",
]);

function readJson(path: string): MorrowConfig {
  try {
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf-8")) as MorrowConfig;
  } catch (e: any) {
    throw new CliError(`Invalid config file: ${path} (${e.message})`, { code: "CONFIG_INVALID", exitCode: EXIT.USAGE });
  }
}

function deepMerge(base: MorrowConfig, over: MorrowConfig): MorrowConfig {
  return {
    defaults: { ...base.defaults, ...over.defaults },
    service: { ...base.service, ...over.service },
    ui: { ...base.ui, ...over.ui },
    user: { ...base.user, ...over.user },
    ...((over.presets ?? base.presets) !== undefined ? { presets: over.presets ?? base.presets } : {}),
  };
}

function configFromEnvironment(env: NodeJS.ProcessEnv): MorrowConfig {
  const defaults: NonNullable<MorrowConfig["defaults"]> = {};
  if (env.MORROW_DEFAULT_PROJECT) defaults.project = env.MORROW_DEFAULT_PROJECT;
  if (env.MORROW_DEFAULT_PRESET) defaults.preset = env.MORROW_DEFAULT_PRESET;
  if (env.MORROW_DEFAULT_PROVIDER) defaults.provider = env.MORROW_DEFAULT_PROVIDER;
  if (env.MORROW_DEFAULT_MODEL) defaults.model = env.MORROW_DEFAULT_MODEL;
  if (env.MORROW_USE_MEMORY === "true" || env.MORROW_USE_MEMORY === "false") defaults.useMemory = env.MORROW_USE_MEMORY === "true";
  const service: NonNullable<MorrowConfig["service"]> = {};
  if (env.MORROW_BIND_HOST) service.host = env.MORROW_BIND_HOST;
  if (env.PORT && Number.isInteger(Number(env.PORT))) service.port = Number(env.PORT);
  if (env.DATABASE_URL) service.dbPath = env.DATABASE_URL;
  if (env.MORROW_SERVICE_URL) service.baseUrl = env.MORROW_SERVICE_URL;
  return {
    ...(Object.keys(defaults).length > 0 ? { defaults } : {}),
    ...(Object.keys(service).length > 0 ? { service } : {}),
  };
}

export class ConfigStore {
  readonly paths: MorrowPaths;
  readonly environment: MorrowConfig;
  readonly user: MorrowConfig;
  readonly project: MorrowConfig;
  readonly merged: MorrowConfig;

  constructor(paths: MorrowPaths, environment: NodeJS.ProcessEnv = process.env) {
    this.paths = paths;
    this.environment = configFromEnvironment(environment);
    this.user = readJson(paths.userConfigFile);
    this.project = paths.projectConfigFile ? readJson(paths.projectConfigFile) : {};
    this.merged = deepMerge(deepMerge(this.environment, this.user), this.project);
  }

  static load(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): ConfigStore {
    return new ConfigStore(resolvePaths(env, cwd), env);
  }

  /** Flattened, non-secret view for `config list`. */
  flat(): Array<{ key: string; value: string; source: "project" | "user" | "environment" | "default" }> {
    const out: Array<{ key: string; value: string; source: "project" | "user" | "environment" | "default" }> = [];
    const keys = new Set(ALLOWED_KEYS);
    const collectSkillKeys = (obj: any, prefix = "") => {
      if (!obj || typeof obj !== "object") return;
      for (const k of Object.keys(obj)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (full.startsWith("skills.") && full.endsWith(".enabled")) {
          keys.add(full);
        } else if (typeof obj[k] === "object") {
          collectSkillKeys(obj[k], full);
        }
      }
    };
    collectSkillKeys(this.user);
    collectSkillKeys(this.project);

    for (const key of keys) {
      const projectVal = getPath(this.project, key);
      const userVal = getPath(this.user, key);
      const environmentVal = getPath(this.environment, key);
      if (projectVal !== undefined) out.push({ key, value: String(projectVal), source: "project" });
      else if (userVal !== undefined) out.push({ key, value: String(userVal), source: "user" });
      else if (environmentVal !== undefined) out.push({ key, value: String(environmentVal), source: "environment" });
    }
    return out;
  }

  get(key: string): unknown {
    return getPath(this.merged, key);
  }

  set(key: string, value: string, scope: "user" | "project"): void {
    const isSkillKey = key.startsWith("skills.") && key.endsWith(".enabled");
    if (!ALLOWED_KEYS.has(key) && !isSkillKey) {
      throw new CliError(`Unknown config key: ${key}`, {
        code: "CONFIG_UNKNOWN_KEY",
        exitCode: EXIT.USAGE,
        hint: `Valid keys: ${[...ALLOWED_KEYS].join(", ")}`,
      });
    }
    const coerced = coerce(key, value);
    const file = scope === "project" ? this.paths.projectConfigFile : this.paths.userConfigFile;
    if (!file) throw new CliError("No project config location (not inside a Morrow repo).", { code: "NO_PROJECT", exitCode: EXIT.USAGE });
    const current = readJson(file);
    setPath(current, key, coerced);
    persist(file, current);

    // Update in-memory state
    setPath(scope === "project" ? this.project : this.user, key, coerced);
    setPath(this.merged, key, coerced);
  }

  unset(key: string, scope: "user" | "project"): void {
    const file = scope === "project" ? this.paths.projectConfigFile : this.paths.userConfigFile;
    if (!file) throw new CliError("No project config location.", { code: "NO_PROJECT", exitCode: EXIT.USAGE });
    const current = readJson(file);
    deletePath(current, key);
    persist(file, current);

    // Update in-memory state
    deletePath(scope === "project" ? this.project : this.user, key);
    deletePath(this.merged, key);
  }

  /** Custom presets (config-backed), merged project-over-user. */
  customPresets(): CustomPreset[] {
    return this.merged.presets ?? [];
  }

  saveCustomPresets(presets: CustomPreset[], scope: "user" | "project"): void {
    const file = scope === "project" ? this.paths.projectConfigFile : this.paths.userConfigFile;
    if (!file) throw new CliError("No project config location.", { code: "NO_PROJECT", exitCode: EXIT.USAGE });
    const current = readJson(file);
    current.presets = presets;
    persist(file, current);
  }
}

function persist(file: string, config: MorrowConfig): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");
}

function coerce(key: string, value: string): unknown {
  if (key === "service.port") {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      throw new CliError(`service.port must be an integer 1–65535 (got "${value}")`, { code: "CONFIG_INVALID_VALUE", exitCode: EXIT.USAGE });
    }
    return n;
  }
  if (key === "ui.color" || key === "ui.unicode" || key === "defaults.useMemory" || key === "defaults.autoApprove" || key === "user.onboarded" || (key.startsWith("skills.") && key.endsWith(".enabled"))) {
    if (value === "true" || value === true as any) return true;
    if (value === "false" || value === false as any) return false;
    throw new CliError(`${key} must be "true" or "false" (got "${value}")`, { code: "CONFIG_INVALID_VALUE", exitCode: EXIT.USAGE });
  }
  if (key === "defaults.mode") {
    if (["agent", "read-only", "plan-only"].includes(value)) return value;
    throw new CliError(`defaults.mode must be agent | read-only | plan-only (got "${value}")`, { code: "CONFIG_INVALID_VALUE", exitCode: EXIT.USAGE });
  }
  return value;
}

function getPath(obj: any, path: string): unknown {
  return path.split(".").reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

function setPath(obj: any, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]!] = value;
}

function deletePath(obj: any, path: string): void {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) return;
    cur = cur[k];
  }
  delete cur[parts[parts.length - 1]!];
}
