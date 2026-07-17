import type { ModelStatus } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { select, isInteractive } from "./common.js";
import { usageError, notFound, EXIT } from "../cli/errors.js";

export function visibleModelsForAccount(models: ModelStatus[], currentModelId?: string, showAll = false): ModelStatus[] {
  if (showAll) return models;
  return models.filter((status) =>
    status.model.id === currentModelId ||
    (status.availability === undefined
      ? status.available
      : status.availability === "available" && (status.model.lifecycle === "current" || status.model.lifecycle === "preview"))
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
      return list(ctx, api, args);
    case "select":
      return selectModel(ctx, api, args[0]);
    case "info":
      return info(ctx, api, args);
    default:
      throw usageError(`Unknown models subcommand: ${sub}`, "Try: list, select, info");
  }
}

async function list(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const unknownFlag = args.find((arg) => arg !== "--all" && arg !== "--advanced");
  if (unknownFlag) throw usageError(`Unknown models list option: ${unknownFlag}`, "Try: morrow models list [--all]");
  const showAll = args.includes("--all") || args.includes("--advanced");
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
