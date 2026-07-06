/**
 * `morrow capabilities` (and `/capabilities`) — an honest, live summary of what
 * THIS installed build can actually do right now.
 *
 * The report is derived from real probes (is the service reachable, is a model
 * connected, how many tools/skills are present), never from static marketing
 * copy. A capability that ships in the code but is not usable yet — because the
 * service is stopped or no provider is connected — is shown as unavailable with
 * the exact next step, so the output can never over-promise.
 */
import type { Context } from "../cli/context.js";
import type { MorrowApi } from "../client/api.js";
import { EXIT } from "../cli/errors.js";
import { localSkillsIndex } from "./skills.js";

export interface CapabilityItem {
  label: string;
  enabled: boolean;
  /** Shown when disabled: why, and what unlocks it. */
  note?: string;
}

export interface CapabilityGroup {
  title: string;
  items: CapabilityItem[];
}

export interface CapabilityProbe {
  serviceUp: boolean;
  providerConfigured: boolean;
  toolCount: number;
  skillCount: number;
}

export interface CapabilityReport {
  groups: CapabilityGroup[];
  /** True only when the agent can actually do real work end to end. */
  ready: boolean;
  /** The single most useful next action (a real command, or a "Try:" prompt). */
  nextStep: string;
}

/**
 * Turn a set of live probes into the grouped capability report. Pure and
 * fully testable. Gating is honest: model-dependent capabilities require a
 * connected provider; repository capabilities require the service + tools.
 */
export function buildCapabilities(p: CapabilityProbe): CapabilityReport {
  const repo = p.serviceUp && p.toolCount > 0;
  const model = p.serviceUp && p.providerConfigured;
  const needModel = "connect a model: morrow auth login";
  const needService = "start Morrow: morrow start";
  const gate = (enabled: boolean, dependsOnModel: boolean): CapabilityItem["note"] =>
    enabled ? undefined : !p.serviceUp ? needService : dependsOnModel ? needModel : needService;

  const item = (label: string, enabled: boolean, dependsOnModel: boolean): CapabilityItem => {
    const note = gate(enabled, dependsOnModel);
    return note ? { label, enabled, note } : { label, enabled };
  };

  const groups: CapabilityGroup[] = [
    {
      title: "Repository",
      items: [
        item("Read, search, and modify files", repo, false),
        item("Run commands, tests, and builds", repo, false),
        item("Inspect Git changes", p.serviceUp, false),
      ],
    },
    {
      title: "Autonomous work",
      items: [
        item("Planning and implementation", model, true),
        item("Specialist agents", model, true),
        item("Failure recovery", model, true),
        item("Restart persistence", p.serviceUp, false),
      ],
    },
    {
      title: "Verification",
      items: [
        item("Success criteria", model, true),
        item("Evidence ledger", p.serviceUp, false),
        item("Independent review", model, true),
        item("Honest result grading", model, true),
      ],
    },
    {
      title: "Project intelligence (Cortex)",
      items: [
        item("Architecture map", p.serviceUp, false),
        item("Rules and conventions", p.serviceUp, false),
        item("Decisions and risks", p.serviceUp, false),
        item("Mission learnings", model, true),
        item("Stale-memory detection", p.serviceUp, false),
      ],
    },
    {
      title: "Skills",
      items: [item(`${p.skillCount} agent skill${p.skillCount === 1 ? "" : "s"} available`, p.skillCount > 0, false)],
    },
  ];

  const ready = repo && model;
  const nextStep = !p.serviceUp
    ? "Start the local service:  morrow start"
    : !p.providerConfigured
      ? "Connect a model to unlock autonomous work:  morrow auth login"
      : "Fix the failing tests and prove the result.";

  return { groups, ready, nextStep };
}

/**
 * Gather live probes from an already-running API client without starting the
 * service or calling a provider. Every probe is best-effort: any failure leaves
 * the conservative default so the report can only ever under-promise.
 */
export async function probeCapabilitiesWith(api: MorrowApi): Promise<CapabilityProbe> {
  let serviceUp = false;
  let providerConfigured = false;
  let toolCount = 0;
  try {
    const health = await api.health();
    serviceUp = health.ok;
  } catch {
    serviceUp = false;
  }
  if (serviceUp) {
    try {
      const providers = await api.listProviders();
      providerConfigured = providers.some((provider) => provider.configured);
    } catch {
      /* leave false */
    }
    try {
      const tools = await api.listTools();
      toolCount = tools.length;
    } catch {
      /* leave 0 */
    }
  }
  let skillCount = 0;
  try {
    skillCount = localSkillsIndex().length;
  } catch {
    /* leave 0 */
  }
  return { serviceUp, providerConfigured, toolCount, skillCount };
}

/** Convenience: build a full report from a live API client. */
export async function reportCapabilities(api: MorrowApi): Promise<CapabilityReport> {
  return buildCapabilities(await probeCapabilitiesWith(api));
}

/** Gather live probes without starting the service or calling a provider. */
export async function probeCapabilities(ctx: Context): Promise<CapabilityProbe> {
  return probeCapabilitiesWith(ctx.api());
}

/** Render the report to lines (shared by the command and the in-session view). */
export function capabilityLines(report: CapabilityReport, out: Context["out"], unicode: boolean): string[] {
  const ok = unicode ? "✓" : "+";
  const off = unicode ? "○" : "-";
  const lines: string[] = [out.bold("MORROW CAPABILITIES"), ""];
  for (const group of report.groups) {
    lines.push(out.bold(group.title));
    for (const it of group.items) {
      const mark = it.enabled ? out.green(ok) : out.gray(off);
      const label = it.enabled ? it.label : out.gray(it.label);
      const note = it.note ? out.gray(`  — ${it.note}`) : "";
      lines.push(`${mark} ${label}${note}`);
    }
    lines.push("");
  }
  lines.push(out.bold("Try:"));
  lines.push(`  ${report.nextStep}`);
  return lines;
}

/** `morrow capabilities` — never starts the service or calls a provider. */
export async function capabilitiesCommand(ctx: Context): Promise<number> {
  const probe = await probeCapabilities(ctx);
  const report = buildCapabilities(probe);
  if (ctx.out.json) {
    ctx.out.data(report);
    return EXIT.OK;
  }
  const unicode = ctx.config.get("ui.unicode") !== false && process.env.MORROW_ASCII !== "1";
  for (const line of capabilityLines(report, ctx.out, unicode)) ctx.out.print(line);
  return EXIT.OK;
}
