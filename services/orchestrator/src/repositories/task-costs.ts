import type Database from "better-sqlite3";
import {
  CostLineSchema,
  TaskCostSummarySchema,
  type CostLine,
  type CostAccuracy,
  type TaskCostSummary,
} from "@morrow/contracts";

type CostLineRow = {
  id: string;
  task_id: string;
  request_id: string;
  provider_id: string;
  model_id: string;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  amount_micros_usd: number | null;
  accuracy: CostAccuracy;
  pricing_snapshot_json: string | null;
  created_at: string;
};

function parsePricingSnapshot(value: string | null): unknown {
  if (value === null) return null;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("Malformed persisted pricing snapshot");
  }
}

function mapCostLine(row: CostLineRow): CostLine {
  return CostLineSchema.parse({
    id: row.id,
    taskId: row.task_id,
    requestId: row.request_id,
    providerId: row.provider_id,
    modelId: row.model_id,
    inputTokens: row.input_tokens,
    cachedInputTokens: row.cached_input_tokens,
    outputTokens: row.output_tokens,
    amount: row.amount_micros_usd === null
      ? null
      : { currency: "USD", micros: row.amount_micros_usd },
    accuracy: row.accuracy,
    pricing: parsePricingSnapshot(row.pricing_snapshot_json),
    recordedAt: row.created_at,
  });
}

function sumSafe(values: number[], label: string): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} exceeds a safe integer`);
  return Number(total);
}

function summaryAccuracy(lines: CostLine[]): CostAccuracy {
  if (lines.some((line) => line.amount === null || line.accuracy === "unknown")) return "unknown";
  if (lines.some((line) => line.accuracy === "estimated")) return "estimated";
  if (lines.some((line) => line.accuracy === "provider_billed")) return "provider_billed";
  return "exact_usage_pricing";
}

export function taskCostsRepository(db: Database.Database) {
  const getByRequest = (taskId: string, requestId: string): CostLine | undefined => {
    const row = db.prepare("SELECT * FROM task_cost_lines WHERE task_id=? AND request_id=?").get(taskId, requestId) as CostLineRow | undefined;
    return row ? mapCostLine(row) : undefined;
  };

  const getById = (id: string): CostLine | undefined => {
    const row = db.prepare("SELECT * FROM task_cost_lines WHERE id=?").get(id) as CostLineRow | undefined;
    return row ? mapCostLine(row) : undefined;
  };

  const listByTask = (taskId: string): CostLine[] => (db
    .prepare("SELECT * FROM task_cost_lines WHERE task_id=? ORDER BY created_at ASC,id ASC")
    .all(taskId) as CostLineRow[])
    .map(mapCostLine);

  const summaryByTask = (taskId: string): TaskCostSummary => {
    const lines = listByTask(taskId);
    const disclosure = db.prepare("SELECT execution_mode,model_invocation FROM execution_disclosures WHERE task_id=?").get(taskId) as
      | { execution_mode: string; model_invocation: number }
      | undefined;
    const deterministicLocal = disclosure?.execution_mode === "deterministic-local" && Number(disclosure.model_invocation) === 0;
    const knownLines = lines.filter((line) => line.amount !== null && line.accuracy !== "unknown");
    const allLinesKnown = knownLines.length === lines.length && lines.length > 0;
    const total = deterministicLocal && lines.length === 0
      ? { currency: "USD" as const, micros: 0 }
      : allLinesKnown
        ? { currency: "USD" as const, micros: sumSafe(lines.map((line) => line.amount!.micros), "task cost total") }
        : null;
    const totalInputTokens = sumSafe(lines.map((line) => line.inputTokens ?? 0), "task input token total");
    const knownFreshInputTokens = sumSafe(
      lines.map((line) => line.inputTokens !== null && line.cachedInputTokens !== null ? line.inputTokens - line.cachedInputTokens : 0),
      "known fresh input token total",
    );
    const knownCachedInputTokens = sumSafe(lines.map((line) => line.cachedInputTokens ?? 0), "known cached input token total");
    const outputTokens = sumSafe(lines.map((line) => line.outputTokens ?? 0), "task output token total");

    return TaskCostSummarySchema.parse({
      taskId,
      total,
      accuracy: lines.length === 0
        ? deterministicLocal ? "exact_usage_pricing" : "unknown"
        : summaryAccuracy(lines),
      requestCount: lines.length,
      totalInputTokens,
      knownFreshInputTokens,
      knownCachedInputTokens,
      outputTokens,
      cacheBreakdownComplete: lines.every((line) => line.inputTokens !== null && line.cachedInputTokens !== null),
      lines,
    });
  };

  return {
    record(input: CostLine): CostLine {
      const value = CostLineSchema.parse(input);
      return db.transaction(() => {
        db.prepare(`INSERT INTO task_cost_lines (
          id,task_id,request_id,provider_id,model_id,input_tokens,cached_input_tokens,
          output_tokens,amount_micros_usd,accuracy,pricing_snapshot_json,created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(task_id,request_id) DO NOTHING`).run(
          value.id,
          value.taskId,
          value.requestId,
          value.providerId,
          value.modelId,
          value.inputTokens,
          value.cachedInputTokens,
          value.outputTokens,
          value.amount?.micros ?? null,
          value.accuracy,
          value.pricing === null ? null : JSON.stringify(value.pricing),
          value.recordedAt,
        );
        const recorded = getByRequest(value.taskId, value.requestId);
        if (!recorded) throw new Error(`Unable to persist task cost line ${value.requestId}`);
        return recorded;
      })();
    },
    get(idOrTaskId: string, requestId?: string): CostLine | undefined {
      return requestId === undefined ? getById(idOrTaskId) : getByRequest(idOrTaskId, requestId);
    },
    listByTask,
    summaryByTask,
  };
}
