/**
 * Guided provider setup, shared by `morrow onboard` and `morrow providers
 * configure`.
 *
 * One flow, used everywhere, so the quality of setup does not depend on which
 * door the user came through. It does five things in order:
 *
 *   1. Browse or search the full provider catalog, grouped and labelled.
 *   2. Sign in with a subscription where a real OAuth flow exists, otherwise
 *      open the provider's key page and take a pasted key.
 *   3. Persist the credential **through the running service** so it is applied
 *      immediately.
 *   4. Verify the credential against the provider for real.
 *   5. Discover the models that key can actually reach and let the user pick a
 *      default.
 *
 * Step 3 is the important one. Onboarding used to write the secrets file
 * directly from the CLI process and then ask the already-running service to
 * validate the key. The service had loaded its environment at startup and never
 * re-read the file, so it validated a key it did not have: a correct, freshly
 * pasted key was reported as "Validation failed" to a first-time user, who was
 * then offered the choice to discard it. Every credential write now goes
 * through `configureProvider`, which persists *and* hot-applies in the service
 * that will actually perform the request.
 */
import type { ProviderCategory, ProviderStatus } from "@morrow/contracts";
import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { ask, askSecret, confirm, isInteractive, select } from "./common.js";
import { oauthLogin, openBrowser, OAUTH_ELIGIBLE, type OAuthProviderId } from "./provider-oauth.js";

/** Display order and headings for the catalog. */
const CATEGORY_ORDER: ProviderCategory[] = ["assistant", "gateway", "frontier", "inference", "local", "custom", "testing"];

const CATEGORY_LABEL: Record<ProviderCategory, string> = {
  assistant: "Major assistants",
  gateway: "Gateways (one key, many models)",
  frontier: "Model labs",
  inference: "Fast inference hosts",
  local: "Local (nothing leaves your machine)",
  custom: "Custom endpoint",
  testing: "Testing",
};

/** A provider supports subscription sign-in only if the server says it does. */
export function supportsOAuth(status: ProviderStatus): boolean {
  return status.supportsOAuth ?? OAUTH_ELIGIBLE.has(status.id);
}

function categoryOf(status: ProviderStatus): ProviderCategory {
  if (status.category) return status.category;
  // Older servers omit the field; infer something sensible rather than dropping
  // the provider out of the picker entirely.
  if (status.capabilities.local) return "local";
  return "frontier";
}

/** Sort configured providers first, then by catalog order within a category. */
function sortForDisplay(statuses: ProviderStatus[]): ProviderStatus[] {
  return [...statuses].sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(categoryOf(a));
    const cb = CATEGORY_ORDER.indexOf(categoryOf(b));
    if (ca !== cb) return ca - cb;
    if (a.configured !== b.configured) return a.configured ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

/** One line describing a provider's identity and current state. */
export function describeProvider(ctx: Context, status: ProviderStatus): string {
  const mark = status.configured ? ctx.out.green("●") : ctx.out.gray("○");
  const tags: string[] = [];
  if (supportsOAuth(status)) tags.push(ctx.out.cyan("subscription sign-in"));
  if (status.hasFreeTier) tags.push(ctx.out.green("free tier"));
  if (status.capabilities.local) tags.push(ctx.out.gray("local"));
  if (status.configured && status.defaultModel) tags.push(ctx.out.gray(status.defaultModel));
  const suffix = tags.length > 0 ? `  ${ctx.out.gray("[")}${tags.join(ctx.out.gray(", "))}${ctx.out.gray("]")}` : "";
  return `${mark} ${ctx.out.bold(status.label)}${suffix}`;
}

/**
 * Print the catalog grouped by category. This is the "tons of options are
 * actually discoverable" surface — a flat list of 30 ids helps nobody.
 */
export function printCatalog(ctx: Context, statuses: ProviderStatus[]): void {
  const visible = statuses.filter((s) => categoryOf(s) !== "testing");
  for (const category of CATEGORY_ORDER) {
    const group = sortForDisplay(visible.filter((s) => categoryOf(s) === category));
    if (group.length === 0) continue;
    ctx.out.print();
    ctx.out.print(ctx.out.bold(CATEGORY_LABEL[category]));
    for (const status of group) {
      ctx.out.print(`  ${describeProvider(ctx, status)}`);
      if (status.note) ctx.out.print(`      ${ctx.out.gray(status.note)}`);
    }
  }
}

/** Case-insensitive match over id, label, and note. */
export function searchProviders(statuses: ProviderStatus[], query: string): ProviderStatus[] {
  const q = query.trim().toLowerCase();
  if (!q) return statuses;
  return statuses.filter((s) =>
    [s.id, s.label, s.note ?? ""].some((field) => field.toLowerCase().includes(q))
  );
}

/**
 * Let the user choose a provider by typing a name/id fragment or picking from
 * the grouped list. Returns null when the user chooses to stop.
 */
export async function pickProvider(ctx: Context, api: MorrowApi): Promise<ProviderStatus | null> {
  const all = (await api.listProviders()).filter((s) => categoryOf(s) !== "testing");

  while (true) {
    printCatalog(ctx, all);
    ctx.out.print();
    const configured = all.filter((s) => s.configured);
    ctx.out.print(
      configured.length > 0
        ? ctx.out.gray(`${configured.length} of ${all.length} providers configured.`)
        : ctx.out.gray(`${all.length} providers available.`)
    );
    const answer = await ask("Type a provider name to set up (or Enter to continue): ");
    if (!answer) return null;

    const matches = searchProviders(all, answer);
    // An exact id or label match wins outright, so typing "groq" never opens a
    // disambiguation prompt just because another entry mentions Groq.
    const exact = matches.find(
      (s) => s.id.toLowerCase() === answer.toLowerCase() || s.label.toLowerCase() === answer.toLowerCase()
    );
    if (exact) return exact;
    if (matches.length === 0) {
      ctx.out.warn(`No provider matches "${answer}". Try a name from the list above.`);
      continue;
    }
    if (matches.length === 1) return matches[0]!;
    const idx = await select(ctx, `Which one?`, matches, (s) => describeProvider(ctx, s));
    return matches[idx]!;
  }
}

export interface SetupOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /**
   * Whether this flow may prompt the user. Defaults to the terminal's
   * interactivity. Guided setup passes true explicitly.
   */
  interactive?: boolean;
}

export interface SetupResult {
  /** True when the provider ended the flow configured and verified. */
  ok: boolean;
  providerId: string;
  /** Model chosen or discovered, when one was established. */
  model?: string;
  /** Why setup did not complete, for display. */
  detail?: string;
}

/**
 * Run the full guided setup for one provider: authenticate, persist, verify,
 * and pick a model.
 */
export async function setupProvider(
  ctx: Context,
  api: MorrowApi,
  status: ProviderStatus,
  opts: SetupOptions = {}
): Promise<SetupResult> {
  const label = status.label;
  // Whether we may prompt is the caller's call, not something to infer here.
  // `morrow onboard` is a guided flow and always may; `providers configure` is
  // scriptable and must fail with a clear message rather than block on stdin.
  const interactive = opts.interactive ?? isInteractive(ctx);

  // ── 1. Subscription sign-in, when the provider genuinely supports it ──────
  if (supportsOAuth(status) && opts.apiKey === undefined && interactive) {
    const useOAuth = await confirm(
      `Sign in to ${label} with your existing subscription? (No to paste an API key instead.)`,
      true
    );
    if (useOAuth) {
      try {
        await oauthLogin(ctx, api, status.id as OAuthProviderId);
        return await verifyAndChooseModel(ctx, api, status, interactive);
      } catch (e: any) {
        ctx.out.error(`Sign-in failed: ${e.message}`);
        const fallback = await confirm("Set up with an API key instead?", true);
        if (!fallback) return { ok: false, providerId: status.id, detail: e.message };
      }
    }
  }

  // ── 2. Endpoint URL for local servers and custom gateways ────────────────
  const input: { apiKey?: string; baseUrl?: string; model?: string } = {};
  const needsUrl = status.capabilities.local || status.id === "openai-compatible";
  if (needsUrl) {
    let url = opts.baseUrl;
    if (!url && interactive) {
      const suggested = status.endpointHost ? `http://${status.endpointHost}` : "";
      const answer = await ask(`Base URL${suggested ? ` [${suggested}]` : ""}: `);
      url = answer || suggested;
    }
    if (!url) {
      return { ok: false, providerId: status.id, detail: `A base URL is required for ${label}.` };
    }
    input.baseUrl = url;
  }

  // ── 3. API key ────────────────────────────────────────────────────────────
  // Local servers are usually keyless, so the prompt there is explicitly
  // optional rather than a blocker.
  const keyOptional = status.capabilities.local || status.id === "openai-compatible";
  if (opts.apiKey !== undefined) {
    if (opts.apiKey) input.apiKey = opts.apiKey;
  } else if (interactive) {
    if (status.keyUrl) {
      ctx.out.print();
      ctx.out.info(`Get a ${label} API key here: ${ctx.out.cyan(status.keyUrl)}`);
      if (await confirm("Open that page in your browser?", true)) openBrowser(status.keyUrl);
    }
    const key = await askSecret(`${label} API key${keyOptional ? " (optional, blank to skip)" : ""}: `);
    if (key) input.apiKey = key;
    else if (!keyOptional) {
      return { ok: false, providerId: status.id, detail: "No API key provided." };
    }
  } else if (!keyOptional) {
    // Non-interactive and no key supplied: say so instead of blocking on stdin
    // or silently doing nothing.
    return {
      ok: false,
      providerId: status.id,
      detail: `${label} needs an API key. Pass --key, or run this in an interactive terminal.`,
    };
  }

  if (opts.model) input.model = opts.model;

  if (input.apiKey === undefined && input.baseUrl === undefined && input.model === undefined) {
    return { ok: false, providerId: status.id, detail: "Nothing to configure." };
  }

  // ── 4. Persist through the service so it applies immediately ─────────────
  // This is what makes the very next verification step meaningful: the process
  // that performs the request is the one that now holds the credential.
  const saved = await api.configureProvider(status.id, input);
  ctx.out.success(`Saved ${label} credentials — applied immediately, no restart needed.`);
  if (!saved.securePermissions && process.platform !== "win32") {
    ctx.out.warn(`Credentials are stored in plaintext at ${ctx.paths.secretsFile}; it is protected by file permissions where supported.`);
  }
  if (saved.shadowedByEnv?.length > 0) {
    ctx.out.warn(
      `${saved.shadowedByEnv.join(", ")} is also set in your shell and will override the saved value on the next restart. Unset it there to make this permanent.`
    );
  }

  return await verifyAndChooseModel(ctx, api, status, interactive);
}

/**
 * Verify the credential against the provider and settle on a default model.
 *
 * Model choices come from the provider's own `/models` response rather than a
 * hardcoded list, so the offered models are exactly the ones this key can
 * actually reach.
 */
async function verifyAndChooseModel(ctx: Context, api: MorrowApi, status: ProviderStatus, interactive: boolean): Promise<SetupResult> {
  ctx.out.info(`Verifying ${status.label}…`);
  const result = await api.testProvider(status.id);

  if (!result.ok) {
    ctx.out.error(`${status.label} did not verify: ${result.detail}`);
    ctx.out.info(explainFailure(result.errorKind, status));
    const keep = await confirm("Keep these credentials anyway?", false);
    if (!keep) {
      await api.removeProviderCredentials(status.id);
      ctx.out.info(`Removed the ${status.label} credentials.`);
    }
    return { ok: false, providerId: status.id, detail: result.detail };
  }

  const latency = result.latencyMs !== null ? ` (${result.latencyMs} ms)` : "";
  if (result.credentialVerified === false) {
    // Reachable, but this endpoint serves its model list unauthenticated, so
    // the probe proved nothing about the key. Saying "verified" here would tell
    // a user with a bad key that they are ready to go.
    ctx.out.success(`${status.label} reachable${latency}.`);
    ctx.out.info("This endpoint does not require a key to list models, so the key itself could not be checked here — an invalid one would fail on first use.");
  } else {
    ctx.out.success(`${status.label} verified${latency}.`);
  }

  const discovered = result.models.map((m) => m.providerModelId).filter(Boolean);
  if (discovered.length === 0) {
    // Some endpoints do not expose /models. That is not a failure — the
    // connection works — but we cannot offer a list, so say so plainly.
    ctx.out.info(`${status.label} did not publish a model list. Set one later with \`morrow providers configure ${status.id} --model <id>\`.`);
    return { ok: true, providerId: status.id };
  }

  ctx.out.info(`${discovered.length} model${discovered.length === 1 ? "" : "s"} available.`);
  if (!interactive) return { ok: true, providerId: status.id };

  const CHOICE_LIMIT = 25;
  const offered = discovered.slice(0, CHOICE_LIMIT);
  const options = [
    ...offered.map((id) => ({ id, label: id })),
    { id: "", label: discovered.length > CHOICE_LIMIT ? `Type a model id (${discovered.length - CHOICE_LIMIT} more available)…` : "Type a model id…" },
  ];
  const idx = await select(ctx, `Default model for ${status.label}`, options, (o) => o.label);
  let model = options[idx]!.id;
  if (!model) {
    model = await ask("Model id: ");
    if (!model) return { ok: true, providerId: status.id };
  }

  await api.configureProvider(status.id, { model });
  ctx.out.success(`Default model for ${status.label}: ${model}`);
  return { ok: true, providerId: status.id, model };
}

/** Turn a connectivity error class into the next thing the user should do. */
function explainFailure(errorKind: string | null, status: ProviderStatus): string {
  switch (errorKind) {
    case "auth":
      return "The endpoint rejected the credential. Check the key was copied whole, and that it belongs to this provider.";
    case "rate_limit":
      return "The provider rate-limited the check. The credential may still be fine — try again shortly.";
    case "timeout":
      return status.capabilities.local
        ? "No response. Confirm the local server is running and listening on that URL."
        : "No response before the timeout. Check your network or proxy.";
    case "network":
      return status.capabilities.local
        ? "Could not reach the local server. Start it, then run setup again."
        : "Could not reach the endpoint. Check your network, or set a custom base URL if you use a proxy.";
    default:
      return `You can retry with \`morrow providers test ${status.id}\`.`;
  }
}
