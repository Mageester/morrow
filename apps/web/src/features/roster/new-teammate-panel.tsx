import type { Agent, AgentRole, AgentToolPermission, MemoryScope } from "@morrow/contracts";
import { TeammateTrustSection } from "./teammate-trust-section.js";
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
const ASK_TEAMMATE_TOOL_NAME = "ask_teammate";

function effectiveAskTeammatePermission(permissions: AgentToolPermission[]): boolean {
  const ask = permissions.find((permission) => permission.toolName === ASK_TEAMMATE_TOOL_NAME);
  if (ask?.effect === "deny") return false;
  if (ask?.effect === "allow") return true;
  // The absence of any allow rows is the legacy unrestricted policy. Keep its
  // existing default visible instead of turning a checked box into a singleton
  // allow-list that silently removes every other tool.
  return !permissions.some((permission) => permission.effect === "allow");
}

async function syncAskTeammatePermission(agentId: string, projectId: string, permissions: AgentToolPermission[], allowed: boolean): Promise<void> {
  const existing = permissions.find((permission) => permission.toolName === ASK_TEAMMATE_TOOL_NAME);
  const hasAllowList = permissions.some((permission) => permission.effect === "allow");
  if (allowed) {
    if (hasAllowList) {
      if (existing?.effect !== "allow") await agentApi.setToolPermission(agentId, projectId, { toolName: ASK_TEAMMATE_TOOL_NAME, effect: "allow", priority: 10 });
    } else if (existing?.effect === "deny") {
      // Removing a deny restores the unrestricted legacy policy. An allow row
      // here would accidentally turn every other tool off.
      await agentApi.deleteToolPermission(agentId, projectId, ASK_TEAMMATE_TOOL_NAME);
    }
    return;
  }
  if (hasAllowList) {
    // In an explicit allow-list, absence already means denied. Remove only a
    // stale ask allow row so the rest of the list remains untouched.
    if (existing?.effect === "allow") {
      if (permissions.filter((permission) => permission.effect === "allow").length === 1) {
        throw new Error("This is the only explicit allow rule; clearing it would restore unrestricted tools. Add another allow rule or keep Ask other teammates enabled.");
      }
      await agentApi.deleteToolPermission(agentId, projectId, ASK_TEAMMATE_TOOL_NAME);
    }
  } else if (existing?.effect !== "deny") {
    await agentApi.setToolPermission(agentId, projectId, { toolName: ASK_TEAMMATE_TOOL_NAME, effect: "deny", priority: 10 });
  }
}

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
  const [coordinationOpen, setCoordinationOpen] = useState(false);
  const [askTeammateAllowed, setAskTeammateAllowed] = useState(true);
  const catalogue = useQuery(modelQueries.catalogue());
  const toolPermissions = useQuery({
    ...agentQueries.toolPermissions(projectId, agent?.id ?? ""),
    enabled: editing,
  });
  const availableModels = (catalogue.data ?? []).filter((entry) => entry.available);
  const nameRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (toolPermissions.data) setAskTeammateAllowed(effectiveAskTeammatePermission(toolPermissions.data));
  }, [toolPermissions.data]);

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
    mutationFn: async (): Promise<Agent> => {
      const input: CreateTeammateInput = {
        name: name.trim(),
        role,
        instructions: instructions.trim() || null,
        providerOverride: modelRoute ? modelRoute.split("::")[0]! : null,
        modelOverride: modelRoute ? modelRoute.split("::").slice(1).join("::") : null,
        memoryReadScopes,
        memoryWriteScopes,
      };
      if (editing) await syncAskTeammatePermission(agent!.id, projectId, toolPermissions.data ?? [], askTeammateAllowed);
      const resolved = await (editing
        ? agentApi.update(agent!.id, projectId, input)
        : agentApi.create(projectId, input));
      if (!editing) await syncAskTeammatePermission(resolved.id, projectId, toolPermissions.data ?? [], askTeammateAllowed);
      return resolved;
    },
    onSuccess: (saved) => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.roster(projectId) });
      void queryClient.invalidateQueries({ queryKey: agentKeys.list(projectId) });
      void queryClient.invalidateQueries({ queryKey: agentQueries.toolPermissions(projectId, saved.id).queryKey });
      if (editing) onUpdated?.(saved);
      else onCreated?.(saved);
    },
  });

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !save.isPending && (!editing || toolPermissions.data !== undefined);
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

        <section className="morrow-field" aria-label="Coordination access settings">
          <button
            aria-controls="teammate-coordination-access"
            aria-expanded={coordinationOpen}
            onClick={() => setCoordinationOpen((open) => !open)}
            type="button"
          >
            Coordination access {coordinationOpen ? "(hide)" : "(advanced)"}
          </button>
          {coordinationOpen ? (
            <fieldset aria-label="Coordination access" id="teammate-coordination-access">
              <legend>Coordination access</legend>
              {editing && toolPermissions.isPending ? <p role="status">Reading teammate tool permissions…</p> : null}
              {toolPermissions.isError ? <p role="alert">Teammate tool permissions could not be loaded. Reload before changing access.</p> : null}
              {agent?.teamId ? <p>Team teammates use the team delegation flow; direct ask teammate access is unavailable here.</p> : null}
              {!agent?.teamId && (!editing || (!toolPermissions.isPending && !toolPermissions.isError)) ? (
                <label>
                  <input
                    aria-label="Ask other teammates"
                    checked={askTeammateAllowed}
                    onChange={(event) => setAskTeammateAllowed(event.target.checked)}
                    type="checkbox"
                  />
                  <span>Ask other teammates</span>
                  <small>Lets this named teammate hand one bounded task to another enabled standalone teammate. Each request pauses for your approval unless you allow the pair below.</small>
                </label>
              ) : null}
              {editing && agent && !agent.teamId && askTeammateAllowed && !toolPermissions.isPending && !toolPermissions.isError ? (
                <TeammateTrustSection agentId={agent.id} agentName={agent.name} projectId={projectId} />
              ) : null}
              {!agent?.teamId && (!editing || (!toolPermissions.isPending && !toolPermissions.isError)) ? (
                <small>Profiles with no explicit tool allow-list retain the existing default unless you clear this box; adding it to an allow-list changes only this capability.</small>
              ) : null}
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
