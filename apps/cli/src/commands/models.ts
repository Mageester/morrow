import type { ModelStatus } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { select, isInteractive } from "./common.js";
import { usageError, notFound, EXIT } from "../cli/errors.js";
import { flagBool } from "../cli/args.js";

export function visibleModelsForAccount(models: ModelStatus[], currentModelId?: string, showAll = false): ModelStatus[] {
  if (showAll) return models;
  return models.filter((status) =>
    status.model.id === currentModelId ||
    (status.availability === undefined
      ? status.available
      : status.availability === "available")
  );
}

function isAccountAvailable(status: ModelStatus): boolean {
  return status.availability === undefined ? status.available : status.availability === "available";
}

export async function modelsCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  switch (sub) {
    case undefined:
    case "":
    case "list":
      // `--refresh` is accepted on the default/list path as well as its own
      // subcommand: the metadata gap shows up while reading the model table,
      // which is exactly where the fix should be reachable from.
      if (args.includes("--refresh") || flagBool(ctx.flags, "refresh")) {
        const code = await refresh(ctx, api);
        if (code !== EXIT.OK) return code;
        return list(ctx, api, args.filter((arg) => arg !== "--refresh"));
      }
      return list(ctx, api, args);
    case "refresh":
      return refresh(ctx, api);
    case "select":
      return selectModel(ctx, api, args[0]);
    case "info":
      return info(ctx, api, args);
    default:
      throw usageError(`Unknown models subcommand: ${sub}`, "Try: list, refresh, select, info");
  }
}

/**
 * Pull public model metadata now.
 *
 * Morrow deliberately never fetches this on its own — a Private Local session
 * must not make an outbound metadata request before any routing choice — so
 * without an explicit trigger a fresh install has no context windows and no
 * reasoning capabilities at all. This is that trigger.
 */
async function refresh(ctx: Context, api: MorrowApi): Promise<number> {
  const snapshot = await api.refreshModelCatalog();
  const count = Array.isArray(snapshot.models) ? snapshot.models.length : null;
  if (ctx.out.json) {
    ctx.out.data({ refreshed: true, catalogVersion: snapshot.catalogVersion ?? null, models: count });
    return EXIT.OK;
  }
  ctx.out.success(count === null
    ? "Model metadata refreshed."
    : `Model metadata refreshed — ${count.toLocaleString("en-US")} models.`);
  if (snapshot.catalogVersion) ctx.out.diag(ctx.out.gray(`Catalog version: ${snapshot.catalogVersion}`));
  return EXIT.OK;
}

async function list(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const unknownFlag = args.find((arg) => arg !== "--all" && arg !== "--advanced");
  if (unknownFlag) throw usageError(`Unknown models list option: ${unknownFlag}`, "Try: morrow models list [--all|--refresh]");
  const showAll = args.includes("--all") || args.includes("--advanced") || flagBool(ctx.flags, "all") || flagBool(ctx.flags, "advanced");
  const currentModelId = ctx.config.get("defaults.model") as string | undefined;
  const models = visibleModelsForAccount(await api.listModels(), currentModelId, showAll);
  if (ctx.out.json) {
    ctx.out.data(models);
    return EXIT.OK;
  }
  ctx.out.heading("Models");
  ctx.out.table(
    ["", "id", "provider", "auth", "context", "lifecycle", "source"],
    models.map((status) => [
      isAccountAvailable(status) ? ctx.out.green("●") : ctx.out.gray("○"),
      status.model.id,
      status.model.providerId,
      status.authMode ?? "unknown",
      status.model.contextWindow ? `${Math.round(status.model.contextWindow / 1000)}k` : "?",
      status.model.lifecycle ?? "unknown",
      status.model.metadataSource ?? "unknown",
    ])
  );
  ctx.out.diag("");
  ctx.out.diag(ctx.out.gray(showAll
    ? "All catalog entries shown; availability is account/auth-surface specific."
    : "Only models proven available for this account are shown. Use --all for diagnostics."));
  // A "?" context is ambiguous on its own: it reads as "this model has no
  // known limit" when it usually means "public metadata was never fetched".
  // Say which, and name the one command that fixes it — otherwise the reasoning
  // controls stay silently unavailable and nothing on screen explains why.
  if (models.some((status) => !status.model.contextWindow)) {
    ctx.out.diag(ctx.out.gray(
      "Some models show \"?\" — public metadata has not been fetched for them. Run `morrow models --refresh`."
    ));
  }
  return EXIT.OK;
}

async function selectModel(ctx: Context, api: MorrowApi, requested?: string): Promise<number> {
  const models = await api.listModels();
  const available = models.filter(isAccountAvailable);
  let chosen = requested ? models.find((model) => model.model.id === requested) : undefined;
  if (requested && !chosen) throw notFound(`Unknown model: ${requested}`);
  if (chosen && !isAccountAvailable(chosen)) {
    throw usageError(
      `Model ${chosen.model.id} is not available for the active ${chosen.authMode ?? "unknown"} auth surface.`,
      chosen.availabilityReason ?? `Refresh provider discovery or authenticate ${chosen.model.providerId}.`
    );
  }
  if (!chosen) {
    if (!isInteractive(ctx)) throw usageError("Usage: morrow models select <model>");
    if (available.length === 0) throw usageError("No account-available models were discovered.", "Authenticate a provider, then run its connectivity test.");
    chosen = available[(await select(ctx, "Select default model", available, (model) => `${model.model.id}  ${ctx.out.gray(model.model.label)}`))]!;
  }
  ctx.config.set("defaults.model", chosen.model.id, ctx.paths.projectConfigFile ? "project" : "user");
  ctx.config.set("defaults.provider", chosen.model.providerId, ctx.paths.projectConfigFile ? "project" : "user");
  ctx.out.success(`Default model set to ${chosen.model.id} (${chosen.model.providerId}).`);
  return EXIT.OK;
}

async function info(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("Usage: morrow models info <model>");
  const models = await api.listModels();
  const match = models.find((status) => status.model.id === id);
  if (!match) throw notFound(`Unknown model: ${id}`);
  if (ctx.out.json) {
    ctx.out.data(match);
    return EXIT.OK;
  }
  ctx.out.heading(match.model.label);
  ctx.out.keyValue([
    ["id", match.model.id],
    ["provider", match.model.providerId],
    ["auth mode", match.authMode ?? "unknown"],
    ["availability", match.availability ?? (match.available ? "available (legacy server)" : "unavailable (legacy server)")],
    ["availability source", match.availabilitySource ?? "unknown"],
    ["availability reason", match.availabilityReason ?? "none reported"],
    ["context window", match.model.contextWindow ? `${match.model.contextWindow.toLocaleString()} tokens` : "unknown"],
    ["streaming", String(match.model.capabilities.streaming)],
    ["tool calls", String(match.model.capabilities.toolCalls)],
    ["vision", String(match.model.capabilities.vision)],
    ["speed", match.model.speedClass],
    ["cost", match.model.costClass],
    ["privacy", match.model.privacy],
    ["lifecycle", match.model.lifecycle ?? "unknown"],
    ["metadata source", match.model.metadataSource ?? "unknown"],
    ["metadata version", match.model.metadataVersion ?? "unknown"],
    ["metadata confidence", match.model.confidence ?? "unknown"],
  ]);
  return EXIT.OK;
}
