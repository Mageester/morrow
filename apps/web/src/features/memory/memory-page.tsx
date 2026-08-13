import type { MemoryEntry } from "@morrow/contracts";
import { Button, EmptyState } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ApiClientError } from "../../api/client.js";
import { MEMORY_SCOPE_LABELS, VAULT_SCOPES, memoryApi, memoryQueries } from "../../api/memory.js";
import { ProductHeader } from "../../components/product-frame.js";
import { useActiveProject } from "../projects/use-active-project.js";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

function sourceLabel(entry: MemoryEntry): string {
  if (entry.source === "user") return "You wrote this";
  if (entry.source === "cortex") return "Morrow suggested this from observed work";
  return "Summarized from a conversation";
}

function formatRemembered(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, { day: "numeric", hour: "numeric", minute: "2-digit", month: "short" });
  } catch {
    return "Unknown";
  }
}

type ScopeFilter = "all" | (typeof VAULT_SCOPES)[number];

export function MemoryPage() {
  const { activeProject } = useActiveProject();
  const queryClient = useQueryClient();
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sourceOpenId, setSourceOpenId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState("");
  const [adding, setAdding] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [draftScope, setDraftScope] = useState<(typeof VAULT_SCOPES)[number]>("project");

  const automatic = useQuery(memoryQueries.settings());
  const setAutomatic = useMutation({
    mutationFn: memoryApi.setAutoCapture,
    onSuccess: (settings) => queryClient.setQueryData(["memory", "settings"], settings),
  });
  const entries = useQuery({
    ...memoryQueries.list(activeProject?.id ?? "", scopeFilter === "all" ? undefined : scopeFilter),
    enabled: Boolean(activeProject),
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["memory", "list", activeProject?.id] });
  const addMemory = useMutation({
    mutationFn: (input: { scope: string; content: string }) => memoryApi.create(activeProject!.id, input),
    onSuccess: (created) => {
      setDraftContent("");
      setAdding(false);
      setSelectedId(created.id);
      invalidate();
    },
  });
  const toggleEnabled = useMutation({
    mutationFn: ({ id, projectId, enabled }: { id: string; projectId: string; enabled: boolean }) => memoryApi.setEnabled(id, projectId, enabled),
    onSuccess: invalidate,
  });
  const togglePinned = useMutation({
    mutationFn: ({ id, projectId, pinned }: { id: string; projectId: string; pinned: boolean }) => memoryApi.setPinned(id, projectId, pinned),
    onSuccess: invalidate,
  });
  const updateMemory = useMutation({
    mutationFn: ({ id, projectId, content }: { id: string; projectId: string; content: string }) => memoryApi.updateContent(id, projectId, content),
    onSuccess: () => {
      setEditingId(null);
      setEditContent("");
      invalidate();
    },
  });
  const forgetForever = useMutation({
    mutationFn: ({ id, projectId }: { id: string; projectId: string }) => memoryApi.remove(id, projectId),
    onSuccess: (_, removed) => {
      if (selectedId === removed.id) setSelectedId(null);
      invalidate();
    },
  });

  function submitMemory(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draftContent.trim() || addMemory.isPending) return;
    addMemory.mutate({ scope: draftScope, content: draftContent.trim() });
  }

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

  const visibleEntries = (entries.data ?? []).filter((entry) => entry.content.toLowerCase().includes(query.trim().toLowerCase()));
  const selected = visibleEntries.find((entry) => entry.id === selectedId) ?? visibleEntries[0] ?? null;

  return (
    <section aria-labelledby="memory-heading" className="morrow-page morrow-memory">
      <ProductHeader
        action={activeProject ? (
          <label className="morrow-premium-search">
            <Search aria-hidden="true" size={15} />
            <span className="morrow-visually-hidden">Search your memory</span>
            <input onChange={(event) => setQuery(event.target.value)} placeholder="Search your memory…" type="search" value={query} />
          </label>
        ) : undefined}
        description="What Morrow remembers, why it matters, and exactly where it applies."
        eyebrow="Private knowledge"
        headingId="memory-heading"
        title="Memory"
      />

      <div className="morrow-memory-commandbar">
        <label className="morrow-memory-commandbar__learning">
          <span><b>Automatic memory suggestions</b><small>Durable preferences and project facts only.</small></span>
          <span className="morrow-switch">
            <input aria-describedby="automatic-memory-note" aria-label="Learn useful memory automatically" checked={automatic.data?.autoCapture ?? true} disabled={automatic.isPending || setAutomatic.isPending} onChange={(event) => setAutomatic.mutate(event.target.checked)} type="checkbox" />
            <span aria-hidden="true" className="morrow-switch__thumb" />
          </span>
        </label>
        {activeProject ? <Button aria-expanded={adding} onClick={() => setAdding((open) => !open)} variant={adding ? "secondary" : "primary"}>{adding ? "Close" : "＋ Save memory"}</Button> : null}
        {activeProject ? <Button onClick={() => void exportVault()} variant="secondary">Export local JSON</Button> : null}
      </div>
      <p className="morrow-memory-commandbar__note" id="automatic-memory-note">Likely secrets, temporary facts, raw transcripts, and prompt instructions are rejected before storage.</p>
      {automatic.isError || setAutomatic.isError ? <p role="alert">Automatic memory settings could not be saved.</p> : null}

      {!activeProject ? (
        <EmptyState description="Choose a project to see its memory." title="No project selected" />
      ) : (
        <>
          {adding ? (
            <section aria-labelledby="add-memory-heading" className="morrow-memory__add" id="memory-add-panel">
              <h2 id="add-memory-heading">Save a memory</h2>
              <p className="morrow-memory__add-note">Add or pin something directly whenever you want exact control.</p>
              <form className="morrow-memory__add-form" onSubmit={submitMemory}>
                <label className="morrow-memory__add-field"><span>What should Morrow remember?</span><input onChange={(event) => setDraftContent(event.target.value)} placeholder="e.g. I prefer concise answers." value={draftContent} /></label>
                <label className="morrow-memory__add-field morrow-memory__add-field--scope"><span>Scope</span><select onChange={(event) => setDraftScope(event.target.value as (typeof VAULT_SCOPES)[number])} value={draftScope}>{VAULT_SCOPES.map((scope) => <option key={scope} value={scope}>{MEMORY_SCOPE_LABELS[scope] ?? scope}</option>)}</select></label>
                <Button disabled={!draftContent.trim() || addMemory.isPending} type="submit">{addMemory.isPending ? "Saving…" : "Save memory"}</Button>
              </form>
              {addMemory.isError ? <p role="alert">{safeError(addMemory.error, "That memory could not be saved.")}</p> : null}
            </section>
          ) : null}

          {entries.isPending ? <p aria-live="polite" role="status">Loading memory…</p> : entries.isError ? (
            <div className="morrow-inline-error"><p role="alert">Memory could not be loaded.</p><button onClick={() => void entries.refetch()} type="button">Try again</button></div>
          ) : visibleEntries.length === 0 ? (
            <EmptyState description={query.trim() ? "Try a different search or scope." : "Morrow will remember useful preferences, project details, and working conventions as you work."} title={query.trim() ? "No matching memory" : "No memory in this scope"} />
          ) : selected ? (
            <>
              <div className="morrow-split-library">
                <section aria-label="Memory library" className="morrow-library">
                  <div aria-label="Filter by scope" className="morrow-library__filters" role="group">
                    <button aria-pressed={scopeFilter === "all"} className="morrow-library__filter" onClick={() => setScopeFilter("all")} type="button">All memory</button>
                    {VAULT_SCOPES.map((scope) => <button aria-pressed={scopeFilter === scope} className="morrow-library__filter" key={scope} onClick={() => setScopeFilter(scope)} type="button">{MEMORY_SCOPE_LABELS[scope] ?? scope}</button>)}
                  </div>
                  <h2 className="morrow-library__group">Remembered context</h2>
                  <ul aria-label="Memory records" className="morrow-library__list">
                    {visibleEntries.map((entry) => (
                      <li key={entry.id}>
                        <button aria-current={entry.id === selected.id ? "true" : undefined} className="morrow-library__row" onClick={() => setSelectedId(entry.id)} type="button">
                          <span aria-hidden="true" className="morrow-library__glyph">{entry.pinned ? "✦" : "◇"}</span>
                          <span><b>{entry.type.replaceAll("_", " ")}</b><p>{entry.content}</p></span>
                          <span className="morrow-library__scope">{MEMORY_SCOPE_LABELS[entry.scope] ?? entry.scope}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
                <aside aria-live="polite" className="morrow-dossier" data-selected="true">
                  <p className="morrow-dossier__tag">Selected memory · {MEMORY_SCOPE_LABELS[selected.scope] ?? selected.scope}</p>
                  <h2>Remembered context</h2>
                  {editingId === selected.id ? (
                    <div className="morrow-memory__editor"><label><span>Edit memory</span><textarea aria-label="Edit memory" onChange={(event) => setEditContent(event.target.value)} value={editContent} /></label><div><button disabled={!editContent.trim() || updateMemory.isPending} onClick={() => updateMemory.mutate({ id: selected.id, projectId: selected.projectId, content: editContent.trim() })} type="button">Save changes</button><button onClick={() => { setEditingId(null); setEditContent(""); }} type="button">Cancel</button></div></div>
                  ) : <div className="morrow-dossier__quote">{selected.content}</div>}
                  <dl className="morrow-dossier__facts">
                    <div className="morrow-dossier__fact"><dt>Scope</dt><dd>{MEMORY_SCOPE_LABELS[selected.scope] ?? selected.scope}</dd></div>
                    <div className="morrow-dossier__fact"><dt>Remembered</dt><dd>{formatRemembered(selected.createdAt)}</dd></div>
                    <div className="morrow-dossier__fact"><dt>Source</dt><dd>{sourceLabel(selected)}</dd></div>
                    <div className="morrow-dossier__fact"><dt>Used</dt><dd>{selected.usageCount} time{selected.usageCount === 1 ? "" : "s"}</dd></div>
                  </dl>
                  <div className="morrow-dossier__trust"><span>✓</span><span>{selected.enabled ? "Approved memory. You control whether Morrow keeps, edits, or forgets it." : "This memory is forgotten and will not be used until you restore it."}</span></div>
                  <button className="morrow-memory__source-toggle" onClick={() => setSourceOpenId(sourceOpenId === selected.id ? null : selected.id)} type="button">{sourceOpenId === selected.id ? "Hide source" : "Why does this exist?"}</button>
                  {sourceOpenId === selected.id ? <dl className="morrow-memory__source"><div><dt>Confidence</dt><dd>{Math.round(selected.confidence * 100)}%</dd></div><div><dt>Lifecycle</dt><dd>{selected.lifecycle}</dd></div><div><dt>Sensitivity</dt><dd>{selected.sensitivity}</dd></div></dl> : null}
                  <div className="morrow-dossier__actions">
                    <Button onClick={() => { setEditingId(selected.id); setEditContent(selected.content); }} variant="secondary">Edit</Button>
                    <Button onClick={() => togglePinned.mutate({ id: selected.id, projectId: selected.projectId, pinned: !selected.pinned })} variant="secondary">{selected.pinned ? "Unpin" : "Pin"}</Button>
                    <Button onClick={() => toggleEnabled.mutate({ id: selected.id, projectId: selected.projectId, enabled: !selected.enabled })} variant="secondary">{selected.enabled ? "Forget" : "Restore"}</Button>
                    <Button onClick={() => forgetForever.mutate({ id: selected.id, projectId: selected.projectId })} variant="danger">Delete permanently</Button>
                  </div>
                </aside>
              </div>
              <aside className="morrow-principle"><b>Memory is a curated private library.</b><span>Every item is readable, traceable, scoped, editable, and under your control.</span></aside>
            </>
          ) : null}
          {updateMemory.isError || toggleEnabled.isError || togglePinned.isError || forgetForever.isError ? <p role="alert">{safeError(updateMemory.error ?? toggleEnabled.error ?? togglePinned.error ?? forgetForever.error, "That change could not be saved.")}</p> : null}
        </>
      )}
    </section>
  );
}
