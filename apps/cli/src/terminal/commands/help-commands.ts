/**
 * Help and diagnostics.
 *
 * `/shortcuts` is generated from the same table the composer binds against, so
 * a binding cannot exist without being documented or be documented without
 * existing. `/doctor` replaces the old `/versions`, `/bench` and `/bugs`, none
 * of which did anything except suggest running a different command.
 */
import { report } from "../report.js";
import { errorText } from "./format.js";
import { KEY_BINDINGS } from "../ink/keymap.js";
import type { Command } from "./registry.js";

export const shortcutsCommand: Command = {
  name: "shortcuts",
  aliases: ["keys"],
  summary: "keyboard reference",
  category: "help",
  run() {
    const builder = report("Keyboard");
    const groups = new Map<string, Array<{ keys: string; description: string }>>();
    for (const binding of KEY_BINDINGS) {
      const list = groups.get(binding.group) ?? [];
      list.push({ keys: binding.keys, description: binding.description });
      groups.set(binding.group, list);
    }
    for (const [group, bindings] of groups) {
      builder.heading(group);
      builder.table(
        [],
        bindings.map((binding) => [binding.keys, binding.description]),
      );
    }
    return { report: builder.build() };
  },
};

export const capabilitiesCommand: Command = {
  name: "capabilities",
  summary: "what this build can actually do right now",
  category: "help",
  async run(_args, ctx) {
    if (!ctx.backend.getCapabilities) {
      return { notice: { level: "warn", text: "Capability probing is not available from this session." } };
    }
    try {
      const probe = await ctx.backend.getCapabilities();
      const builder = report("Capabilities")
        .subtitle(probe.ready ? "ready for real work" : "not ready")
        .tone(probe.ready ? "success" : "warning");
      for (const group of probe.groups) {
        builder.heading(group.title);
        builder.list(
          group.items.map((item) => ({
            text: item.label,
            marker: item.enabled ? "✓" : "✕",
            tone: item.enabled ? ("success" as const) : ("muted" as const),
            ...(item.note ? { detail: item.note } : {}),
          })),
        );
      }
      builder.hint(probe.nextStep);
      return { report: builder.build() };
    } catch (error) {
      return { notice: { level: "error", text: `Could not probe capabilities: ${errorText(error)}` } };
    }
  },
};

export const doctorCommand: Command = {
  name: "doctor",
  summary: "check the service, the route and the environment",
  category: "help",
  details: "Reports what Morrow can see from inside this session. `morrow doctor` from a shell runs the fuller check.",
  async run(_args, ctx) {
    const health = ctx.backend.health ? await ctx.backend.health().catch((error: unknown) => errorText(error)) : null;
    const providers = ctx.backend.listProviders ? await ctx.backend.listProviders().catch(() => []) : [];
    const configured = providers.filter((provider) => provider.configured);
    const models = ctx.backend.listModels ? await ctx.backend.listModels().catch(() => []) : [];
    const available = models.filter((entry) => entry.available);

    const builder = report("Doctor")
      .heading("Service")
      .fields([
        { label: "Endpoint", value: ctx.session.serviceUrl },
        {
          label: "Reachable",
          value: typeof health === "string" ? `no — ${health}` : health?.ok ? "yes" : "responded but unhealthy",
          tone: typeof health !== "string" && health?.ok ? "success" : "danger",
        },
        { label: "Morrow", value: ctx.session.version },
        { label: "Node", value: process.version },
        { label: "Platform", value: `${process.platform} ${process.arch}` },
      ])
      .heading("Routing")
      .fields([
        {
          label: "Providers",
          value: `${configured.length} configured of ${providers.length}`,
          tone: configured.length > 0 ? "success" : "danger",
        },
        {
          label: "Models",
          value: `${available.length} reachable of ${models.length}`,
          tone: available.length > 0 ? "success" : "warning",
        },
        { label: "Active route", value: `${ctx.settings.provider ?? "auto"} / ${ctx.settings.model ?? "preset default"}` },
      ])
      .heading("Terminal")
      .fields([
        { label: "Columns", value: String(process.stdout.columns ?? "unknown") },
        { label: "Rows", value: String(process.stdout.rows ?? "unknown") },
        { label: "Colour", value: process.env.NO_COLOR ? "disabled (NO_COLOR)" : `${process.stdout.getColorDepth?.() ?? "?"}-bit` },
        { label: "TERM", value: process.env.TERM ?? "(unset)" },
      ]);

    if (configured.length === 0) {
      builder.hint("No provider is configured — run `morrow auth login` to connect one.");
    }
    return { report: builder.build() };
  },
};

export const HELP_COMMANDS: Command[] = [shortcutsCommand, capabilitiesCommand, doctorCommand];
