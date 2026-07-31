import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ensureRunning } from "../service/lifecycle.js";
import { flagString } from "../cli/args.js";
import { isInteractive } from "./common.js";
import { usageError, EXIT } from "../cli/errors.js";
import { pickProvider, printCatalog, setupProvider, supportsOAuth } from "./provider-setup.js";

// Re-exported for callers that predate the split (chat's `/connect`, tests).
export {
  OAUTH_ELIGIBLE,
  oauthLogin,
  parseLocalCallback,
  waitForLocalCallback,
} from "./provider-oauth.js";

export async function providersCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  await ensureRunning(ctx);
  const api = ctx.api();
  switch (sub) {
    case undefined:
    case "list":
      return list(ctx, api);
    case "status":
      return status(ctx, api);
    case "configure":
      return configure(ctx, api, args);
    case "remove":
      return remove(ctx, api, args);
    case "test":
      return test(ctx, api, args);
    default:
      throw usageError(`Unknown providers subcommand: ${sub}`, "Try: list, status, configure, remove, test");
  }
}

async function list(ctx: Context, api: MorrowApi): Promise<number> {
  const providers = await api.listProviders();
  const oauth = await api.listOAuth();
  if (ctx.out.json) {
    ctx.out.data({ providers, oauth });
    return EXIT.OK;
  }
  // Grouped rather than a flat table: with a catalog this size, a wall of ids
  // is not a menu a person can actually choose from.
  ctx.out.heading("Providers");
  printCatalog(ctx, providers);
  ctx.out.print();
  ctx.out.diag(ctx.out.gray("● configured   ○ not configured"));
  ctx.out.diag(ctx.out.gray("Set one up with `morrow providers configure <name>`."));

  ctx.out.heading("Subscription OAuth findings (honest)");
  for (const f of oauth) {
    const mark = f.status === "available" ? ctx.out.green("available") : ctx.out.yellow("unavailable");
    ctx.out.print(`  ${mark}  ${ctx.out.bold(f.label)}`);
    ctx.out.print(ctx.out.gray(`    ${f.reason}`));
    ctx.out.print(ctx.out.gray(`    → ${f.recommendation}`));
  }
  return EXIT.OK;
}

async function status(ctx: Context, api: MorrowApi): Promise<number> {
  const providers = await api.listProviders();
  if (ctx.out.json) {
    ctx.out.data(providers.map((p) => ({ id: p.id, configured: p.configured, authStatus: p.authStatus, endpointHost: p.endpointHost })));
    return EXIT.OK;
  }
  ctx.out.heading("Provider status");
  for (const p of providers) {
    const mark = p.configured ? ctx.out.green("● configured") : ctx.out.gray("○ not configured");
    ctx.out.print(`  ${mark}  ${ctx.out.bold(p.id)} ${ctx.out.gray("(" + p.authStatus + ")")}`);
    if (!p.configured && p.setupHint) ctx.out.print(ctx.out.gray(`    ${p.setupHint}`));
  }
  return EXIT.OK;
}

/**
 * Configure one provider, or browse the catalog when none is named.
 *
 * The provider list comes from the server rather than a hardcoded map, so every
 * provider Morrow supports is configurable here the day it is added — the CLI
 * can no longer know about fewer providers than the engine does.
 */
async function configure(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const providers = await api.listProviders();
  const requested = args[0];

  let target = requested
    ? providers.find((p) => p.id === requested) ??
      providers.find((p) => p.label.toLowerCase() === requested.toLowerCase())
    : undefined;

  if (requested && !target) {
    const near = providers
      .filter((p) => p.id.includes(requested.toLowerCase()) || p.label.toLowerCase().includes(requested.toLowerCase()))
      .map((p) => p.id);
    throw usageError(
      `Unknown provider: ${requested}`,
      near.length > 0
        ? `Did you mean: ${near.join(", ")}? Run \`morrow providers list\` to see all ${providers.length}.`
        : `Run \`morrow providers list\` to see all ${providers.length} providers.`
    );
  }

  if (!target) {
    if (!isInteractive(ctx)) {
      throw usageError(
        "Usage: morrow providers configure <provider> [--key <key>] [--url <url>] [--model <id>]",
        `Run \`morrow providers list\` to see all ${providers.length} providers.`
      );
    }
    const picked = await pickProvider(ctx, api);
    if (!picked) return EXIT.OK;
    target = picked;
  }

  // An explicit --key means "use API-key setup", even for a provider that
  // supports subscription sign-in.
  const key = flagString(ctx.flags, "key");
  const url = flagString(ctx.flags, "url");
  const model = flagString(ctx.flags, "model");

  const result = await setupProvider(ctx, api, target, {
    ...(key !== undefined ? { apiKey: key } : {}),
    ...(url !== undefined ? { baseUrl: url } : {}),
    ...(model !== undefined ? { model } : {}),
  });

  if (ctx.out.json) ctx.out.data(result);
  if (!result.ok) {
    if (result.detail) ctx.out.error(result.detail);
    return EXIT.PROVIDER;
  }
  return EXIT.OK;
}


async function remove(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("Usage: morrow providers remove <provider>");
  const res = await api.removeProviderCredentials(id);
  ctx.out.success(`Removed stored credentials for ${id}${res.removed.length ? ` (${res.removed.join(", ")})` : " (nothing was stored)"}.`);
  if (ctx.out.json) ctx.out.data(res);
  return EXIT.OK;
}

async function test(ctx: Context, api: MorrowApi, args: string[]): Promise<number> {
  const id = args[0];
  if (!id) throw usageError("Usage: morrow providers test <provider>");
  ctx.out.info(`Testing ${id}…`);
  const result = await api.testProvider(id);
  if (ctx.out.json) {
    ctx.out.data(result);
    return result.ok ? EXIT.OK : EXIT.PROVIDER;
  }
  if (result.ok) {
    ctx.out.success(`${id} reachable${result.latencyMs !== null ? ` (${result.latencyMs} ms)` : ""}.`);
    if (result.credentialVerified === false) {
      // Reaching the endpoint is not the same as proving the key. Say which
      // one actually happened rather than letting "reachable" imply both.
      ctx.out.info("This endpoint lists models without authentication, so the credential itself was not checked — an invalid one would fail on first use.");
    }
    if (result.checkedEndpoint) ctx.out.info(`Endpoint: ${result.checkedEndpoint}`);
    if (result.modelsSample.length > 0) ctx.out.info(`Models: ${result.modelsSample.join(", ")}…`);
    return EXIT.OK;
  }
  ctx.out.error(`${id}: ${result.detail}`);
  // Point at reconfiguration when there is no credential at all, or when the
  // provider actively rejected the one stored. A network error or a provider
  // outage is not a reason to send someone to re-enter a working key.
  if (!result.configured || result.errorKind === "auth") {
    ctx.out.info(`Configure it with \`morrow providers configure ${id}\`.`);
  }
  return EXIT.PROVIDER;
}
