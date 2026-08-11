import { useState } from "react";
import type { ApproveMemoryCandidateInput, EditMemoryCandidateInput, MemoryCandidate } from "@morrow/contracts";

export type MemoryCandidateCardProps = {
  candidate: MemoryCandidate;
  onApprove?: (input: ApproveMemoryCandidateInput) => void;
  onEdit?: (input: EditMemoryCandidateInput) => void;
  onReject?: (id: string) => void;
  onForget?: (id: string) => void;
};

const scopes = ["user_global", "project", "conversation", "agent", "team"] as const;

export function MemoryCandidateCard({ candidate, onApprove, onEdit, onReject, onForget }: MemoryCandidateCardProps) {
  const [scope, setScope] = useState<typeof scopes[number]>(candidate.proposedScope as typeof scopes[number]);
  const [expiresAt, setExpiresAt] = useState(candidate.expiresAt);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(candidate.content);
  const source = candidate.evidenceReferences[0];

  return (
    <article className="memory-candidate-card" data-candidate-id={candidate.id}>
      <header>
        <p className="memory-candidate-card__eyebrow">Memory review</p>
        <h2>What Morrow wants to remember</h2>
      </header>
      {editing ? (
        <textarea aria-label="Candidate memory" value={content} onChange={(event) => setContent(event.target.value)} />
      ) : (
        <p className="memory-candidate-card__content">{candidate.content}</p>
      )}
      {editing ? (
        <div className="memory-candidate-card__edit-actions">
          <button type="button" onClick={() => { onEdit?.({ content }); setEditing(false); }}>Save edit</button>
          <button type="button" onClick={() => { setContent(candidate.content); setEditing(false); }}>Cancel</button>
        </div>
      ) : null}
      <dl>
        <dt>Why</dt>
        <dd>{source?.label ?? source?.kind ?? "Task evidence"}</dd>
        <dt>Scope</dt>
        <dd>
          <select aria-label="Memory scope" value={scope} onChange={(event) => setScope(event.target.value as typeof scope)}>
            {scopes.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </dd>
        <dt>Expires</dt>
        <dd>
          <span>Expires: {expiresAt ? new Date(expiresAt).toLocaleDateString() : candidate.expirationPolicy}</span>
          <input aria-label="Expiration date" type="date" value={expiresAt ? expiresAt.slice(0, 10) : ""} onChange={(event) => setExpiresAt(event.target.value ? `${event.target.value}T23:59:59.000Z` : null)} />
        </dd>
        <dt>Source</dt>
        <dd>{source?.id ?? candidate.originatingTaskId ?? "Local task"}</dd>
      </dl>
      <footer>
        <button type="button" onClick={() => setEditing(true)}>Edit</button>
        <button type="button" onClick={() => onApprove?.({ scope, expiresAt })}>Save</button>
        <button type="button" onClick={() => onReject?.(candidate.id)}>Reject</button>
        <button type="button" onClick={() => onForget?.(candidate.id)}>Never use</button>
      </footer>
    </article>
  );
}
