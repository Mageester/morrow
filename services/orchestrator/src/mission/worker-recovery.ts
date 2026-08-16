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
  priorDecisions: Array<Pick<MissionRecoveryDecision, "category" | "action" | "nextStrategyFingerprint">>;
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
    case "verification_failure":
      return { action: "replan", next: "worker:alternate-strategy", retryCondition: null, exhausted: false };
    default:
      return { action: "restore_checkpoint", next: "worker:replacement", retryCondition: null, exhausted: false };
  }
}

/**
 * A fingerprint of the strategy itself, not of the worker that ran it.
 *
 * `worker:<taskId>` identified a *task*, and every retry gets a fresh task id,
 * so two identical strategies never produced matching fingerprints and
 * stagnation was undetectable by construction. Encoding the category, the
 * action, and the substitution the action intends means "retry the same
 * provider again" and "switch provider" are distinguishable, and repeating one
 * is visible as a repeat.
 */
export function strategyFingerprint(
  category: MissionRecoveryCategory,
  action: MissionRecoveryAction,
  detail: string | null,
): string {
  return `strategy:${category}:${action}${detail ? `:${detail}` : ""}`;
}

/**
 * Escalation order used when the selected strategy would repeat one already
 * tried for this category. Each step is a materially different approach —
 * a different provider, a different model, a smaller context, a different plan,
 * a restored checkpoint — ending in an explicit stop.
 */
function escalate(input: WorkerRecoveryInput, tried: ReadonlySet<string>, category: MissionRecoveryCategory):
  { action: MissionRecoveryAction; next: string | null; retryCondition: string | null; exhausted: boolean } | null {
  const ladder: Array<{ action: MissionRecoveryAction; next: string; permitted: boolean }> = [
    { action: "switch_provider", next: "provider:fallback", permitted: input.allowProviderSwitch !== false && input.alternateProviders > 0 },
    { action: "switch_model", next: "model:available-alternative", permitted: input.allowModelSwitch !== false },
    { action: "compact_context", next: "context:compact", permitted: true },
    { action: "replan", next: "worker:alternate-strategy", permitted: true },
    { action: "restore_checkpoint", next: "worker:replacement", permitted: true },
  ];
  for (const step of ladder) {
    if (!step.permitted) continue;
    if (tried.has(strategyFingerprint(category, step.action, step.next))) continue;
    return { action: step.action, next: step.next, retryCondition: null, exhausted: false };
  }
  return null;
}

export function decideWorkerRecovery(input: WorkerRecoveryInput): ControllerRecovery {
  const category = categoryFor(input);
  const priorForCategory = input.priorDecisions.filter((decision) => decision.category === category);
  const attempt = priorForCategory.length + 1;
  const tried = new Set(priorForCategory.map((decision) =>
    decision.nextStrategyFingerprint ?? strategyFingerprint(category, decision.action, null)));

  let selected = actionFor(category, input, attempt);
  let fingerprint = selected.next === null ? null : strategyFingerprint(category, selected.action, selected.next);
  let escalated = false;

  // Never re-dispatch a strategy this category already tried. `await_retry_condition`
  // is the one exception: waiting out a provider cooldown is the correct response
  // to a second rate limit, and it is bounded by MAX_AUTOMATIC_ATTEMPTS.
  if (fingerprint && tried.has(fingerprint) && selected.action !== "await_retry_condition") {
    const alternative = escalate(input, tried, category);
    if (alternative) {
      selected = alternative;
      escalated = true;
    } else {
      selected = { action: "block_precisely", next: null, retryCondition: null, exhausted: true };
    }
    fingerprint = selected.next === null ? null : strategyFingerprint(category, selected.action, selected.next);
  }

  const stagnation = escalated
    ? " Previous strategy repeated without progress; escalated to a materially different approach."
    : selected.exhausted && attempt > MAX_AUTOMATIC_ATTEMPTS
      ? " No materially different automatic strategy remains."
      : "";
  return {
    category,
    diagnosis: `${input.message || `Worker ended ${input.status}.`} (automatic recovery attempt ${attempt}/${MAX_AUTOMATIC_ATTEMPTS})${stagnation}`.slice(0, 2_000),
    // What we are moving away from: the strategy the last attempt chose.
    failedStrategyFingerprint: priorForCategory.at(-1)?.nextStrategyFingerprint
      ?? strategyFingerprint(category, "retry_same_provider", `worker:${input.taskId}`),
    nextStrategyFingerprint: fingerprint,
    action: selected.action,
    retryCondition: selected.retryCondition,
    exhausted: selected.exhausted,
  };
}
