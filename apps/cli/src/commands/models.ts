import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { select, isInteractive } from "./common.js";
import { usageError, notFound, EXIT } from "../cli/errors.js";

export async function modelsCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  switch (sub) {
    case undefined:
    case "list":
      return list(ctx, api);
    case "select":
      return selectModel(ctx, api, args[0]);
    case "info":
      return info(ctx, api, args);
    default:
      throw usageError(`Unknown models subcommand: ${sub}`, "Try: list, select, info");
  }
}

async function list(ctx: Context, api: MorrowApi): Promise<number> {
  const models = await api.listModels();
  if (ctx.out.json) {
    ctx.out.data(models);
    return EXIT.OK;
  }
  ctx.out.heading("Models");
  ctx.out.table(
    ["", "id", "provider", "context", "speed", "cost", "privacy"],
    models.map((m) => [
      m.available ? ctx.out.green("●") : ctx.out.gray("○"),
      m.model.id,
      m.model.providerId,
      m.model.contextWindow ? `${Math.round(m.model.contextWindow / 1000)}k` : "?",
      m.model.speedClass,
      m.model.costClass,
      m.model.privacy === "local" ? ctx.out.green("local") : "remote",
    ])
  );
  ctx.out.diag("");
  ctx.out.diag(ctx.out.gray("● available (provider configured)   ○ provider not configured"));
  return EXIT.OK;
}

async function selectModel(ctx: Context, api: MorrowApi, requested?: string): Promise<number> {
  const models = await api.listModels();
  const available = models.filter((m) => m.available);
  const pool = available.length > 0 ? available : models;
  let chosen = requested ? models.find((model) => model.model.id === requested) : undefined;
  if (requested && !chosen) throw notFound(`Unknown model: ${requested}`);
  if (!chosen) {
    if (!isInteractive(ctx)) throw usageError("Usage: morrow models select <model>");
    chosen = pool[(await select(ctx, "Select default model", pool, (m) => `${m.model.id}  ${ctx.out.gray(m.model.label)}${m.available ? "" : ctx.out.yellow(" (provider not configured)")}`))]!;
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
  const match = models.find((m) => m.model.id === id);
  if (!match) throw notFound(`Unknown model: ${id}`);
  if (ctx.out.json) {
    ctx.out.data(match);
    return EXIT.OK;
  }
  ctx.out.heading(match.model.label);
  ctx.out.keyValue([
    ["id", match.model.id],
    ["provider", match.model.providerId],
    ["available", match.available ? "yes" : "no (provider not configured)"],
    ["context window", match.model.contextWindow ? `${match.model.contextWindow.toLocaleString()} tokens` : "unknown"],
    ["streaming", String(match.model.capabilities.streaming)],
    ["tool calls", String(match.model.capabilities.toolCalls)],
    ["vision", String(match.model.capabilities.vision)],
    ["speed", match.model.speedClass],
    ["cost", match.model.costClass],
    ["privacy", match.model.privacy],
  ]);
  return EXIT.OK;
}
