import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { EXIT, notFound, usageError } from "../cli/errors.js";
import { flagString } from "../cli/args.js";
import { isInteractive, select } from "./common.js";
import { ensureRunning } from "../service/lifecycle.js";

export async function presetsCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  if (!sub || sub === "list") return list(ctx, api);
  if (sub === "show") return show(ctx, api, args[0]);
  if (sub === "select") return choose(ctx, api, args[0] ?? flagString(ctx.flags, "preset"));
  throw usageError(`Unknown presets subcommand: ${sub}`, "Try: list, show, select");
}

async function list(ctx: Context, api: MorrowApi): Promise<number> {
  const presets = await api.listPresets();
  if (ctx.out.json) {
    ctx.out.data(presets);
    return EXIT.OK;
  }
  ctx.out.heading("Presets");
  ctx.out.table(
    ["", "id", "label", "privacy", "provider"],
    presets.map((preset) => [
      preset.available ? ctx.out.green("●") : ctx.out.gray("○"),
      preset.preset.id,
      preset.preset.label,
      preset.preset.privacy,
      preset.resolved?.providerId ?? "not configured",
    ])
  );
  return EXIT.OK;
}

async function show(ctx: Context, api: MorrowApi, ref: string | undefined): Promise<number> {
  if (!ref) throw usageError("Usage: morrow presets show <preset>");
  const preset = await find(api, ref);
  if (ctx.out.json) {
    ctx.out.data(preset);
    return EXIT.OK;
  }
  ctx.out.heading(preset.preset.label);
  ctx.out.keyValue([
    ["id", preset.preset.id],
    ["privacy", preset.preset.privacy],
    ["available", String(preset.available)],
    ["provider", preset.resolved?.providerId ?? "not configured"],
    ["model", preset.resolved?.model ?? "not configured"],
  ]);
  return EXIT.OK;
}

async function choose(ctx: Context, api: MorrowApi, ref: string | undefined): Promise<number> {
  const presets = await api.listPresets();
  let chosen;
  if (ref) chosen = presets.find((preset) => preset.preset.id === ref || preset.preset.label.toLowerCase() === ref.toLowerCase());
  else if (isInteractive(ctx)) chosen = presets[(await select(ctx, "Select default preset", presets, (preset) => `${preset.preset.label} (${preset.preset.privacy})`))]!;
  else throw usageError("Usage: morrow presets select <preset>");
  if (!chosen) throw notFound(`Unknown preset: ${ref}`);
  ctx.config.set("defaults.preset", chosen.preset.id, ctx.paths.projectConfigFile ? "project" : "user");
  if (ctx.out.json) ctx.out.data({ preset: chosen.preset.id });
  else ctx.out.success(`Default preset set to ${chosen.preset.label}.`);
  return EXIT.OK;
}

async function find(api: MorrowApi, ref: string) {
  const presets = await api.listPresets();
  const preset = presets.find((item) => item.preset.id === ref || item.preset.label.toLowerCase() === ref.toLowerCase());
  if (!preset) throw notFound(`Unknown preset: ${ref}`);
  return preset;
}
