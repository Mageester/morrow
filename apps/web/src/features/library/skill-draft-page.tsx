import type { SkillDraft } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Surface } from "@morrow/ui";
import { skillDraftApi, skillDraftQueries } from "../../api/skill-drafts.js";

export type SkillDraftPageProps = {
  draftId: string;
  initialDraft?: SkillDraft;
};

function PermissionList({ label, values }: { label: string; values: string[] }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{values.length > 0 ? values.join(", ") : "None"}</dd>
    </div>
  );
}

export function SkillDraftPage({ draftId, initialDraft }: SkillDraftPageProps) {
  const queryClient = useQueryClient();
  const query = useQuery({ ...skillDraftQueries.get(draftId), ...(initialDraft ? { initialData: initialDraft } : {}) });
  const approve = useMutation({
    mutationFn: (input: { override?: boolean; warningAcknowledged?: boolean }) => skillDraftApi.approve(draftId, input),
    onSuccess: (draft) => { queryClient.setQueryData(skillDraftQueries.get(draftId).queryKey, draft); },
  });
  const rollback = useMutation({
    mutationFn: () => skillDraftApi.rollback(draftId, "Rolled back from skill review"),
    onSuccess: ({ draft }) => { queryClient.setQueryData(skillDraftQueries.get(draftId).queryKey, draft); },
  });
  const replay = useMutation({
    mutationFn: (fixtureId: string) => skillDraftApi.replay(draftId, fixtureId),
    onSuccess: (draft) => { queryClient.setQueryData(skillDraftQueries.get(draftId).queryKey, draft); },
  });

  if (query.isPending && !query.data) return <section className="morrow-page"><p>Loading skill draft…</p></section>;
  if (query.isError || !query.data) return <section className="morrow-page"><p>Skill draft unavailable.</p></section>;
  const draft = query.data;
  const needsOverride = draft.validation.replay.successfulRuns < 2;

  return (
    <section aria-labelledby="skill-draft-heading" className="morrow-page">
      <div className="morrow-page__heading">
        <p className="morrow-eyebrow">Review queue · Proven workflow</p>
        <h1 id="skill-draft-heading">{draft.name}</h1>
        <p>{draft.description}</p>
        <p role="status">Status: {draft.lifecycle}</p>
      </div>
      <Surface padding="large">
        <h2>Workflow</h2>
        <p>{draft.triggerDescription}</p>
        <ol>
          {draft.steps.map((step) => <li key={step.id}>{step.description} <code>{step.tool}</code></li>)}
        </ol>
        <h2>Declared permissions</h2>
        <dl>
          <PermissionList label="Tools" values={draft.permissions.tools} />
          <PermissionList label="Filesystem" values={draft.permissions.filesystemScopes} />
          <PermissionList label="Network domains" values={draft.permissions.networkDomains} />
          <PermissionList label="Required secret handles" values={draft.permissions.requiredSecrets} />
        </dl>
        <h2>Evidence and tests</h2>
        <p>Source task: {draft.sourceTaskId}</p>
        {draft.provenance.map((source) => <p key={`${source.taskId}-${source.sourceFingerprint}`}>Verified evidence: {source.evidenceReferences.map((reference) => reference.note ?? reference.reference).join(", ")}</p>)}
        <p>Safety: {draft.validation.safety.status}</p>
        <p>Deterministic replays: {draft.validation.replay.successfulRuns} successful, {draft.validation.replay.failedRuns} failed.</p>
        {needsOverride ? <p role="alert">Activation requires two successful replays, or an explicit user override with a visible warning.</p> : <p>Two successful replays are recorded (deterministic).</p>}
        <div className="morrow-page__actions">
          {draft.replayFixtures.map((fixture) => (
            <button key={fixture.id} disabled={replay.isPending} onClick={() => replay.mutate(fixture.id)} type="button">Replay {fixture.name}</button>
          ))}
          <button
            disabled={approve.isPending || draft.lifecycle === "active" || draft.lifecycle === "rolled_back"}
            onClick={() => approve.mutate(needsOverride ? { override: true, warningAcknowledged: true } : {})}
            type="button"
          >
            {needsOverride ? "Activate with replay override" : "Activate skill"}
          </button>
          <button disabled={rollback.isPending || draft.lifecycle === "rejected" || draft.lifecycle === "rolled_back"} onClick={() => rollback.mutate()} type="button">Rollback skill</button>
        </div>
        {draft.warning ? <p role="alert">Warning: {draft.warning}</p> : null}
        {approve.isError ? <p role="alert">Activation was blocked: {approve.error.message}</p> : null}
      </Surface>
    </section>
  );
}
