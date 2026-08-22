/**
 * `morrow team` — turn unattended teamwork on or off for a project.
 *
 * Morrow is the orchestrator and the named teammates are its workers, but every
 * hand-off used to stop and wait for a click. Standing trust existed only as a
 * per-pair grant, which meant N teammates needed N x (N-1) separate permissions,
 * and Morrow itself was excluded from holding one at all.
 *
 * This is the single decision that replaces all of that: turn it on, and Morrow
 * may hand work to its teammates — and they to each other — without stopping,
 * inside limits the user sets. It is the control that opens the gate, and it
 * ships alongside the gate rather than after it.
 */
import type { Context } from "../cli/context.js";
import { CliError, EXIT } from "../cli/errors.js";
import { ensureRunning } from "../service/lifecycle.js";
import { flagBool, flagString } from "../cli/args.js";
import { resolveProject } from "./common.js";

function printTeamHelp(ctx: Context): number {
  ctx.out.print(`Morrow team — let Morrow run its teammates unattended

Usage:
  morrow team                 show whether unattended teamwork is on
  morrow team on              let Morrow hand work to teammates without asking
  morrow team off             go back to approving every hand-off

Limits (used with "on"):
  --max-depth <n>             how many hand-offs deep a chain may go
  --max-workers <n>           how many workers one task may start
  --max-tokens <n>            total tokens for the run before it stops and asks

Morrow does not meter cost in dollars — no provider reports one — so the budget
is counted in tokens, which is what is actually measured. Every hand-off is
still recorded, and "morrow team off" withdraws the grant immediately, including
part-way through a run.`);
  return EXIT.OK;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export async function teamCommand(ctx: Context, sub: string | undefined, _args: string[]): Promise<number> {
  if (sub === "help" || flagBool(ctx.flags, "help")) return printTeamHelp(ctx);

  await ensureRunning(ctx);
  const api = ctx.api();
  const project = await resolveProject(ctx, api, { required: true, autoCreateMissing: true });
  if (!project) return EXIT.NOT_FOUND;

  switch (sub ?? "status") {
    case "status": {
      const state = await api.getTeamAutonomy(project.id);
      if (ctx.out.json) {
        ctx.out.data(state);
        return EXIT.OK;
      }
      ctx.out.heading("Unattended teamwork");
      if (!state.enabled || !state.grant) {
        ctx.out.keyValue([["status", "off"], ["project", project.name]]);
        ctx.out.print();
        ctx.out.info("Morrow asks you to approve every hand-off to a teammate.");
        ctx.out.info("Turn it on with: morrow team on");
        return EXIT.OK;
      }
      ctx.out.keyValue([
        ["status", "on"],
        ["project", project.name],
        ["hand-off depth", String(state.grant.maxDepth)],
        ["workers per task", String(state.grant.maxChildren)],
        ["token budget", fmt(state.grant.maxTotalTokens)],
        ["granted", state.grant.grantedAt],
      ]);
      ctx.out.print();
      ctx.out.info("Morrow can hand work to teammates without asking, inside these limits.");
      ctx.out.info("Turn it off with: morrow team off");
      return EXIT.OK;
    }

    case "on":
    case "trust": {
      // A limit the user typed wrong must not silently become "no limit", so a
      // non-numeric value is rejected rather than dropped.
      const limit = (name: string): number | undefined => {
        const raw = flagString(ctx.flags, name);
        if (raw === undefined) return undefined;
        const value = Number(raw);
        if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
          throw new CliError(`--${name} must be a whole number greater than zero (got "${raw}").`, { exitCode: EXIT.USAGE });
        }
        return value;
      };
      const depth = limit("max-depth");
      const workers = limit("max-workers");
      const tokens = limit("max-tokens");
      const limits = {
        ...(depth !== undefined ? { maxDepth: depth } : {}),
        ...(workers !== undefined ? { maxChildren: workers } : {}),
        ...(tokens !== undefined ? { maxTotalTokens: tokens } : {}),
      };
      const result = await api.grantTeamAutonomy(project.id, limits);
      if (ctx.out.json) {
        ctx.out.data(result);
        return EXIT.OK;
      }
      ctx.out.success(`Unattended teamwork is on for ${project.name}.`);
      ctx.out.keyValue([
        ["hand-off depth", String(result.grant.maxDepth)],
        ["workers per task", String(result.grant.maxChildren)],
        ["token budget", fmt(result.grant.maxTotalTokens)],
      ]);
      ctx.out.print();
      ctx.out.info("Morrow will hand work to teammates without stopping to ask.");
      ctx.out.info("It stops and asks again when any limit above is reached.");
      return EXIT.OK;
    }

    case "off":
    case "revoke": {
      await api.revokeTeamAutonomy(project.id);
      if (ctx.out.json) {
        ctx.out.data({ projectId: project.id, enabled: false });
        return EXIT.OK;
      }
      ctx.out.success(`Unattended teamwork is off for ${project.name}.`);
      ctx.out.info("Morrow will ask you to approve each hand-off again.");
      return EXIT.OK;
    }

    default:
      ctx.out.warn(`Unknown: morrow team ${sub}`);
      return printTeamHelp(ctx);
  }
}
