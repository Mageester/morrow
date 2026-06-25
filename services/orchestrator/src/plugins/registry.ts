import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  entrypoint: string;
  hooks: string[];
}

export interface InstalledPlugin extends PluginManifest { enabled: boolean; }

const MANIFEST = "morrow.plugin.json";
const STATE = ".morrow-plugin-state.json";
const ID = /^[a-z0-9][a-z0-9-]{1,62}$/;

function validateManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== "object") throw new Error("Plugin manifest must be an object");
  const manifest = value as Record<string, unknown>;
  const strings = ["id", "name", "version", "description", "entrypoint"] as const;
  if (strings.some((key) => typeof manifest[key] !== "string" || !manifest[key])) throw new Error("Plugin manifest has missing required fields");
  if (!ID.test(manifest.id as string)) throw new Error("Plugin manifest has an invalid id");
  const entrypoint = manifest.entrypoint as string;
  if (isAbsolute(entrypoint) || entrypoint.split(/[\\/]/).includes("..")) throw new Error("Plugin manifest entrypoint must stay inside its plugin directory");
  if (!Array.isArray(manifest.hooks) || manifest.hooks.some((hook) => typeof hook !== "string" || hook.length === 0 || hook.length > 100)) throw new Error("Plugin manifest has invalid hooks");
  return { id: manifest.id as string, name: manifest.name as string, version: manifest.version as string, description: manifest.description as string, entrypoint, hooks: [...manifest.hooks] as string[] };
}

function readManifest(directory: string): PluginManifest {
  try {
    return validateManifest(JSON.parse(readFileSync(join(directory, MANIFEST), "utf8")));
  } catch (error) {
    throw new Error(`Plugin manifest is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

function inside(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(path);
  // Containment must be checked with the OS path separator, not a hard-coded
  // backslash: relative() yields "" for the root itself and a ".."-prefixed or
  // absolute path when the target escapes, on every platform.
  const rel = relative(absoluteRoot, absolutePath);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error("Plugin path escapes the configured local plugin directory");
  }
  return absolutePath;
}

export function pluginRegistry(root: string) {
  const directory = resolve(root);
  const statePath = join(directory, STATE);
  const state = (): Record<string, boolean> => {
    try { return JSON.parse(readFileSync(statePath, "utf8")) as Record<string, boolean>; } catch { return {}; }
  };
  const saveState = (next: Record<string, boolean>) => { mkdirSync(directory, { recursive: true }); writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8"); };
  const installed = (id: string): { path: string; manifest: PluginManifest } => {
    if (!ID.test(id)) throw new Error("Plugin id is invalid");
    const path = inside(directory, join(directory, id));
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Plugin not installed: ${id}`);
    const manifest = readManifest(path);
    if (manifest.id !== id) throw new Error("Plugin directory and manifest id do not match");
    return { path, manifest };
  };
  return {
    async list(): Promise<InstalledPlugin[]> {
      if (!existsSync(directory)) return [];
      const enabled = state();
      return readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).flatMap((entry) => {
        try { const manifest = readManifest(join(directory, entry.name)); return [{ ...manifest, enabled: enabled[manifest.id] === true }]; } catch { return []; }
      });
    },
    async install(source: string): Promise<InstalledPlugin> {
      const manifest = readManifest(source);
      mkdirSync(directory, { recursive: true });
      const target = inside(directory, join(directory, manifest.id));
      if (existsSync(target)) throw new Error(`Plugin already installed: ${manifest.id}`);
      cpSync(source, target, { recursive: true, errorOnExist: true });
      const next = state(); next[manifest.id] = false; saveState(next);
      return { ...manifest, enabled: false };
    },
    async enable(id: string): Promise<InstalledPlugin> {
      const { manifest } = installed(id); const next = state(); next[id] = true; saveState(next); return { ...manifest, enabled: true };
    },
    async disable(id: string): Promise<InstalledPlugin> {
      const { manifest } = installed(id); const next = state(); next[id] = false; saveState(next); return { ...manifest, enabled: false };
    },
    async update(id: string, source: string): Promise<InstalledPlugin> {
      installed(id); const manifest = readManifest(source);
      if (manifest.id !== id) throw new Error("Plugin update id does not match installed plugin");
      const target = inside(directory, join(directory, id)); rmSync(target, { recursive: true, force: true }); cpSync(source, target, { recursive: true });
      const next = state(); next[id] = false; saveState(next); return { ...manifest, enabled: false };
    },
    async remove(id: string): Promise<void> {
      const { path } = installed(id); rmSync(path, { recursive: true, force: true }); const next = state(); delete next[id]; saveState(next);
    },
  };
}
