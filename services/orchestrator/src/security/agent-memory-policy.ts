import type { Agent, MemoryScope } from "@morrow/contracts";

/**
 * The single decision point for "can this agent read/write this memory
 * scope". Pure and synchronous so it is trivially unit-testable and cannot
 * be swayed by anything derived from provider/tool/memory content — the
 * agent's `memoryReadScopes`/`memoryWriteScopes` columns are the only input,
 * and those are written exclusively through the agents repository (never
 * inferred from a model's own output, memory content, or tool results).
 */
export function canAgentAccessMemoryScope(
  agent: Pick<Agent, "memoryReadScopes" | "memoryWriteScopes">,
  scope: MemoryScope,
  mode: "read" | "write",
): boolean {
  const list = mode === "read" ? agent.memoryReadScopes : agent.memoryWriteScopes;
  return list.includes(scope);
}
