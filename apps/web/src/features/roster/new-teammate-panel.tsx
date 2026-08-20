import type { AgentRole } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { agentApi, agentKeys } from "../../api/agents.js";
import { ApiClientError } from "../../api/client.js";
import { modelQueries } from "../../api/models.js";
import { TeammateAvatar } from "./teammate-avatar.js";

/**
 * Hiring a teammate.
 *
 * The three things that actually distinguish one teammate from another: a
 * name, the job it holds, and — optionally — the model it thinks with. Tool
 * permissions, memory scopes and budgets are deliberately not here; they have
 * real defaults, and burying a first-run form under them would teach the user
 * that creating a teammate is an administrative act rather than an act of
 * delegation.
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

export interface NewTeammatePanelProps {
  projectId: string;
  onClose: () => void;
  onCreated: (agent: { id: string; name: string }) => void;
}

export function NewTeammatePanel({ projectId, onClose, onCreated }: NewTeammatePanelProps) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<AgentRole>("assistant");
  const [instructions, setInstructions] = useState("");
  // An agent override is a provider+model pair, not a routing preset, so this
  // offers exactly the models that are actually reachable on this install —
  // encoded as "providerId::modelId" because that is the pair the contract
  // stores. "" is the honest default: use whatever the project would.
  const [modelRoute, setModelRoute] = useState("");
  const catalogue = useQuery(modelQueries.catalogue());
  const availableModels = (catalogue.data ?? []).filter((entry) => entry.available);
  const nameRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Escape closes from anywhere inside the panel, and a click outside it
  // dismisses — the panel overlays the workspace, so leaving it open after the
  // user has moved on would obscure the thread they went back to.
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

  const create = useMutation({
    mutationFn: () =>
      agentApi.create(projectId, {
        name: name.trim(),
        role,
        instructions: instructions.trim() || null,
        providerOverride: modelRoute ? modelRoute.split("::")[0]! : null,
        modelOverride: modelRoute ? modelRoute.split("::").slice(1).join("::") : null,
      }),
    onSuccess: (agent) => {
      void queryClient.invalidateQueries({ queryKey: agentKeys.roster(projectId) });
      void queryClient.invalidateQueries({ queryKey: agentKeys.list(projectId) });
      onCreated(agent);
    },
  });

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !create.isPending;
  const roleHint = ROLES.find((entry) => entry.value === role)?.hint ?? "";

  // Portalled to the document body on purpose. The rail is `position: sticky`,
  // which creates a stacking context of its own, so an overlay rendered inside
  // it is trapped beneath the workspace pane no matter what z-index it claims —
  // it looked correct and swallowed every click on its own submit button.
  return createPortal(
    <div className="morrow-new-teammate" ref={panelRef} role="dialog" aria-label="New teammate">
      <form
        className="morrow-new-teammate__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <header className="morrow-new-teammate__head">
          <TeammateAvatar name={trimmedName || "New"} />
          <div>
            <h2>New teammate</h2>
            <p>They get their own thread, their own memory, and their own budget.</p>
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

        {create.isError ? (
          <p className="morrow-new-teammate__error" role="alert">
            {create.error instanceof ApiClientError
              ? create.error.message
              : "Morrow could not create that teammate."}
          </p>
        ) : null}

        <div className="morrow-new-teammate__actions">
          <button className="morrow-new-teammate__cancel" onClick={onClose} type="button">
            Cancel
          </button>
          <button className="morrow-new-teammate__submit" disabled={!canSubmit} type="submit">
            {create.isPending ? "Creating…" : "Create teammate"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
