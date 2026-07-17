import type {
  MissionRecoveryAction,
  MissionRecoveryCategory,
  MissionRecoveryDecision,
  TaskStatus,
} from "@morrow/contracts";
import type { ControllerRecovery } from "./controller.js";

export interface ProviderFailureDetails {
  kind: string;
  retryable: boolean;
  status: number | null;
  retryAfterMs: number | null;
}

export interface WorkerRecoveryInput {
  taskId: string;
  status: Extract<TaskStatus, "failed" | "interrupted">;
  reason: string | null;
  message: string;
  provider: ProviderFailureDetails | null;
  priorDecisions: Array<Pick<MissionRecoveryDecision, "category">>;
  alternateProviders: number;
  allowProviderSwitch?: boolean;
  allowModelSwitch?: boolean;
}

const MAX_AUTOMATIC_ATTEMPTS = 3;

function categoryFor(input: WorkerRecoveryInput): MissionRecoveryCategory {
  const combined = `${input.reason ?? ""}\n${input.message}`.toLowerCase();
  if (input.provider?.kind === "rate_limit" || /rate limit|\b429\b/.test(combined)) return "rate_limit";
  if (input.provider?.kind === "network" || /network|econn|enotfound|dns|socket/.test(combined)) return "network_failure";
  if (/model .*not (?:available|found|supported)|unknown model|model access denied/.test(combined)) return "model_unavailable";
  if (input.reason === "context_rollover_required" || /context (?:window|limit|budget)/.test(combined)) return "context_exhaustion";
  if (input.reason === "strategy_change_required" || /loop|no measurable progress|repeated/.test(combined)) return "repeated_strategy";
  if (input.reason === "validation_required" || /verification|validation/.test(combined)) return "verification_failure";
  if (input.reason === "provider_recovery_required" || input.provider || /provider|upstream|insufficient balance|payment required|\b402\b/.test(combined)) return "provider_failure";
  return "process_interruption";
}

function actionFor(
  category: MissionRecoveryCategory,
  input: WorkerRecoveryInput,
  attempt: number,
): { action: MissionRecoveryAction; next: string | null; retryCondition: string | null; exhausted: boolean } {
  const paymentOrAuthFailure = input.provider?.retryable === false && (
    input.provider.status === 401
    || input.provider.status === 402
    || input.provider.status === 403
    || /insufficient balance|payment required|invalid api key|unauthori[sz]ed|forbidden/i.test(input.message)
  );
  if (paymentOrAuthFailure) {
    return input.allowProviderSwitch !== false && input.alternateProviders > 0
      ? { action: "switch_provider", next: "provider:fallback", retryCondition: null, exhausted: false }
      : { action: "block_precisely", next: null, retryCondition: null, exhausted: true };
  }
  if (attempt > MAX_AUTOMATIC_ATTEMPTS) {
    return { action: "block_precisely", next: null, retryCondition: null, exhausted: true };
  }

  switch (category) {
    case "rate_limit":
      return {
        action: "await_retry_condition",
        next: "provider:retry-after",
        retryCondition: input.provider?.retryAfterMs
          ? `Retry after ${input.provider.retryAfterMs}ms provider cooldown.`
          : "Retry after the provider rate-limit window clears.",
        exhausted: false,
      };
    case "provider_failure":
      if (input.provider?.retryable === false) {
        return input.allowProviderSwitch !== false && input.alternateProviders > 0
          ? { action: "switch_provider", next: "provider:fallback", retryCondition: null, exhausted: false }
          : { action: "block_precisely", next: null, retryCondition: null, exhausted: true };
      }
      if (attempt >= 2 && input.allowProviderSwitch !== false && input.alternateProviders > 0) {
        return { action: "switch_provider", next: "provider:fallback", retryCondition: null, exhausted: false };
      }
      return { action: "retry_same_provider", next: "provider:retry", retryCondition: null, exhausted: false };
    case "model_unavailable":
      if (input.allowModelSwitch === false && (input.allowProviderSwitch === false || input.alternateProviders === 0)) {
        return { action: "block_precisely", next: null, retryCondition: null, exhausted: true };
      }
      return input.allowProviderSwitch !== false && input.alternateProviders > 0
        ? { action: "switch_provider", next: "provider:fallback", retryCondition: null, exhausted: false }
        : { action: "switch_model", next: "model:available-alternative", retryCondition: null, exhausted: false };
    case "network_failure":
      return input.allowProviderSwitch !== false && input.alternateProviders > 0 && attempt >= 2
        ? { action: "switch_provider", next: "provider:fallback", retryCondition: null, exhausted: false }
        : { action: "retry_same_provider", next: "provider:network-retry", retryCondition: null, exhausted: false };
    case "context_exhaustion":
      return { action: "compact_context", next: "context:compact", retryCondition: null, exhausted: false };
    case "repeated_strategy":
    case "verification_failure":
      return { action: "replan", next: "worker:alternate-strategy", retryCondition: null, exhausted: false };
    default:
      return { action: "restore_checkpoint", next: "worker:replacement", retryCondition: null, exhausted: false };
  }
}

export function decideWorkerRecovery(input: WorkerRecoveryInput): ControllerRecovery {
  const category = categoryFor(input);
  const attempt = input.priorDecisions.filter((decision) => decision.category === category).length + 1;
  const selected = actionFor(category, input, attempt);
  return {
    category,
    diagnosis: `${input.message || `Worker ended ${input.status}.`} (automatic recovery attempt ${attempt}/${MAX_AUTOMATIC_ATTEMPTS})`.slice(0, 2_000),
    failedStrategyFingerprint: `worker:${input.taskId}`,
    nextStrategyFingerprint: selected.next,
    action: selected.action,
    retryCondition: selected.retryCondition,
    exhausted: selected.exhausted,
  };
}
