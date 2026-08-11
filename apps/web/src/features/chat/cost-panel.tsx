import type { CostAccuracy, TaskCostSummary } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import { taskCostQueries, formatUsdMicros } from "../../api/task-cost.js";

function accuracyLabel(accuracy: CostAccuracy): string {
  switch (accuracy) {
    case "exact_usage_pricing": return "Exact usage";
    case "provider_billed": return "Provider billed";
    case "estimated": return "Estimated";
    case "unknown": return "Unknown";
  }
}

function basisLabel(accuracy: CostAccuracy): string {
  switch (accuracy) {
    case "exact_usage_pricing": return "Exact provider-reported usage × authoritative pricing";
    case "provider_billed": return "Provider-billed amount";
    case "estimated": return "Estimated usage or pricing";
    case "unknown": return "Cost basis unavailable";
  }
}

function costDisclosure(summary: TaskCostSummary | undefined, totalLabel: string): string {
  if (!summary?.total) return "Cost unavailable";
  if (summary.accuracy === "exact_usage_pricing") {
    return `Exact usage cost: ${totalLabel} USD; provider invoice amount not available`;
  }
  if (summary.accuracy === "provider_billed") return `Provider-billed cost: ${totalLabel} USD`;
  return `${accuracyLabel(summary.accuracy)} cost: ${totalLabel} USD; provider invoice amount not available`;
}

function formatTokens(tokens: number): string {
  return `${tokens.toLocaleString("en-US")} tokens`;
}

function providerModels(summary: TaskCostSummary): string[] {
  return [...new Set(summary.lines.map((line) => `${line.providerId} / ${line.modelId}`))];
}

export interface CostPanelProps {
  taskId: string;
  compact?: boolean;
}

export function CostPanel({ taskId, compact = false }: CostPanelProps) {
  const query = useQuery({ ...taskCostQueries.forTask(taskId), enabled: Boolean(taskId) });
  const summary = query.data;
  const calculating = query.isFetching;
  const totalLabel = formatUsdMicros(summary?.total);
  const accuracy = summary?.accuracy ?? "unknown";
  const models = summary ? providerModels(summary) : [];
  const modelLabel = models[0] ?? "Unknown provider/model";
  const disclosure = costDisclosure(summary, totalLabel);

  return (
    <section aria-label="Task cost" className="morrow-cost-panel">
      <div className="morrow-cost-panel__header">
        <div>
          <p className="morrow-cost-panel__eyebrow">Task cost</p>
          <p className="morrow-cost-panel__total" aria-label={disclosure}>{totalLabel}</p>
        </div>
        <span className={`morrow-cost-panel__accuracy morrow-cost-panel__accuracy--${accuracy}`}>
          {accuracyLabel(accuracy)}
        </span>
      </div>

      <p className="morrow-cost-panel__basis">Basis: {basisLabel(summary?.accuracy ?? "unknown")}</p>
      <p className="morrow-cost-panel__disclosure">{disclosure}</p>

      {calculating ? <p aria-live="polite" className="morrow-cost-panel__calculating">Calculating…</p> : null}

      <div className="morrow-cost-panel__meta">
        <span>{modelLabel}</span>
        <span>Provider requests: {summary?.requestCount ?? 0}</span>
      </div>

      {!compact && summary ? (
        <>
          <div className="morrow-cost-panel__details">
            <p>Basis: {basisLabel(summary.accuracy)}</p>
            <p>Input: {formatTokens(summary.totalInputTokens)}</p>
            <p>Cached input: {formatTokens(summary.knownCachedInputTokens)}</p>
            <p>Output: {formatTokens(summary.outputTokens)}</p>
            <p>Provider requests: {summary.requestCount}</p>
          </div>

          {summary.lines.length > 0 ? (
            <details className="morrow-cost-panel__lines">
              <summary>Show provider requests</summary>
              <ul>
                {summary.lines.map((line) => (
                  <li key={line.id}>
                    <span>{line.providerId} / {line.modelId}</span>
                    <span>{formatUsdMicros(line.amount, 6)}</span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
