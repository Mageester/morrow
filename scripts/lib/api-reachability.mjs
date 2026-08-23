/**
 * Orchestrator routes that no client can reach.
 *
 * Morrow's recurring failure mode is not broken code — it is correct,
 * well-tested capability that never grew a way in. `ask_teammate` shipped with
 * an ADR and 23 passing tests and was unusable because nothing could grant the
 * trust it required; the composer's floating panels were clipped invisible;
 * `skill-access` received a scoped-IDOR fix for an endpoint no screen calls.
 *
 * This gate does not demand that every route have a caller — some are
 * deliberately external or machine-facing. It freezes the set that is
 * unreachable today and fails when a NEW one appears, so the gap stops growing
 * silently while the acknowledged ones get worked off.
 */

/** Routes with no client caller today, each with why it is tolerated for now. */
export const ACKNOWLEDGED_UNREACHABLE = new Map([
  ["/api/agents/:agentId/skill-access", "Per-agent skill permissions have no UI yet; scoped-IDOR fix landed ahead of the screen."],
  ["/api/agents/:agentId/skill-access/:skillId", "Same surface as the collection route above."],
  ["/api/notify", "Notification delivery is driven by the orchestrator and external callers, not by a client screen."],
  ["/api/providers/rate-limits", "Provider rate-limit visibility has no diagnostics screen yet."],
  
  ["/api/tasks/:taskId/subagents", "Public REST spawn path, shared with model-authored ask_teammate; intentionally caller-agnostic."],
]);

/** Path segments too generic to identify a route by. */
const GENERIC = new Set(["api", "projects", "agents", "tasks", "conversations", "id"]);

export function routeKey(path) {
  const segments = path.split("/").filter((segment) => segment && !segment.startsWith(":"));
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (!GENERIC.has(segments[index])) return segments[index];
  }
  return null;
}

export function extractRoutes(serverSource) {
  return [...serverSource.matchAll(/app\.(get|post|put|patch|delete)\("(\/api\/[^"]+)"/g)]
    .map(([, method, path]) => ({ method: method.toUpperCase(), path }));
}

/**
 * Clients build request paths from template literals, so a whole-path match
 * finds nothing. The terminal non-generic segment is what actually appears in
 * client source, and is specific enough to be meaningful.
 */
export function apiReachabilityFailures({ serverSource, clientSource }) {
  const failures = [];
  const unreachable = new Set();
  const resolved = new Map();

  for (const { path } of extractRoutes(serverSource)) {
    const key = routeKey(path);
    if (!key) continue;
    if (!resolved.has(key)) {
      resolved.set(key, clientSource.includes(`/${key}`) || clientSource.includes(`"${key}"`) || clientSource.includes(`'${key}'`));
    }
    if (!resolved.get(key)) unreachable.add(path);
  }

  for (const path of [...unreachable].sort()) {
    if (!ACKNOWLEDGED_UNREACHABLE.has(path)) {
      failures.push(`${path} has no client caller. Ship the screen that reaches it in this change, or add it to ACKNOWLEDGED_UNREACHABLE in scripts/lib/api-reachability.mjs with a reason.`);
    }
  }
  for (const path of ACKNOWLEDGED_UNREACHABLE.keys()) {
    if (!unreachable.has(path)) {
      failures.push(`${path} is listed as unreachable but now has a caller — remove it from ACKNOWLEDGED_UNREACHABLE so the gate keeps its teeth.`);
    }
  }
  return failures;
}
