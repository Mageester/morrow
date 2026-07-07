import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { mapToMorrow, parseHermesEnv, summarizeImport, type MorrowImport } from "@morrow/hermes-compat";
import type { Context } from "../cli/context.js";
import { ensureRunning } from "../service/lifecycle.js";
import { flagBool } from "../cli/args.js";
import { usageError, CliError, EXIT } from "../cli/errors.js";

/**
 * `morrow import hermes <path> [--apply]`
 *
 * Reads a Hermes config (.env / key: value file), reports what Morrow
 * understands, and — only with --apply — configures the mapped provider
 * through the running service (same path as `morrow providers configure`).
 *
 * Import rules mirror @morrow/hermes-compat: unknown keys are surfaced, never
 * guessed; secret *values* never appear in output (human or JSON). With
 * --apply the matching provider key is written into Morrow's local secrets
 * store server-side, exactly as `providers configure` would.
 */

/** Hermes provider spellings → Morrow provider ids. */
const PROVIDER_ALIASES: Record<string, string> = {
  openai: "openai",
  chatgpt: "openai",
  anthropic: "anthropic",
  claude: "anthropic",
  gemini: "gemini",
  google: "gemini",
  openrouter: "openrouter",
  deepseek: "deepseek",
  ollama: "ollama",
  local: "ollama",
  "openai-compatible": "openai-compatible",
  "openai_compatible": "openai-compatible",
};

/** Morrow provider id → the env var Hermes stores its key under. */
const PROVIDER_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  "openai-compatible": "OPENAI_COMPAT_API_KEY",
};

export function resolveProviderId(hermesProvider: string | null): string | null {
  if (!hermesProvider) return null;
  return PROVIDER_ALIASES[hermesProvider.trim().toLowerCase()] ?? null;
}

export async function importCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  switch (sub) {
    case "hermes":
      return importHermes(ctx, args);
    default:
      throw usageError("Usage: morrow import hermes <path> [--apply]", "Supported sources: hermes (a Hermes .env or key: value config file)");
  }
}

async function readSource(path: string): Promise<{ file: string; text: string }> {
  let target = path;
  try {
    const info = await stat(path);
    if (info.isDirectory()) target = join(path, ".env");
  } catch {
    throw new CliError(`Cannot read ${path}: file not found.`, { code: "IMPORT_SOURCE", exitCode: EXIT.USAGE, hint: "Pass the path to a Hermes .env/config file (or its directory containing .env)." });
  }
  try {
    return { file: target, text: await readFile(target, "utf8") };
  } catch {
    throw new CliError(`Cannot read ${target}.`, { code: "IMPORT_SOURCE", exitCode: EXIT.USAGE, hint: "Pass the path to a Hermes .env/config file." });
  }
}

async function importHermes(ctx: Context, args: string[]): Promise<number> {
  const path = args[0];
  if (!path) throw usageError("Usage: morrow import hermes <path> [--apply]");
  const apply = flagBool(ctx.flags, "apply");

  const { file, text } = await readSource(path);
  const raw = parseHermesEnv(text);
  const imported = mapToMorrow(raw);
  const providerId = resolveProviderId(imported.provider);

  if (!ctx.out.json) {
    ctx.out.heading(`Hermes import — ${file}`);
    const summary = summarizeImport(imported);
    ctx.out.print(summary || "  (nothing recognized)");
    if (imported.provider && !providerId) {
      ctx.out.warn(`Provider "${imported.provider}" has no Morrow equivalent; it will not be applied.`);
    }
  }

  const applied = apply ? await applyImport(ctx, imported, providerId, raw) : null;

  if (ctx.out.json) {
    // `imported` never carries secret values (only env names + presence).
    ctx.out.data({ source: file, imported, providerId, applied });
    return EXIT.OK;
  }

  if (!apply) {
    ctx.out.info("Dry run — nothing was changed. Re-run with --apply to configure the mapped provider.");
    return EXIT.OK;
  }

  if (applied?.configured) {
    ctx.out.success(`Configured ${applied.configured}${applied.model ? ` (default model: ${applied.model})` : ""} — credential imported into Morrow's local secrets store (never displayed).`);
    ctx.out.info(`Verify it works: \`morrow providers test ${applied.configured}\`.`);
  } else {
    ctx.out.warn(applied?.reason ?? "Nothing appliable was found.");
  }
  return EXIT.OK;
}

interface AppliedResult {
  configured: string | null;
  model: string | null;
  reason?: string;
}

async function applyImport(
  ctx: Context,
  imported: MorrowImport,
  providerId: string | null,
  raw: Record<string, string>
): Promise<AppliedResult> {
  if (!providerId) {
    return {
      configured: null,
      model: null,
      reason: imported.provider
        ? `Provider "${imported.provider}" is not supported by Morrow; configure manually with \`morrow providers configure\`.`
        : "The file names no provider; configure one manually with `morrow providers configure`.",
    };
  }

  const input: { apiKey?: string; baseUrl?: string; model?: string } = {};
  if (imported.model) input.model = imported.model;

  const baseUrl = imported.settings["BASE_URL"] ?? imported.settings["API_BASE"] ?? imported.settings["OPENAI_BASE_URL"];
  if ((providerId === "ollama" || providerId === "openai-compatible") && baseUrl) {
    input.baseUrl = baseUrl;
  }

  const keyEnv = PROVIDER_KEY_ENV[providerId];
  const keyValue = keyEnv ? raw[keyEnv] : undefined;
  if (keyEnv && keyValue) {
    input.apiKey = keyValue;
  } else if (providerId !== "ollama") {
    return {
      configured: null,
      model: imported.model,
      reason: `The file maps to ${providerId} but contains no ${keyEnv ?? "API key"} value; run \`morrow providers configure ${providerId}\` to supply one.`,
    };
  }

  await ensureRunning(ctx);
  await ctx.api().configureProvider(providerId, input);
  return { configured: providerId, model: imported.model };
}
