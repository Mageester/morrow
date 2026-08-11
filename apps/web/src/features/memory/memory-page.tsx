import { Button, EmptyState, StatusPill, Surface } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ApiClientError } from "../../api/client.js";
import { MEMORY_SCOPE_LABELS, VAULT_SCOPES, memoryApi, memoryQueries } from "../../api/memory.js";
import { useActiveProject } from "../projects/use-active-project.js";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

type ScopeFilter = "all" | (typeof VAULT_SCOPES)[number];

export function MemoryPage() {
  const { activeProject } = useActiveProject();
  const queryClient = useQueryClient();
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [sourceOpenId, setSourceOpenId] = useState<string | null>(null);
  const [draftContent, setDraftContent] = useState("");
  const [draftScope, setDraftScope] = useState<(typeof VAULT_SCOPES)[number]>("project");

  const entries = useQuery({
    ...memoryQueries.list(activeProject?.id ?? "", scopeFilter === "all" ? undefined : scopeFilter),
    enabled: Boolean(activeProject),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["memory", "list", activeProject?.id] });

  const addMemory = useMutation({
    mutationFn: (input: { scope: string; content: string }) => memoryApi.create(activeProject!.id, input),
    onSuccess: () => {
      setDraftContent("");
      invalidate();
    },
  });

  function submitMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftContent.trim() || addMemory.isPending) return;
    addMemory.mutate({ scope: draftScope, content: draftContent.trim() });
  }

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => memoryApi.setEnabled(id, activeProject!.id, enabled),
    onSuccess: invalidate,
  });
  const togglePinned = useMutation({
    mutationFn: ({ id, pinned }: { id: string; pinned: boolean }) => memoryApi.setPinned(id, activeProject!.id, pinned),
    onSuccess: invalidate,
  });
  const forgetForever = useMutation({
    mutationFn: (id: string) => memoryApi.remove(id, activeProject!.id),
    onSuccess: invalidate,
  });

  async function exportVault() {
    if (!activeProject) return;
    const data = await memoryApi.exportEntries(activeProject.id);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `morrow-memory-${activeProject.id}-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-labelledby="memory-heading" className="morrow-page morrow-memory">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Explicit, inspectable memory</p>
        <h1 id="memory-heading">Memory</h1>
        <p>
          Every record here is typed and scoped — nothing is one undifferentiated prompt blob.
          Personal facts (scope: Personal) are the one kind of memory that follows you across
          projects; everything else stays isolated to this project.
        </p>
      </div>

      {!activeProject ? (
        <EmptyState description="Choose a project to see its memory." title="No project selected" />
      ) : (
        <>
          <Surface aria-labelledby="add-memory-heading" className="morrow-memory__add" padding="large">
            <h2 id="add-memory-heading">Save a memory</h2>
            <p className="morrow-memory__add-note">
              Nothing is saved automatically — this is the only way a fact lands here from you directly.
            </p>
            <form className="morrow-memory__add-form" onSubmit={submitMemory}>
              <label className="morrow-memory__add-field">
                <span>What should Morrow remember?</span>
                <input
                  onChange={(event) => setDraftContent(event.target.value)}
                  placeholder="e.g. I prefer concise answers."
                  value={draftContent}
                />
              </label>
              <label className="morrow-memory__add-field morrow-memory__add-field--scope">
                <span>Scope</span>
                <select
                  onChange={(event) => setDraftScope(event.target.value as (typeof VAULT_SCOPES)[number])}
                  value={draftScope}
                >
                  {VAULT_SCOPES.map((scope) => (
                    <option key={scope} value={scope}>
                      {MEMORY_SCOPE_LABELS[scope] ?? scope}
                    </option>
                  ))}
                </select>
              </label>
              <Button disabled={!draftContent.trim() || addMemory.isPending} type="submit">
                {addMemory.isPending ? "Saving…" : "Save memory"}
              </Button>
            </form>
            {addMemory.isError ? (
              <p role="alert">{safeError(addMemory.error, "That memory could not be saved.")}</p>
            ) : null}
          </Surface>

          <div className="morrow-memory__toolbar" role="group" aria-label="Filter by scope">
            <button
              aria-pressed={scopeFilter === "all"}
              className="morrow-memory__scope-chip"
              onClick={() => setScopeFilter("all")}
              type="button"
            >
              All
            </button>
            {VAULT_SCOPES.map((scope) => (
              <button
                aria-pressed={scopeFilter === scope}
                className="morrow-memory__scope-chip"
                key={scope}
                onClick={() => setScopeFilter(scope)}
                type="button"
              >
                {MEMORY_SCOPE_LABELS[scope] ?? scope}
              </button>
            ))}
            <button className="morrow-memory__export" onClick={() => void exportVault()} type="button">
              Export vault (local JSON)
            </button>
          </div>

          {entries.isPending ? (
            <p aria-live="polite" role="status">
              Loading memory…
            </p>
          ) : entries.isError ? (
            <div className="morrow-inline-error">
              <p role="alert">Memory could not be loaded.</p>
              <button onClick={() => void entries.refetch()} type="button">
                Try again
              </button>
            </div>
          ) : (entries.data ?? []).length === 0 ? (
            <EmptyState
              description="Nothing here yet. Memory is saved explicitly — Morrow never silently stores facts about you or a project."
              title="No memory in this scope"
            />
          ) : (
            <ul aria-label="Memory records" className="morrow-memory__list">
              {(entries.data ?? []).map((entry) => (
                <li key={entry.id}>
                  <Surface className="morrow-memory__row" data-disabled={!entry.enabled || undefined}>
                    <div className="morrow-memory__row-main">
                      <StatusPill variant={entry.enabled ? "accent" : "neutral"}>
                        {MEMORY_SCOPE_LABELS[entry.scope] ?? entry.scope}
                      </StatusPill>
                      {entry.pinned ? <StatusPill variant="success">Pinned</StatusPill> : null}
                      {!entry.enabled ? <StatusPill variant="neutral">Forgotten</StatusPill> : null}
                      <p className="morrow-memory__content">{entry.content}</p>
                    </div>
                    <button
                      className="morrow-memory__source-toggle"
                      onClick={() => setSourceOpenId(sourceOpenId === entry.id ? null : entry.id)}
                      type="button"
                    >
                      {sourceOpenId === entry.id ? "Hide source" : "Why does this exist?"}
                    </button>
                    {sourceOpenId === entry.id ? (
                      <dl className="morrow-memory__source">
                        <div>
                          <dt>Source</dt>
                          <dd>{entry.source === "user" ? "You wrote this" : entry.source === "cortex" ? "Morrow suggested this from observed work" : "Summarized from a conversation"}</dd>
                        </div>
                        <div>
                          <dt>Confidence</dt>
                          <dd>{Math.round(entry.confidence * 100)}%</dd>
                        </div>
                        <div>
                          <dt>Lifecycle</dt>
                          <dd>{entry.lifecycle}</dd>
                        </div>
                        <div>
                          <dt>Used</dt>
                          <dd>{entry.usageCount} time{entry.usageCount === 1 ? "" : "s"}</dd>
                        </div>
                      </dl>
                    ) : null}
                    <div className="morrow-memory__row-actions">
                      <button onClick={() => togglePinned.mutate({ id: entry.id, pinned: !entry.pinned })} type="button">
                        {entry.pinned ? "Unpin" : "Pin"}
                      </button>
                      <button onClick={() => toggleEnabled.mutate({ id: entry.id, enabled: !entry.enabled })} type="button">
                        {entry.enabled ? "Forget" : "Restore"}
                      </button>
                      <button onClick={() => forgetForever.mutate(entry.id)} type="button">
                        Delete permanently
                      </button>
                    </div>
                  </Surface>
                </li>
              ))}
            </ul>
          )}
          {toggleEnabled.isError || togglePinned.isError || forgetForever.isError ? (
            <p role="alert">
              {safeError(toggleEnabled.error ?? togglePinned.error ?? forgetForever.error, "That change could not be saved.")}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
