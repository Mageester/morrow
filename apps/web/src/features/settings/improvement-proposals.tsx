import type { ImprovementProposal } from "@morrow/contracts";
import { Button, Surface } from "@morrow/ui";

export interface ImprovementProposalsProps {
  proposals?: readonly ImprovementProposal[];
  onApprove?: (proposalId: string) => void;
  onReject?: (proposalId: string) => void;
  onRollback?: (proposalId: string) => void;
}

function stateLabel(proposal: ImprovementProposal): string {
  if (proposal.rolloutState === "proposed" && !proposal.evaluation) return "Awaiting evaluation";
  return proposal.rolloutState.replace("_", " ");
}

function evaluationLabel(proposal: ImprovementProposal): string {
  if (!proposal.evaluation) return "No shadow-fixture result recorded yet.";
  return proposal.evaluation.promotable
    ? `Shadow test passed: ${proposal.evaluation.reason}`
    : `Shadow test blocked promotion: ${proposal.evaluation.reason}`;
}

export function ImprovementProposals({ proposals = [], onApprove, onReject, onRollback }: ImprovementProposalsProps) {
  return (
    <Surface aria-labelledby="improvement-proposals-heading" padding="large" style={{ display: "grid", gap: "var(--morrow-space-4)" }}>
      <div>
        <p className="morrow-eyebrow">Inspect before activation</p>
        <h2 id="improvement-proposals-heading" style={{ margin: 0 }}>Harness improvements</h2>
        <p style={{ marginBottom: 0, color: "var(--morrow-text-muted)", fontSize: "0.875rem" }}>
          Morrow only proposes efficiency changes from durable task and benchmark evidence. Changes are tested in shadow fixtures and never self-approved.
        </p>
      </div>

      {proposals.length === 0 ? (
        <p role="status" style={{ margin: 0, color: "var(--morrow-text-muted)" }}>
          No improvement proposals are waiting for review.
        </p>
      ) : (
        <div style={{ display: "grid", gap: "var(--morrow-space-3)" }}>
          {proposals.map((proposal) => {
            const canApprove = proposal.rolloutState === "evaluated" && proposal.evaluation?.promotable === true;
            return (
              <article key={proposal.id} aria-labelledby={`${proposal.id}-heading`} style={{ border: "1px solid var(--morrow-border-subtle)", borderRadius: "var(--morrow-radius-sm)", padding: "var(--morrow-space-3)", display: "grid", gap: "var(--morrow-space-2)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--morrow-space-2)", alignItems: "baseline" }}>
                  <h3 id={`${proposal.id}-heading`} style={{ margin: 0 }}>{proposal.proposedChange.description}</h3>
                  <span aria-label={`Rollout state: ${stateLabel(proposal)}`} style={{ color: "var(--morrow-text-muted)", fontSize: "0.8125rem" }}>{stateLabel(proposal)}</span>
                </div>
                <p style={{ margin: 0 }}>{proposal.observedProblem}</p>
                <dl style={{ display: "grid", gap: "var(--morrow-space-1)", margin: 0, fontSize: "0.875rem" }}>
                  <div><dt style={{ display: "inline", fontWeight: 600 }}>Evidence tasks: </dt><dd style={{ display: "inline", margin: 0 }}>{proposal.evidenceTaskIds.join(", ")}</dd></div>
                  <div><dt style={{ display: "inline", fontWeight: 600 }}>Benchmark fixtures: </dt><dd style={{ display: "inline", margin: 0 }}>{proposal.benchmarkFixtureIds.join(", ")}</dd></div>
                  <div><dt style={{ display: "inline", fontWeight: 600 }}>Expected effect: </dt><dd style={{ display: "inline", margin: 0 }}>{proposal.expectedEffect.metric} {proposal.expectedEffect.baseline ?? "unknown"} → {proposal.expectedEffect.target ?? "unknown"}</dd></div>
                  <div><dt style={{ display: "inline", fontWeight: 600 }}>Privacy impact: </dt><dd style={{ display: "inline", margin: 0 }}>{proposal.privacyImpact.summary}</dd></div>
                  {proposal.rollbackReference ? <div><dt style={{ display: "inline", fontWeight: 600 }}>Rollback reference: </dt><dd style={{ display: "inline", margin: 0 }}>{proposal.rollbackReference}</dd></div> : null}
                </dl>
                <p role="status" style={{ margin: 0, color: "var(--morrow-text-muted)", fontSize: "0.875rem" }}>{evaluationLabel(proposal)}</p>
                <div style={{ display: "flex", gap: "var(--morrow-space-2)", flexWrap: "wrap" }}>
                  <Button disabled={!canApprove} onClick={() => onApprove?.(proposal.id)} size="compact">Approve</Button>
                  <Button disabled={proposal.rolloutState === "rolled_back"} onClick={() => onReject?.(proposal.id)} size="compact" variant="secondary">Reject</Button>
                  <Button disabled={proposal.rolloutState !== "approved"} onClick={() => onRollback?.(proposal.id)} size="compact" variant="secondary">Rollback</Button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </Surface>
  );
}
