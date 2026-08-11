import {
  TaskCostSummarySchema,
  type MoneyAmount,
} from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

const MICROS_PER_DOLLAR = 1_000_000;

/** Format fixed-point USD without converting through floating-point currency. */
export function formatUsdMicros(amount: MoneyAmount | null | undefined, fractionDigits = 4): string {
  if (!amount) return "Unknown";
  const digits = Math.max(0, Math.min(6, Math.trunc(fractionDigits)));
  const dollars = Math.floor(amount.micros / MICROS_PER_DOLLAR);
  if (digits === 0) return `$${dollars}`;
  const fraction = String(amount.micros % MICROS_PER_DOLLAR).padStart(6, "0").slice(0, digits);
  return `$${dollars}.${fraction}`;
}

export const taskCostQueries = {
  forTask(taskId: string) {
    return queryOptions({
      queryKey: ["task", taskId, "cost"] as const,
      queryFn: () => api.get(`/api/tasks/${encodeURIComponent(taskId)}/cost`, TaskCostSummarySchema),
      staleTime: 0,
      refetchInterval: 1_000,
    });
  },
};
