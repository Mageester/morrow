import type { Agent, MemoryEntry } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiClientError } from "../../api/client.js";
import { MEMORY_SCOPE_LABELS, memoryApi, memoryQueries } from "../../api/memory.js";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

function sourceLabel(entry: MemoryEntry): string {
  if (entry.source === "user") return "User-saved record";
  if (entry.source === "cortex") return "Morrow-suggested record";
  return "Conversation-derived record";
}

function scopeLabel(entry: MemoryEntry): string {
  if (entry.scope === "agent") return "Agent scope · project-local";
  if (entry.scope === "team") return "Shared team scope · project-local";
  return MEMORY_SCOPE_LABELS[entry.scope] ?? entry.scope;
}

function hasScope(agent: Agent, scope: "agent" | "team"): boolean {
  return agent.memoryReadScopes.includes(scope) || agent.memoryWriteScopes.includes(scope);
}

/**
 * A compact, project-local inspection surface for the scopes a teammate can
 * use. MemoryEntry has no owner column today, so the copy deliberately names
 * the scope instead of pretending a record came from a hidden teammate
 * transcript. Mutations reuse the Memory page's existing routes.
 */
export function TeammateMemoryPanel({ agent, projectId }: { agent: Agent; projectId: string }) {
  const queryClient = useQueryClient();
  const agentScopeConfigured = hasScope(agent, "agent");
  const teamScopeConfigured = hasScope(agent, "team");
  const agentScopeEnabled = agentScopeConfigured;
  const teamScopeEnabled = Boolean(agent.teamId) && teamScopeConfigured;
  const agentMemory = useQuery({
    ...memoryQueries.list(projectId, "agent"),
    enabled: agentScopeEnabled,
  });
  const teamMemory = useQuery({
    ...memoryQueries.list(projectId, "team"),
    enabled: teamScopeEnabled,
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [deleteConfirmationId, setDeleteConfirmationId] = useState<string | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["memory", "list", projectId] });

  const updateMemory = useMutation({
    mutationFn: ({ id, content }: { id: string; content: string }) => memoryApi.updateContent(id, projectId, content),
    onSuccess: () => {
      setEditingId(null);
      setEditContent("");
      invalidate();
    },
  });
  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => memoryApi.setEnabled(id, projectId, enabled),
    onSuccess: invalidate,
  });
  const removeMemory = useMutation({
    mutationFn: (id: string) => memoryApi.remove(id, projectId),
    onSuccess: () => {
      setDeleteConfirmationId(null);
      invalidate();
    },
  });

  const loading = (agentScopeEnabled && agentMemory.isPending) || (teamScopeEnabled && teamMemory.isPending);
  const error = (agentScopeEnabled ? agentMemory.error : null) ?? (teamScopeEnabled ? teamMemory.error : null);
  const entries = [
    ...(agentMemory.data ?? []),
    ...(teamMemory.data ?? []),
  ];
  const canInspect = agentScopeEnabled || teamScopeEnabled;
  const heading = agentScopeEnabled && teamScopeEnabled
    ? "Agent and Shared team scope records"
    : agentScopeEnabled
      ? "Agent scope records"
      : "Shared team scope records";

  useEffect(() => {
    if (deleteConfirmationId) deleteCancelRef.current?.focus();
  }, [deleteConfirmationId]);

  function refetch() {
    if (agentScopeEnabled) void agentMemory.refetch();
    if (teamScopeEnabled) void teamMemory.refetch();
  }

  if (!canInspect) {
    return (
      <div aria-live="polite" id="teammate-memory-panel">
        <h3>Scoped memory records</h3>
        <p>
          {teamScopeConfigured && !agent.teamId
            ? "Shared team scope is configured, but this teammate is not assigned to a team."
            : "This policy has no Agent or Shared team scope enabled."}
        </p>
        <p>Morrow cannot show individual learning here because memory records have no per-teammate owner. Open Memory access above to choose what this policy may read or write.</p>
      </div>
    );
  }
  if (loading) {
    return <p aria-live="polite" id="teammate-memory-panel" role="status">Loading scoped memory records…</p>;
  }
  if (error) {
    return (
      <div aria-live="polite" id="teammate-memory-panel">
        <p role="alert">Scoped memory records could not be loaded.</p>
        <button onClick={refetch} type="button">Try again</button>
      </div>
    );
  }

  return (
    <div id="teammate-memory-panel">
      <h3>{heading}</h3>
      <p>
        These are durable records in the enabled scopes for {agent.name}&#39;s project, not records owned by {agent.name}. Morrow does not store a per-teammate owner, so this view cannot show what this teammate learned; another teammate with the same scope permission may use these records. Conversation transcripts are never presented as learned teammate memory.
      </p>
      {entries.length === 0 ? (
        <p aria-live="polite">No durable records are saved in these scopes for this project. This does not indicate whether {agent.name} has learned anything; this memory model has no per-teammate owner.</p>
      ) : (
        <ul aria-label={`${heading} for this project`}>
          {entries.map((entry) => (
            <li key={entry.id}>
              {editingId === entry.id ? (
                <label>
                  <span>Edit scoped memory</span>
                  <textarea
                    aria-label="Edit scoped memory"
                    onChange={(event) => setEditContent(event.target.value)}
                    value={editContent}
                  />
                </label>
              ) : (
                <p>{entry.content}</p>
              )}
              <p>
                <span>{scopeLabel(entry)}</span>
                <span> · {sourceLabel(entry)}</span>
              </p>
              {entry.evidenceReferences.length > 0 ? (
                <small>Evidence: {entry.evidenceReferences.map((reference) => reference.reference).join(", ")}</small>
              ) : null}
              {editingId === entry.id ? (
                <div>
                  <button
                    disabled={!editContent.trim() || updateMemory.isPending}
                    onClick={() => updateMemory.mutate({ id: entry.id, content: editContent.trim() })}
                    type="button"
                  >
                    {updateMemory.isPending ? "Saving…" : "Save record"}
                  </button>
                  <button onClick={() => { setEditingId(null); setEditContent(""); }} type="button">Cancel</button>
                </div>
              ) : (
                <div>
                  <button onClick={() => { setEditingId(entry.id); setEditContent(entry.content); }} type="button">Edit record</button>
                  <button onClick={() => toggleEnabled.mutate({ id: entry.id, enabled: !entry.enabled })} type="button">
                    {entry.enabled ? "Forget" : "Restore"}
                  </button>
                  <button onClick={() => setDeleteConfirmationId(entry.id)} type="button">Delete permanently</button>
                  {deleteConfirmationId === entry.id ? (
                    <div
                      aria-describedby={`delete-memory-description-${entry.id}`}
                      aria-labelledby={`delete-memory-heading-${entry.id}`}
                      aria-modal="true"
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          setDeleteConfirmationId(null);
                        }
                        if (event.key === "Tab" && event.shiftKey && event.target === deleteCancelRef.current) {
                          event.preventDefault();
                          (event.currentTarget.querySelector("[data-confirm-delete]") as HTMLButtonElement | null)?.focus();
                        }
                        if (event.key === "Tab" && !event.shiftKey && event.target === event.currentTarget.querySelector("[data-confirm-delete]")) {
                          event.preventDefault();
                          deleteCancelRef.current?.focus();
                        }
                      }}
                      role="alertdialog"
                    >
                      <h4 id={`delete-memory-heading-${entry.id}`}>Delete this memory?</h4>
                      <p id={`delete-memory-description-${entry.id}`}>This permanently removes the {scopeLabel(entry)} record from this project. Records are not owned by a teammate, and this cannot be undone.</p>
                      <button onClick={() => setDeleteConfirmationId(null)} ref={deleteCancelRef} type="button">Keep memory</button>
                      <button
                        data-confirm-delete
                        disabled={removeMemory.isPending}
                        onClick={() => removeMemory.mutate(entry.id)}
                        type="button"
                      >
                        {removeMemory.isPending ? "Deleting…" : "Delete permanently"}
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {updateMemory.isError || toggleEnabled.isError || removeMemory.isError ? (
        <p role="alert">{safeError(updateMemory.error ?? toggleEnabled.error ?? removeMemory.error, "That memory change could not be saved.")}</p>
      ) : null}
    </div>
  );
}
