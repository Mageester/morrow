/**
 * Shared query-key namespace for every per-task runtime snapshot — context
 * usage, capability/reasoning telemetry, and any future task-scoped read.
 *
 * A snapshot under this prefix is only truly immutable once the task reaches
 * a terminal state; a query that first resolves while the task is still
 * queued or streaming caches an empty (or partial) snapshot for its whole
 * `staleTime`, and nothing else would ever tell it to look again. The fix
 * lives in one place: `chat-stream.ts` invalidates this exact prefix on every
 * task lifecycle transition, which — because React Query's default
 * `invalidateQueries` matching is a key-prefix match, not exact — reaches
 * every current and future query built from `taskQueryKey`, without either
 * side needing to enumerate the other's suffixes.
 */
export function taskQueryKey(taskId: string) {
  return ["task", taskId] as const;
}
