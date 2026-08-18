/**
 * Model and provider commands.
 *
 * Provider/model configuration is a large part of what Morrow is, so these
 * commands are held to a higher bar than the rest: never ask anyone to memorise
 * an identifier, never accept a route the next request cannot reach, and never
 * report a change that did not happen.
 *
 * The invariant worth stating: applying a model also reconciles reasoning. A
 * route that cannot honour the active thinking setting must not silently keep
 * it — that produces a request the provider rejects, and the rejection reads
 * like a Morrow bug.
 */
import type { RouteReasoningCapability } from "@morrow/contracts";
import { modeLabel, parseModeName } from "../../cli/identity.js";
import { buildModelPickerItems, itemReasoning, formatContextWindow } from "../model-picker.js";
import {
  describeReasoningControl,
  isReasoningCompatible,
  normalizeReasoningForRoute,
  reasoningStatusText,
  UNKNOWN_REASONING,
} from "../reasoning.js";
import { report } from "../report.js";
import { errorText } from "./format.js";
import type { Command, CommandContext, CommandResult } from "./registry.js";

/** `CapabilityMode` widens to `string`; narrow before writing to the wire. */
function isAgentMode(value: string): value is import("../session-types.js").SendOptions["mode"] {
  return value === "agent" || value === "read-only" || value === "plan-only";
}

/**
 * Apply a model to the session, reconciling reasoning with the new route.
 *
 * Returns the notices worth showing. No synthetic `routing` event is emitted:
 * the status line reports the route the orchestrator actually resolved, and
 * asserting one here — before any request has been made — would put a
 * provider/preset/privacy triple on screen that nothing has verified.
 */
function applyModel(
  ctx: CommandContext,
  modelId: string | undefined,
  providerId?: string,
  capability: RouteReasoningCapability = UNKNOWN_REASONING,
): CommandResult {
  const previous = ctx.settings.reasoning;
  ctx.settings.model = modelId;
  if (providerId) ctx.settings.provider = providerId;

  const { config, changed } = normalizeReasoningForRoute(previous, capability);
  ctx.settings.reasoning = config.mode === "auto" ? undefined : config;

  const label = modelId ?? "auto (preset routing)";
  if (changed) {
    return {
      notice: {
        level: "info",
        text: `Model set to ${label}. Reasoning reset to Auto — the new route cannot honour ${reasoningStatusText(previous)}.`,
      },
    };
  }
  return { notice: { level: "info", text: `Model set to ${label}.` } };
}

async function pickerItems(ctx: CommandContext) {
  if (!ctx.backend.listModels) return null;
  const models = await ctx.backend.listModels().catch(() => null);
  if (!models) return null;
  const [budgets, providers] = await Promise.all([
    ctx.backend.getModelBudgets ? ctx.backend.getModelBudgets().catch(() => []) : Promise.resolve([]),
    ctx.backend.listProviders ? ctx.backend.listProviders().catch(() => []) : Promise.resolve([]),
  ]);
  return buildModelPickerItems(models ?? [], budgets ?? [], providers ?? [], ctx.settings.model);
}

export const modelCommand: Command = {
  name: "model",
  summary: "choose the model for this session",
  usage: "[id|auto]",
  category: "model",
  details:
    "With no argument, opens a searchable picker showing each model's provider, context window, reasoning support and whether it is actually reachable. Given an id, switches straight to it.",
  async complete(prefix, ctx) {
    const models = ctx.backend.listModels ? await ctx.backend.listModels().catch(() => []) : [];
    return ["auto", ...models.map((entry) => entry.model.id)].filter((id) => id.startsWith(prefix)).slice(0, 30);
  },
  async run(args, ctx) {
    if (args.sub === "auto") return applyModel(ctx, undefined);

    if (!args.sub) {
      const items = await pickerItems(ctx);
      if (!items) return { notice: { level: "warn", text: "No model registry is available in this session." } };
      ctx.overlays.set({
        kind: "model",
        items,
        currentId: ctx.settings.model,
        onChoose: (item) => {
          if (!item) return;
          if (item.kind === "auto") {
            const result = applyModel(ctx, undefined);
            if (result.notice) ctx.emit({ type: "notice", ...result.notice });
            return;
          }
          if (!item.available) {
            ctx.emit({
              type: "notice",
              level: "warn",
              text: `${item.id} is not available — ${item.status?.availabilityReason ?? `provider "${item.providerId}" is not configured`}`,
            });
            return;
          }
          const result = applyModel(ctx, item.id, item.providerId ?? undefined, item.reasoning);
          if (result.notice) ctx.emit({ type: "notice", ...result.notice });
        },
      });
      return { deferred: true };
    }

    const models = ctx.backend.listModels ? await ctx.backend.listModels().catch(() => null) : null;
    if (!models) {
      // No registry to check against: accept the id as typed rather than block
      // a change. A bad id surfaces honestly on the next request.
      return applyModel(ctx, args.sub);
    }
    const exact = models.find((entry) => entry.model.id === args.sub);
    if (!exact) {
      const near = models
        .filter((entry) => entry.model.id.includes(args.sub))
        .slice(0, 4)
        .map((entry) => entry.model.id);
      return {
        notice: {
          level: "warn",
          text:
            near.length > 0
              ? `No model "${args.sub}". Close matches: ${near.join(", ")}. Run /model to browse.`
              : `No model "${args.sub}" in the registry. Run /model to browse.`,
        },
      };
    }
    if (!exact.available) {
      const reason =
        exact.availabilityReason ??
        (exact.availability === "unknown"
          ? `availability has not been discovered for ${exact.authMode ?? "the active auth surface"}`
          : `provider "${exact.model.providerId}" is not configured`);
      return { notice: { level: "warn", text: `${exact.model.id} is not available — ${reason}` } };
    }
    const budget =
      (ctx.backend.getModelBudgets ? await ctx.backend.getModelBudgets().catch(() => []) : [])?.find(
        (entry) => entry.providerId === exact.model.providerId && entry.selectedModelId === exact.model.id,
      ) ?? null;
    return applyModel(ctx, exact.model.id, exact.model.providerId, itemReasoning(exact, budget));
  },
};

export const providerCommand: Command = {
  name: "provider",
  summary: "show configured providers, or switch to one",
  usage: "[id|auto]",
  category: "model",
  details:
    "Lists every provider Morrow knows about with its authentication state. Switching provider clears any model pinned to the old one.",
  async complete(prefix, ctx) {
    const providers = ctx.backend.listProviders ? await ctx.backend.listProviders().catch(() => []) : [];
    return ["auto", ...providers.map((entry) => entry.id)].filter((id) => id.startsWith(prefix));
  },
  async run(args, ctx) {
    const providers = ctx.backend.listProviders ? await ctx.backend.listProviders().catch(() => null) : null;

    if (args.sub === "auto") {
      ctx.settings.provider = undefined;
      ctx.settings.model = undefined;
      return { notice: { level: "info", text: "Provider set to auto — the preset chooses the route." } };
    }

    const apply = (id: string): CommandResult => {
      const known = providers?.find((entry) => entry.id === id);
      if (providers && !known) {
        return {
          notice: {
            level: "warn",
            text: `No provider "${id}". Run /provider to see what is configured.`,
          },
        };
      }
      if (known && !known.configured) {
        return {
          notice: {
            level: "warn",
            text: `${known.label ?? id} has no credentials. Run \`morrow auth login ${id}\` to connect it.`,
          },
        };
      }
      // A model pinned to the previous provider cannot be honoured by a new
      // one, and keeping it produces a request that fails on the far side.
      ctx.settings.provider = id;
      ctx.settings.model = undefined;
      return { notice: { level: "info", text: `Provider set to ${id}. Model reset to the provider default.` } };
    };

    if (args.sub) return apply(args.sub);

    if (!providers) return { notice: { level: "warn", text: "The provider registry is not available in this session." } };
    if (providers.length === 0) {
      return {
        notice: { level: "warn", text: "No providers are known to this build. Run `morrow auth login` to connect one." },
      };
    }

    ctx.overlays.set({
      kind: "select",
      title: "Provider",
      subtitle: "the model provider requests are routed to",
      items: [
        {
          id: "auto",
          label: "auto",
          hint: "let the preset choose",
          current: ctx.settings.provider === undefined,
        },
        ...providers.map((entry) => ({
          id: entry.id,
          label: entry.label ?? entry.id,
          hint: entry.configured ? (entry.defaultModel ?? "configured") : "no credentials",
          current: entry.id === ctx.settings.provider,
          disabled: !entry.configured,
        })),
      ],
      onChoose: (id) => {
        if (!id) return;
        const result = id === "auto" ? { notice: { level: "info" as const, text: "Provider set to auto." } } : apply(id);
        if (id === "auto") {
          ctx.settings.provider = undefined;
          ctx.settings.model = undefined;
        }
        if (result.notice) ctx.emit({ type: "notice", ...result.notice });
      },
    });
    return { deferred: true };
  },
};

export const presetCommand: Command = {
  name: "preset",
  summary: "choose the routing preset",
  usage: "[id]",
  category: "model",
  details: "A preset decides which provider and model a request goes to when neither is pinned explicitly.",
  async complete(prefix, ctx) {
    const presets = ctx.backend.listPresets ? await ctx.backend.listPresets().catch(() => []) : [];
    return presets.map((entry) => entry.preset.id).filter((id) => id.startsWith(prefix));
  },
  async run(args, ctx) {
    const presets = ctx.backend.listPresets ? await ctx.backend.listPresets().catch(() => null) : null;
    if (args.sub) {
      if (presets && !presets.some((entry) => entry.preset.id === args.sub)) {
        return {
          notice: {
            level: "warn",
            text: `No preset "${args.sub}". Available: ${presets.map((entry) => entry.preset.id).join(", ")}`,
          },
        };
      }
      ctx.settings.preset = args.sub;
      return { notice: { level: "info", text: `Preset set to ${args.sub}.` } };
    }
    if (!presets || presets.length === 0) {
      return { notice: { level: "info", text: `Preset: ${ctx.settings.preset}` } };
    }
    ctx.overlays.set({
      kind: "select",
      title: "Routing preset",
      items: presets.map((entry) => ({
        id: entry.preset.id,
        label: entry.preset.id,
        hint: entry.available
          ? (entry.resolved ? `${entry.resolved.providerId}/${entry.resolved.model}` : "available")
          : (entry.unavailableReason ?? "unavailable"),
        current: entry.preset.id === ctx.settings.preset,
        disabled: !entry.available,
      })),
      onChoose: (id) => {
        if (!id) return;
        ctx.settings.preset = id;
        ctx.emit({ type: "notice", level: "info", text: `Preset set to ${id}.` });
      },
    });
    return { deferred: true };
  },
};

export const reasoningCommand: Command = {
  name: "reasoning",
  summary: "set how much the model thinks before answering",
  usage: "[auto|off|low|medium|high|<tokens>]",
  category: "model",
  subcommands: ["auto", "off", "low", "medium", "high"],
  details:
    "Providers expose thinking differently — some as an effort level, some as a token budget, some not at all. Morrow normalises the request and refuses a setting the active route cannot honour rather than sending one that will be rejected.",
  complete: (prefix) => ["auto", "off", "low", "medium", "high"].filter((value) => value.startsWith(prefix)),
  async run(args, ctx) {
    const capability = await routeCapability(ctx);

    if (!args.sub) {
      return {
        report: report("Reasoning")
          .fields([
            { label: "Setting", value: reasoningStatusText(ctx.settings.reasoning) },
            { label: "Route accepts", value: describeReasoningControl(capability) },
          ])
          .hint("/reasoning auto|off|low|medium|high|<tokens>")
          .build(),
      };
    }

    const requested = parseReasoning(args.sub);
    if (!requested) {
      return { notice: { level: "warn", text: "Usage: /reasoning [auto|off|low|medium|high|<tokens>]" } };
    }
    // Only refuse when the route's capability was actually discovered.
    // `UNKNOWN_REASONING` reads as "accepts nothing", but it means "not probed"
    // — and refusing on that would block the setting on every route Morrow has
    // not yet interrogated, which is most of them before the first request.
    const known = capability.source !== "unknown";
    if (known && requested.mode !== "auto" && !isReasoningCompatible(requested, capability)) {
      return {
        notice: {
          level: "warn",
          text: `The active route cannot honour that — it accepts ${describeReasoningControl(capability)}.`,
        },
      };
    }
    ctx.settings.reasoning = requested.mode === "auto" ? undefined : requested;
    return { notice: { level: "info", text: `Reasoning: ${reasoningStatusText(ctx.settings.reasoning)}` } };
  },
};

async function routeCapability(ctx: CommandContext): Promise<RouteReasoningCapability> {
  if (!ctx.settings.model || !ctx.backend.listModels) return UNKNOWN_REASONING;
  const models = await ctx.backend.listModels().catch(() => null);
  const match = models?.find((entry) => entry.model.id === ctx.settings.model);
  if (!match) return UNKNOWN_REASONING;
  const budgets = ctx.backend.getModelBudgets ? await ctx.backend.getModelBudgets().catch(() => []) : [];
  const budget =
    budgets?.find((entry) => entry.providerId === match.model.providerId && entry.selectedModelId === match.model.id) ??
    null;
  return itemReasoning(match, budget);
}

function parseReasoning(value: string): import("@morrow/contracts").ReasoningConfiguration | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "auto") return { mode: "auto" };
  if (normalized === "off" || normalized === "none") return { mode: "off" };
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return { mode: "effort", effort: normalized };
  }
  const tokens = Number.parseInt(normalized.replace(/[_,]/g, "").replace(/k$/, "000"), 10);
  if (Number.isFinite(tokens) && tokens > 0) return { mode: "budget", tokens };
  return null;
}

export const modeCommand: Command = {
  name: "mode",
  summary: "switch between ask, plan and build",
  usage: "[ask|plan|build]",
  category: "model",
  subcommands: ["ask", "plan", "build"],
  details:
    "Ask is read-only. Plan proposes without changing anything. Build edits the workspace, gated by approvals unless YOLO is on.",
  complete: (prefix) => ["ask", "plan", "build"].filter((value) => value.startsWith(prefix)),
  run(args, ctx) {
    if (!args.sub) {
      return {
        notice: {
          level: "info",
          text: `Mode: ${modeLabel(ctx.settings.mode, ctx.settings.autoApprove)}  ·  switch with /mode ask|plan|build`,
        },
      };
    }
    const parsed = parseModeName(args.sub);
    if (parsed === null || parsed === "mission") {
      return { notice: { level: "warn", text: "Usage: /mode [ask|plan|build]" } };
    }
    if (!isAgentMode(parsed)) return { notice: { level: "warn", text: "Usage: /mode [ask|plan|build]" } };
    ctx.settings.mode = parsed;
    // Leaving Build must drop auto-approval with it: YOLO is meaningless in a
    // read-only mode and leaving it set would silently re-arm on the way back.
    if (parsed !== "agent") ctx.settings.autoApprove = false;
    return { notice: { level: "info", text: `Mode: ${modeLabel(ctx.settings.mode, ctx.settings.autoApprove)}` } };
  },
};

export { formatContextWindow };

export const ROUTING_COMMANDS: Command[] = [
  modelCommand,
  providerCommand,
  presetCommand,
  reasoningCommand,
  modeCommand,
];
