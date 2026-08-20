import type { Agent, AgentRole, MemoryScope } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { agentApi, agentKeys, agentQueries, type CreateTeammateInput } from "../../api/agents.js";
import { ApiClientError } from "../../api/client.js";
import { modelQueries } from "../../api/models.js";
import { TeammateMemoryPanel } from "./teammate-memory-panel.js";
import { TeammateAvatar } from "./teammate-avatar.js";

/**
 * The first-run form keeps identity fields prominent. Memory scope policy is
 * behind an explicit disclosure so the default stays simple while a user can
 * still make a teammate's durable context authority understandable and exact.
 */

const ROLES: Array<{ value: AgentRole; label: string; hint: string }> = [
  { value: "assistant", label: "Assistant", hint: "General work across the project." },
  { value: "researcher", label: "Researcher", hint: "Reads and gathers; does not change files." },
  { value: "code-reviewer", label: "Reviewer", hint: "Reads a change and reports on it." },
  { value: "writer", label: "Writer", hint: "Drafts and edits prose." },
  { value: "architect", label: "Architect", hint: "Designs before anything is built." },
  { value: "tester", label: "Tester", hint: "Runs and interprets the suite." },
  { value: "devops", label: "Operations", hint: "Builds, deploys and environments." },
  { value: "security", label: "Security", hint: "Reviews exposure and permissions." },
];

export const TEAMMATE_MEMORY_SCOPE_OPTIONS: Array<{
  scope: MemoryScope;
  label: string;
  description: string;
}> = [
  { scope: "project", label: "Project scope", description: "Durable records kept inside this project." },
  { scope: "agent", label: "Agent scope", description: "Project-local records with no per-teammate owner." },
  { scope: "team", label: "Shared team scope", description: "Project-local records shared by teammates with this scope." },
  { scope: "user_global", label: "Personal scope", description: "Your preferences across local projects." },
];

// Keep the existing least-privilege default: a newly created teammate has no
// memory access until the user opts into a scope here.
const DEFAULT_MEMORY_READ_SCOPES: MemoryScope[] = [];
const DEFAULT_MEMORY_WRITE_SCOPES: MemoryScope[] = [];

export interface NewTeammatePanelProps {
  projectId: string;
  onClose: () => void;
  onCreated?: (agent: { id: string; name: string }) => void;
  agent?: Agent;
  onUpdated?: (agent: Agent) => void;
}

export function NewTeammatePanel({ projectId, onClose, onCreated, agent, onUpdated }: NewTeammatePanelProps) {
  const editing = Boolean(agent);
  const queryClient = useQueryClient();
  const [name, setName] = useState(agent?.name ?? "");
  const [role, setRole] = useState<AgentRole>(agent?.role ?? "assistant");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  // An agent override is a provider+model pair, not a routing preset, so this
  // offers exactly the models that are actually reachable on this install.
  const [modelRoute, setModelRoute] = useState(agent?.providerOverride && agent.modelOverride
    ? `${agent.providerOverride}::${agent.modelOverride}`
    : "");
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [memoryReadScopes, setMemoryReadScopes] = useState<MemoryScope[]>(
    agent?.memoryReadScopes ?? DEFAULT_MEMORY_READ_SCOPES,
  );
  const [memoryWriteScopes, setMemoryWriteScopes] = useState<MemoryScope[]>(
    agent?.memoryWriteScopes ?? DEFAULT_MEMORY_WRITE_SCOPES,
  );
  const [memoryInspectionOpen, setMemoryInspectionOpen] = useState(false);
  const catalogue = useQuery(modelQueries.catalogue());
  const availableModels = (catalogue.data ?? []).filter((entry) => entry.available);
  const nameRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Escape closes from anywhere inside the panel, and a click outside it
  // dismisses — the panel overlays the workspace.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    function onPointerDown(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [onClose]);

  const save = useMutation({
    mutationFn: (): Promise<Agent> => {
      const input: CreateTeammateInput = {
        name: name.trim(),
        role,
        instructions: instructions.trim() || null,
        providerOverride: modelRoute ? modelRoute.split("::")[0]! : null,
        modelOverride: modelRoute ? modelRoute.split("::").slice(1).join("::") : null,
        memoryReadScopes,
        memoryWriteScopes,
      };
      return editing
        ? agentApi.update(agent!.id, projectId, input)
        : agentApi.create(projectId, input);
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.roster(projectId) });
      void queryClient.invalidateQueries({ queryKey: agentKeys.list(projectId) });
      if (editing) onUpdated?.(saved);
      else onCreated?.(saved);
    },
  });

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !save.isPending;
  const roleHint = ROLES.find((entry) => entry.value === role)?.hint ?? "";
  const title = editing ? `Edit teammate ${agent!.name}` : "New teammate";

  // Portalled to the document body because the rail is position: sticky.
  return createPortal(
    <div className="morrow-new-teammate" ref={panelRef} role="dialog" aria-label={title}>
      <form
        className="morrow-new-teammate__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) save.mutate();
        }}
      >
        <header className="morrow-new-teammate__head">
          <TeammateAvatar name={trimmedName || "New"} />
          <div>
            <h2>{editing ? "Edit teammate" : "New teammate"}</h2>
            <p>{editing ? "Update their job, model, and the memory scopes they can use." : "They get their own thread and budget. Add memory access only when this teammate needs it."}</p>
          </div>
        </header>

        <label className="morrow-field">
          <span className="morrow-field__label">Name</span>
          <input
            className="morrow-field__input"
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            placeholder="Research"
            ref={nameRef}
            value={name}
          />
        </label>

        <label className="morrow-field">
          <span className="morrow-field__label">Job</span>
          <select
            className="morrow-field__input"
            onChange={(event) => setRole(event.target.value as AgentRole)}
            value={role}
          >
            {ROLES.map((entry) => (
              <option key={entry.value} value={entry.value}>{entry.label}</option>
            ))}
          </select>
          <span className="morrow-field__hint">{roleHint}</span>
        </label>

        <label className="morrow-field">
          <span className="morrow-field__label">What should they do?</span>
          <textarea
            className="morrow-field__input morrow-field__input--area"
            maxLength={8000}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="Track competitor releases. Summarise anything that changes our roadmap, and cite the source."
            rows={4}
            value={instructions}
          />
          <span className="morrow-field__hint">
            Optional. This becomes their standing instructions on every turn.
          </span>
        </label>

        <label className="morrow-field">
          <span className="morrow-field__label">Model</span>
          <select
            className="morrow-field__input"
            onChange={(event) => setModelRoute(event.target.value)}
            value={modelRoute}
          >
            <option value="">Project default</option>
            {availableModels.map((entry) => (
              <option
                key={`${entry.model.providerId}::${entry.model.id}`}
                value={`${entry.model.providerId}::${entry.model.id}`}
              >
                {entry.model.label} · {entry.model.providerId}
              </option>
            ))}
          </select>
          <span className="morrow-field__hint">
            {catalogue.isPending
              ? "Reading the model catalogue…"
              : availableModels.length === 0
                ? "No provider is configured yet, so this teammate will use the project default."
                : "Optional. Leave on the project default unless this job needs a specific model."}
          </span>
        </label>

        <section className="morrow-field" aria-label="Memory scope settings">
          <button
            aria-controls="teammate-memory-scopes"
            aria-expanded={memoryOpen}
            onClick={() => setMemoryOpen((open) => !open)}
            type="button"
          >
            Memory access {memoryOpen ? "(hide)" : "(advanced)"}
          </button>
          {memoryOpen ? (
            <fieldset aria-label="Memory access" id="teammate-memory-scopes">
              <legend>Memory access</legend>
              <p>No memory scope is granted until you choose one. These are durable scope permissions, not transcript history. Agent and Shared team records are project-local and have no per-teammate owner; Personal scope can cross projects.</p>
              <div>
                <strong>Can read</strong>
                {TEAMMATE_MEMORY_SCOPE_OPTIONS.map((option) => (
                  <label key={`read-${option.scope}`}>
                    <input
                      aria-label={`Read ${option.label}`}
                      checked={memoryReadScopes.includes(option.scope)}
                      onChange={(event) => setMemoryReadScopes((current) => event.target.checked
                        ? [...current, option.scope]
                        : current.filter((scope) => scope !== option.scope))}
                      type="checkbox"
                    />
                    <span>{option.label}</span>
                    <small>{option.description}</small>
                  </label>
                ))}
              </div>
              <div>
                <strong>Can write</strong>
                {TEAMMATE_MEMORY_SCOPE_OPTIONS.map((option) => (
                  <label key={`write-${option.scope}`}>
                    <input
                      aria-label={`Write ${option.label}`}
                      checked={memoryWriteScopes.includes(option.scope)}
                      onChange={(event) => setMemoryWriteScopes((current) => event.target.checked
                        ? [...current, option.scope]
                        : current.filter((scope) => scope !== option.scope))}
                      type="checkbox"
                    />
                    <span>{option.label}</span>
                    <small>{option.description}</small>
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
        </section>

        {editing ? (
          <section className="morrow-field" aria-label="Scoped memory inspection">
            <button
              aria-controls="teammate-memory-panel"
              aria-expanded={memoryInspectionOpen}
              onClick={() => setMemoryInspectionOpen((open) => !open)}
              type="button"
            >
              {memoryInspectionOpen ? "Hide scoped memory" : "Inspect scoped memory"}
            </button>
            {memoryInspectionOpen ? <TeammateMemoryPanel agent={agent!} projectId={projectId} /> : null}
          </section>
        ) : null}

        {save.isError ? (
          <p className="morrow-new-teammate__error" role="alert">
            {save.error instanceof ApiClientError
              ? save.error.message
              : editing ? "Morrow could not save that teammate." : "Morrow could not create that teammate."}
          </p>
        ) : null}

        <div className="morrow-new-teammate__actions">
          <button className="morrow-new-teammate__cancel" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="morrow-new-teammate__submit" disabled={!canSubmit} type="submit">
            {save.isPending ? (editing ? "Saving…" : "Creating…") : (editing ? "Save teammate" : "Create teammate")}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

export interface EditTeammatePanelProps {
  projectId: string;
  agentId: string;
  onClose: () => void;
  onUpdated?: (agent: Agent) => void;
}

/** Fetches the authoritative policy before opening an edit form. */
export function EditTeammatePanel({ projectId, agentId, onClose, onUpdated }: EditTeammatePanelProps) {
  const detail = useQuery(agentQueries.detail(projectId, agentId));
  if (detail.isPending) {
    return createPortal(
      <div className="morrow-new-teammate" role="dialog" aria-label="Edit teammate">
        <div className="morrow-new-teammate__form">
          <p aria-live="polite" role="status">Reading teammate settings…</p>
          <button className="morrow-new-teammate__cancel" onClick={onClose} type="button">Cancel</button>
        </div>
      </div>,
      document.body,
    );
  }
  if (detail.isError || !detail.data || detail.data.projectId !== projectId) {
    return createPortal(
      <div className="morrow-new-teammate" role="dialog" aria-label="Edit teammate">
        <div className="morrow-new-teammate__form">
          <p role="alert">Teammate settings could not be loaded.</p>
          <div className="morrow-new-teammate__actions">
            <button className="morrow-new-teammate__cancel" onClick={onClose} type="button">Cancel</button>
            <button className="morrow-new-teammate__submit" onClick={() => void detail.refetch()} type="button">Try again</button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }
  return (
    <NewTeammatePanel
      agent={detail.data}
      onClose={onClose}
      {...(onUpdated ? { onUpdated } : {})}
      projectId={projectId}
    />
  );
}
