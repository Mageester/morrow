import { randomUUID } from "node:crypto";
import type { ProjectIntelligence, ChangeImpactAnalysis, MissionFailure } from "@morrow/contracts";

/**
 * Change-impact analysis: given an objective and the project's persisted
 * intelligence, predict what a change touches and what must be verified.
 *
 * Deterministic by design — every claim traces to a stored intelligence item
 * (component, relationship, decision, learning, failure, or rule), and
 * anything the analysis cannot ground is stated as uncertainty rather than
 * guessed. A model may later *prioritize* this output; it does not produce it.
 */

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "without",
  "add", "adds", "adding", "fix", "fixes", "fixing", "make", "makes", "update",
  "updates", "existing", "new", "should", "must", "not", "no", "breaking", "break",
  "behavior", "behaviour", "support", "handling", "system", "code", "repository",
  "repo", "project", "implement", "implementation", "ensure", "correct", "problem",
  "issue", "important", "most", "this", "that", "it", "is", "are", "be", "when",
]);

export function objectiveTokens(objective: string): string[] {
  return [...new Set(
    objective.toLowerCase()
      .split(/[^a-z0-9_-]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t)),
  )];
}

function matches(tokens: string[], ...haystacks: Array<string | null | undefined>): boolean {
  const text = haystacks.filter(Boolean).join(" ").toLowerCase();
  return tokens.some((t) => text.includes(t));
}

export function analyzeChangeImpact(options: {
  missionId: string;
  objective: string;
  intelligence: ProjectIntelligence;
  priorFailures?: MissionFailure[];
  now?: () => string;
}): ChangeImpactAnalysis {
  const { missionId, objective, intelligence } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const tokens = objectiveTokens(objective);

  // Components whose name/path/description matches the objective.
  const direct = intelligence.architecture.components.filter((c) =>
    matches(tokens, c.name, c.path, c.description));
  // Dependents of directly-affected components are at regression risk.
  const directNames = new Set(direct.map((c) => c.name));
  const dependents = intelligence.architecture.components.filter((c) =>
    !directNames.has(c.name) && c.dependsOn.some((d) => directNames.has(d)));

  const likelyComponents = [...direct, ...dependents].map((c) => c.path);
  const likelyFiles = [...new Set([
    ...direct.flatMap((c) => c.entryPoints),
    ...intelligence.relationships
      .filter((r) => r.freshness !== "invalidated" && (matches(tokens, r.from, r.to, r.note) || likelyComponents.some((p) => r.from.startsWith(p) || r.to.startsWith(p))))
      .flatMap((r) => [r.from, r.to]),
  ])].slice(0, 40);

  // Public surface at risk: entry points of direct components that others depend on.
  const interfacesAtRisk = direct
    .filter((c) => dependents.some((d) => d.dependsOn.includes(c.name)) || intelligence.architecture.components.some((o) => o.dependsOn.includes(c.name)))
    .flatMap((c) => c.entryPoints.map((e) => `${c.name}: ${e}`))
    .slice(0, 20);

  // Verification: verified-in-anger commands first, then declared ones, scoped
  // to affected components plus the repo root.
  const commandPool = intelligence.commands.length > 0 ? intelligence.commands : intelligence.architecture.commands;
  const relevantCommands = commandPool
    .filter((c) => c.cwd === "." || likelyComponents.some((p) => c.cwd === p || c.cwd.startsWith(`${p}/`)))
    .sort((a, b) => Number(Boolean(b.lastVerifiedAt)) - Number(Boolean(a.lastVerifiedAt)));
  const requiredVerification = [...new Set(relevantCommands
    .filter((c) => ["test", "check", "build", "e2e"].includes(c.role))
    .map((c) => (c.cwd === "." ? c.command : `${c.command} (in ${c.cwd})`)))];
  const testsLikelyAffected = relevantCommands.filter((c) => c.role === "test" && c.cwd !== ".").map((c) => c.cwd);

  // History that should shape the plan.
  const relevantDecisions = intelligence.decisions
    .filter((d) => (d.status === "accepted" || d.status === "proposed")
      && (matches(tokens, d.statement, d.context) || d.affectedComponents.some((a) => likelyComponents.includes(a) || directNames.has(a))))
    .map((d) => `${d.label}: ${d.statement}`);
  const failedApproaches = intelligence.missionLearnings
    .filter((l) => l.freshness !== "invalidated" && (l.type === "failed_approach" || l.type === "misleading_symptom" || l.type === "false_assumption")
      && (matches(tokens, l.statement, l.scope) || likelyComponents.some((p) => l.scope === p || l.scope.startsWith(p))))
    .map((l) => l.statement);
  const priorFailureSignatures = [...new Set((options.priorFailures ?? [])
    .filter((f) => matches(tokens, f.operation, f.message))
    .map((f) => `${f.category}: ${f.operation.slice(0, 120)}`))].slice(0, 10);

  // Rules always apply; surface the ones scoped near the affected area first.
  const relevantRules = intelligence.userRules
    .filter((r) => r.active)
    .sort((a, b) => Number(likelyComponents.some((p) => b.scope === p || b.scope.startsWith(p))) - Number(likelyComponents.some((p) => a.scope === p || a.scope.startsWith(p))))
    .map((r) => r.text);

  const possibleRegressions = [
    ...dependents.map((c) => `${c.path} depends on ${c.dependsOn.filter((d) => directNames.has(d)).join(", ")} and may regress`),
    ...intelligence.architecture.boundaries.filter((b) => matches(tokens, b.description)).map((b) => b.description),
    ...intelligence.risks.filter((r) => r.freshness !== "invalidated" && matches(tokens, r.description, r.area)).map((r) => r.description),
  ].slice(0, 15);

  // Honest uncertainty.
  const uncertainty: string[] = [];
  if (direct.length === 0) {
    uncertainty.push("No stored component matches the objective directly; the affected area is inferred weakly and exploration is required.");
  }
  if (intelligence.architecture.freshness !== "current") {
    uncertainty.push(`Architecture knowledge is ${intelligence.architecture.freshness.replace("_", " ")}; refresh before relying on component boundaries.`);
  }
  const staleUsed = intelligence.missionLearnings.filter((l) => l.freshness === "possibly_stale" || l.freshness === "stale").length;
  if (staleUsed > 0) uncertainty.push(`${staleUsed} stored learning(s) may be stale and were down-weighted.`);
  for (const u of intelligence.uncertainties.slice(0, 5)) uncertainty.push(u.description);

  return {
    id: `impact-${randomUUID()}`,
    missionId,
    objective,
    likelyFiles,
    likelyComponents,
    interfacesAtRisk,
    testsLikelyAffected,
    relevantDecisions,
    relevantFailures: [...failedApproaches, ...priorFailureSignatures],
    relevantRules,
    possibleRegressions,
    requiredVerification,
    uncertainty,
    createdAt: now(),
  };
}
