import type { RoutingCandidate, ProviderId } from "@morrow/contracts";

/**
 * Which providers a task may fail over to mid-stream.
 *
 * Live fallback exists so an automatically chosen route does not lose a turn
 * to one provider's outage. It must not silently rewrite a route the user
 * chose: a fallback candidate is constructed from the registry and served with
 * that provider's *default* model, so failing over from an explicitly
 * requested provider/model substitutes both without the caller ever asking for
 * a substitution.
 *
 * The rule is therefore: a pinned route (the user supplied `--provider` and/or
 * `--model`, persisted as `RoutingDecision.overridden`) has no alternates. When
 * it cannot serve the turn the task surfaces the provider failure instead of
 * quietly answering from somewhere else.
 */
export function eligibleFallbackProviderIds(input: {
  pinned: boolean;
  primaryProviderId: string;
  candidates: readonly RoutingCandidate[] | undefined;
}): ProviderId[] {
  if (input.pinned) return [];
  const seen = new Set<string>([input.primaryProviderId, "mock"]);
  const eligible: ProviderId[] = [];
  for (const candidate of input.candidates ?? []) {
    if (!candidate.configured || seen.has(candidate.providerId)) continue;
    seen.add(candidate.providerId);
    eligible.push(candidate.providerId);
  }
  return eligible;
}
