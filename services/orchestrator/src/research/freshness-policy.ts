import {
  FreshnessPolicySchema,
  ResearchRoutingDecisionSchema,
  type FreshnessPolicy,
  type ResearchRoutingDecision,
  type ResearchSource,
} from "@morrow/contracts";

const FRESHNESS_REQUEST = /\b(latest|today|current|recent|up[- ]to[- ]date|as[- ]of)\b/i;

export function evaluateResearchRequirement(query: string, policy?: FreshnessPolicy) {
  const detected = FRESHNESS_REQUEST.test(query);
  const effectivePolicy = FreshnessPolicySchema.parse(policy ?? (detected ? { mode: "current" } : { mode: "offline" }));
  const required = effectivePolicy.mode !== "offline" && (detected || policy !== undefined);
  return {
    required,
    requiresNetwork: required,
    detected,
    policy: effectivePolicy,
    explanation: required
      ? effectivePolicy.mode === "current"
        ? "Current information requires a network-capable research tool."
        : "The requested freshness policy requires source validation before answering."
      : "Use stored information only; no research tool is scheduled.",
  };
}

export function routeResearch(input: {
  query: string;
  policy?: FreshnessPolicy;
  networkToolAvailable: boolean;
  localOnly: boolean;
  storedSourceAvailable: boolean;
}): ResearchRoutingDecision {
  const requirement = evaluateResearchRequirement(input.query, input.policy);
  const policy = requirement.policy;
  if (!requirement.required) {
    return ResearchRoutingDecisionSchema.parse({
      required: false,
      requiresNetwork: false,
      execution: "stored",
      explanation: requirement.explanation,
      policy,
    });
  }

  if (policy.mode === "current" && input.localOnly) {
    return ResearchRoutingDecisionSchema.parse({
      required: true,
      requiresNetwork: true,
      execution: "blocked-local-only",
      explanation: "This request asks for current information, but local-only mode forbids live research.",
      policy,
    });
  }
  if (!input.networkToolAvailable) {
    if (input.storedSourceAvailable && policy.mode !== "current") {
      return ResearchRoutingDecisionSchema.parse({
        required: true,
        requiresNetwork: true,
        execution: "stored",
        explanation: "No network-capable research tool is available; answering from stored sources only.",
        policy,
      });
    }
    return ResearchRoutingDecisionSchema.parse({
      required: true,
      requiresNetwork: true,
      execution: input.localOnly ? "blocked-local-only" : "stored",
      explanation: input.localOnly
        ? "Live information is required, but local-only mode forbids a research request."
        : "Live information is required, but no network-capable research tool is available.",
      policy,
    });
  }

  return ResearchRoutingDecisionSchema.parse({
    required: true,
    requiresNetwork: true,
    execution: input.storedSourceAvailable ? "stored-and-live" : "live",
    explanation: input.storedSourceAvailable
      ? "Stored sources are shown alongside a live research refresh."
      : "A live source is required and will be recorded with task provenance.",
    policy,
  });
}

export function evaluateSourceFreshness(
  source: ResearchSource,
  policy: FreshnessPolicy,
  now: string,
): { accepted: boolean; status: ResearchSource["validationStatus"]; reason: string } {
  if (policy.mode === "recent") {
    const age = Date.parse(now) - Date.parse(source.retrievedAt);
    const accepted = Number.isFinite(age) && age >= 0 && age <= policy.maxAgeHours * 60 * 60 * 1000;
    return accepted
      ? { accepted: true, status: "validated", reason: "Retrieved within the requested recent window." }
      : { accepted: false, status: "stale", reason: "Retrieved outside the requested recent window." };
  }
  if (policy.mode === "as_of" && source.publishedAt && source.publishedAt.slice(0, 10) > policy.date) {
    return { accepted: false, status: "post_cutoff", reason: "Published after the requested as-of date." };
  }
  return { accepted: true, status: "validated", reason: "Source satisfies the requested freshness policy." };
}
