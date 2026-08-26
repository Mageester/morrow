import type { ProviderId, ReasoningConfiguration, RouteReasoningCapability } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { taskCapabilityQueries, type ContextSnapshot, type ReasoningApplication, type RoutingSnapshot } from "../../api/task-capability.js";
import type { ChatComposerModelRoute } from "./chat-composer.js";
import { useAnchoredPanel } from "./use-anchored-panel.js";
import { formatTokens, UsageRing, usageTone } from "./context-meter.js";
import { providerName } from "./model-picker.js";

/** "provider-metadata" -> "Provider metadata"; "unverified" -> "Unverified". */
function humanize(value: string | null | undefined): string | null {
  if (!value) return null;
  const words = value.replaceAll(/[-_]/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : null;
}

function humanizeReasoningConfig(config: unknown): string {
  if (!config || typeof config !== "object") return "Auto";
  const c = config as { mode?: unknown; effort?: unknown; tokens?: unknown };
  switch (c.mode) {
    case "auto":
      return "Auto";
    case "off":
      return "Off";
    case "provider-fixed":
      return "Fixed by provider";
    case "effort":
      return typeof c.effort === "string" ? `Effort: ${c.effort}` : "Effort";
    case "budget":
      return typeof c.tokens === "number" ? `Budget: ${c.tokens.toLocaleString("en-US")} tokens` : "Budget";
    default:
      return "Auto";
  }
}

/** Flattens one level of nesting into dotted "key.sub: value" lines — enough
 * to render any of the four wire dialects (a scalar field, or one nested
 * object) without a generic JSON dump. */
function wireParamLines(params: Record<string, unknown> | null | undefined): string[] {
  if (!params) return [];
  const lines: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const [subKey, subValue] of Object.entries(value as Record<string, unknown>)) {
        lines.push(`${key}.${subKey}: ${String(subValue)}`);
      }
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }
  return lines;
}

/** Confidence badge tone. Mirrors ModelBudget.contextWindowConfidence:
 * "verified" is the only fully-earned state; everything else says so. */
function confidenceTone(confidence: string | null | undefined): "verified" | "partial" | "unverified" {
  if (confidence === "verified") return "verified";
  if (confidence === "reported" || confidence === "configured") return "partial";
  return "unverified";
}

function StatRow({ label, value, source }: { label: string; value: string | null; source?: string | null | undefined }) {
  if (value === null) return null;
  return (
    <div className="morrow-capability-status__row">
      <dt>{label}</dt>
      <dd>
        {value}
        {source ? <span className="morrow-capability-status__source"> · {humanize(source)}</span> : null}
      </dd>
    </div>
  );
}

export interface CapabilityStatusProps {
  /** The most recent task in this conversation — the source of the live,
   * actually-served snapshot. Undefined before the first turn. */
  taskId?: string | undefined;
  /** The route currently configured in the composer, for the "will use" half
   * of the panel — this can differ from the live snapshot once the user
   * changes the model picker after a turn already ran. */
  route?: ChatComposerModelRoute | undefined;
  reasoningConfig?: ReasoningConfiguration | undefined;
  disabled?: boolean | undefined;
}

/**
 * Compact status control near the composer: what Morrow is actually using,
 * and how it got there. Everything shown is a read-only view of a single
 * orchestrator computation — nothing here recomputes a token limit or a
 * provider's wire dialect; see api/task-capability.ts.
 */
export function CapabilityStatus({ taskId, route, reasoningConfig, disabled = false }: CapabilityStatusProps) {
  const id = useId();
  const panelId = `morrow-capability-status-${id}`;
  const panel = useAnchoredPanel<HTMLButtonElement>();
  const open = panel.open;

  const capability = useQuery({ ...taskCapabilityQueries.forTask(taskId ?? ""), enabled: Boolean(taskId) });
  const context: ContextSnapshot | null = capability.data?.context ?? null;
  const routing: RoutingSnapshot | null = capability.data?.routing ?? null;
  const reasoningApplication: ReasoningApplication | null = capability.data?.reasoningApplication ?? null;

  // The route actually served last turn, when known; otherwise the route the
  // composer currently has selected. These can differ — shown as two
  // distinct, clearly labelled facts below rather than merged into one.
  const liveProvider = routing?.providerId ?? null;
  const liveModel = routing?.model ?? null;
  const configuredProvider = route?.providerId ?? null;
  const configuredModel = route?.model ?? null;
  const routeChangedSinceLastTurn = Boolean(
    liveProvider && configuredProvider && (liveProvider !== configuredProvider || liveModel !== configuredModel),
  );

  const displayProvider = liveProvider ?? configuredProvider;
  const displayModel = liveModel ?? configuredModel ?? route?.label ?? null;
  if (!taskId && !configuredProvider) return null; // Nothing concrete to report yet.

  const capacity = context?.contextWindowTokens ?? null;
  const used = context?.currentModelVisibleTokens ?? context?.currentRequestTokens ?? null;
  const hasRing = Boolean(capacity && capacity > 0 && used != null && used >= 0);
  const ratio = hasRing ? Math.min(used! / capacity!, 1) : 0;
  const estimated = context?.exact === false;
  const confidence = context?.contextWindowConfidence ?? null;

  // Still resolving this taskId's snapshot — distinct from "resolved, and
  // there genuinely is nothing" below. A query that first fetched while the
  // task was still queued/streaming used to look identical to one that never
  // fetched anything at all; both rendered "No request yet" even minutes
  // after a real, completed response. Now: loading, no-request-ever, and
  // request-happened-but-telemetry-missing are three different facts and
  // three different sentences.
  const capabilityLoading = Boolean(taskId) && capability.isPending;
  // Any of these being non-null means the orchestrator recorded SOMETHING
  // for this task — a routing decision, a reasoning application, or a
  // context budget calculation — so "no request yet" would be false.
  const requestEverMade = routing !== null || reasoningApplication !== null || context !== null;
  // "Not separately capped" is a positive backend fact (routeLimitSource
  // names where that absence was established), not the default reading of
  // a missing number — a genuinely unknown route reports the same null
  // routeLimitTokens as one Morrow has verified imposes no separate cap.
  const routeCapKnown = Boolean(context?.routeLimitSource) && context?.routeLimitSource !== "unknown";

  const reasoningCapability: RouteReasoningCapability | undefined = route?.reasoning;
  const activeReasoningLabel = humanizeReasoningConfig(reasoningConfig ?? { mode: "auto" });
  const appliedReasoningLabel = reasoningApplication ? humanizeReasoningConfig(reasoningApplication.applied) : null;
  const wireLines = wireParamLines(reasoningApplication?.wireParams);
  const reasoningSupported = reasoningApplication?.supported ?? null;
  const fallbackUsed = routing?.fallbackUsed === true || reasoningApplication?.fallbackToRouteDefault === true;

  const triggerLabel = displayProvider
    ? `${providerName(displayProvider as ProviderId)} · ${displayModel ?? "model"}`
    : route?.label ?? "Auto";

  return (
    <div className="morrow-capability-status">
      <button
        // The visible label is the route, which is worth announcing — it is
        // how someone knows which model they are on. On its own, though, it is
        // an unexplained "Auto" or "Gemini · pro" with no hint that it opens
        // anything, and `title` is not a dependable substitute because it is
        // announced inconsistently and never on touch. Name the control and
        // keep its value.
        aria-label={`Capability and context status — ${triggerLabel}`}
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="morrow-capability-status__trigger"
        disabled={disabled}
        onClick={panel.toggle}
        ref={panel.anchorRef}
        title="Capability & context status"
        type="button"
      >
        {hasRing ? (
          <span
            className="morrow-context-meter"
            data-estimated={estimated ? "true" : undefined}
            data-tone={usageTone(ratio)}
          >
            <UsageRing ratio={ratio} />
          </span>
        ) : (
          <Info aria-hidden="true" size={14} />
        )}
        <span className="morrow-capability-status__label">{triggerLabel}</span>
        {fallbackUsed ? <span className="morrow-capability-status__flag" data-tone="warning">Fallback</span> : null}
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div aria-label="Capability and context status" className="morrow-capability-status__panel" id={panelId} ref={panel.panelRef} role="dialog" style={panel.style}>
          <header className="morrow-capability-status__header">
            <p>What Morrow is doing</p>
            {confidence ? (
              <span className="morrow-capability-status__badge" data-tone={confidenceTone(confidence)}>
                {humanize(confidence)}
              </span>
            ) : null}
          </header>

          <section aria-label="Route">
            <h3>Route</h3>
            <dl className="morrow-capability-status__list">
              <StatRow label="Provider" value={displayProvider ? providerName(displayProvider as ProviderId) : "Not yet decided"} />
              <StatRow label="Model" value={displayModel ?? "Not yet decided"} />
              {routeChangedSinceLastTurn ? (
                <p className="morrow-capability-status__note">
                  The next message will use {providerName(configuredProvider as ProviderId)} / {configuredModel}; the numbers below are from the last turn on {providerName(liveProvider as ProviderId)} / {liveModel}.
                </p>
              ) : null}
              {fallbackUsed ? (
                <p className="morrow-capability-status__note" data-tone="warning">
                  Morrow fell back to a different route or setting than requested for this turn.
                </p>
              ) : null}
            </dl>
          </section>

          <section aria-label="Reasoning">
            <h3>Reasoning</h3>
            <dl className="morrow-capability-status__list">
              <StatRow label="Configured" value={activeReasoningLabel} />
              {!reasoningCapability && !reasoningApplication ? (
                <p className="morrow-capability-status__note">Select a model to see its reasoning controls.</p>
              ) : null}
            </dl>
            {appliedReasoningLabel || reasoningSupported !== null || wireLines.length > 0 || reasoningApplication ? (
              <details className="morrow-capability-status__details">
                <summary>More detail</summary>
                <dl className="morrow-capability-status__list">
                  {appliedReasoningLabel ? <StatRow label="Sent last turn" value={appliedReasoningLabel} /> : null}
                  {reasoningSupported !== null ? (
                    <StatRow label="Supported" value={reasoningSupported ? "Yes" : `No — ${reasoningApplication?.unsupportedReason ?? "fell back to route default"}`} />
                  ) : null}
                  {wireLines.length > 0 ? (
                    <div className="morrow-capability-status__row">
                      <dt>Applied on the wire</dt>
                      <dd>
                        <code className="morrow-capability-status__wire">{wireLines.join("\n")}</code>
                      </dd>
                    </div>
                  ) : reasoningApplication ? (
                    <StatRow label="Applied on the wire" value="No explicit reasoning parameter sent" />
                  ) : null}
                  <StatRow
                    label="Capability source"
                    value={humanize(reasoningApplication?.source ?? reasoningCapability?.source ?? null)}
                  />
                </dl>
              </details>
            ) : null}
          </section>

          <section aria-label="Context">
            <h3>Context</h3>
            <dl className="morrow-capability-status__list">
              <StatRow
                label="Used"
                value={
                  capabilityLoading
                    ? "Loading…"
                    : used != null
                      ? `${formatTokens(used)} tokens${estimated ? " (estimated)" : ""}`
                      : requestEverMade
                        // A request really was made (we have a routing decision
                        // and/or a reasoning record for this task) but no usage
                        // telemetry landed — a stale cache used to render this
                        // identically to "never asked", which is a false claim
                        // the moment a request has actually completed.
                        ? "Runtime usage unavailable"
                        : "No request yet"
                }
              />
            </dl>
            <details className="morrow-capability-status__details">
              <summary>More detail</summary>
              <dl className="morrow-capability-status__list">
                <StatRow
                  label="Usable input budget"
                  value={context?.maxInputTokens != null ? formatTokens(context.maxInputTokens) : null}
                />
                <StatRow
                  label="Native model window"
                  value={context?.nativeContextWindowTokens != null ? formatTokens(context.nativeContextWindowTokens) : null}
                  source={context?.nativeContextWindowSource}
                />
                <StatRow
                  label="Provider / route cap"
                  value={
                    capabilityLoading
                      ? "Loading…"
                      : context?.routeLimitTokens != null
                        ? formatTokens(context.routeLimitTokens)
                        // "Not separately capped" is itself a claim the backend
                        // must have earned: routeLimitSource says where that
                        // absence was established (provider metadata, the
                        // endpoint's own config, …). A source of "unknown" — or
                        // no context record at all — means Morrow never actually
                        // checked, and the honest answer is "Unknown", not a
                        // confident negative.
                        : routeCapKnown
                          ? "Not separately capped"
                          : "Unknown"
                  }
                  source={context?.routeLimitTokens != null ? context?.routeLimitSource : routeCapKnown ? context?.routeLimitSource : null}
                />
                <StatRow
                  label="Effective context window"
                  value={context?.effectiveContextWindowTokens != null ? formatTokens(context.effectiveContextWindowTokens) : (capacity != null ? formatTokens(capacity) : null)}
                  source={context?.contextWindowSource}
                />
                <StatRow
                  label="Reserved (output + system/tool)"
                  value={context?.totalReserveTokens != null
                    ? `${formatTokens(context.totalReserveTokens)}${context?.harnessReserveTokens != null ? ` (${formatTokens(context.harnessReserveTokens)} system/tool)` : ""}`
                    : null}
                />
                <StatRow
                  label="Compaction threshold"
                  value={context?.compactionThresholdTokens != null
                    ? `${formatTokens(context.compactionThresholdTokens)}${context?.compactionThresholdRatio != null ? ` (${Math.round(context.compactionThresholdRatio * 100)}%)` : ""}`
                    : null}
                />
                <StatRow label="Token count" value={context?.countingMethod ? humanize(context.countingMethod) : null} />
              </dl>
            </details>
          </section>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
