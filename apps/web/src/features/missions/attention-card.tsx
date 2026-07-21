import {
  ResolveWebAttentionSchema,
  type ResolveWebAttentionInput,
  type WebAttentionRequest,
  type WebMissionSnapshot,
} from "@morrow/contracts";
import { Button } from "@morrow/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { resolveMissionAttention } from "../../api/attention.js";
import { missionKeys } from "../../api/query-keys.js";
import { ActionableErrorCard } from "../../app/error-boundary.js";

const kindLabels: Record<WebAttentionRequest["kind"], string> = {
  approval: "Waiting for your approval",
  blocker: "External blocker",
  connection: "Connection required",
  decision: "Decision needed",
};

type WebAttentionChoice = WebAttentionRequest["choices"][number];

function isNewerSnapshot(
  current: WebMissionSnapshot | undefined,
  incoming: WebMissionSnapshot,
): boolean {
  if (!current) return false;
  const currentCursor = Math.max(
    0,
    ...current.recentActivity.map((activity) => activity.cursor),
  );
  const incomingCursor = Math.max(
    0,
    ...incoming.recentActivity.map((activity) => activity.cursor),
  );
  if (currentCursor !== incomingCursor) return currentCursor > incomingCursor;
  return (
    Date.parse(current.summary.updatedAt) > Date.parse(incoming.summary.updatedAt)
  );
}

interface ConfirmationDialogProps {
  choice: WebAttentionChoice;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmationDialog({
  choice,
  onCancel,
  onConfirm,
}: ConfirmationDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;

    const target = event.target;
    if (event.shiftKey && target === cancelRef.current) {
      event.preventDefault();
      confirmRef.current?.focus();
    } else if (!event.shiftKey && target === confirmRef.current) {
      event.preventDefault();
      cancelRef.current?.focus();
    }
  };

  return (
    <div className="morrow-attention-dialog-backdrop">
      <div
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="morrow-attention-dialog"
        onKeyDown={handleKeyDown}
        role="alertdialog"
      >
        <h4 id={titleId}>Confirm {choice.label.toLowerCase()}</h4>
        <p id={descriptionId}>
          {choice.description ??
            "Morrow did not provide additional consequences for this destructive choice."}
        </p>
        <div className="morrow-attention-dialog__actions">
          <Button onClick={onCancel} ref={cancelRef} variant="secondary">
            Cancel
          </Button>
          <Button onClick={onConfirm} ref={confirmRef} variant="danger">
            Confirm {choice.label.toLowerCase()}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function AttentionCard({
  missionId,
  request,
}: {
  missionId: string;
  request: WebAttentionRequest;
}) {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [confirmation, setConfirmation] =
    useState<WebAttentionChoice | null>(null);
  const [failedInput, setFailedInput] =
    useState<ResolveWebAttentionInput | null>(null);
  const choiceRefs = useRef(new Map<string, HTMLButtonElement>());
  const confirmationSubmitting = useRef(false);
  const submissionPending = useRef(false);
  const choicesId = useId();
  const noteId = useId();

  const mutation = useMutation({
    mutationFn: (input: ResolveWebAttentionInput) =>
      resolveMissionAttention(missionId, request.id, input),
    onError: (_error, input) => {
      setFailedInput(input);
    },
    onSuccess: (resolved) => {
      setFailedInput(null);
      queryClient.setQueryData<WebMissionSnapshot>(
        missionKeys.detail(missionId),
        (current) => (isNewerSnapshot(current, resolved) ? current : resolved),
      );
      void queryClient.invalidateQueries({ queryKey: missionKeys.all });
    },
    onSettled: () => {
      submissionPending.current = false;
      confirmationSubmitting.current = false;
    },
  });

  const closeConfirmation = (restoreFocus = true) => {
    const choiceId = confirmation?.id;
    setConfirmation(null);
    if (restoreFocus && choiceId) choiceRefs.current.get(choiceId)?.focus();
  };

  const submit = (choice: WebAttentionChoice, retryInput?: ResolveWebAttentionInput) => {
    if (submissionPending.current) return;
    submissionPending.current = true;
    mutation.reset();

    const trimmedNote = note.trim();
    const input = ResolveWebAttentionSchema.parse(
      retryInput ?? {
        choiceId: choice.id,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      },
    );
    mutation.mutate(input);
  };

  const selectChoice = (choice: WebAttentionChoice) => {
    if (submissionPending.current) return;
    if (choice.destructive) {
      confirmationSubmitting.current = false;
      setConfirmation(choice);
      return;
    }
    submit(choice);
  };

  const confirmChoice = () => {
    if (!confirmation || confirmationSubmitting.current) return;
    confirmationSubmitting.current = true;
    const choice = confirmation;
    closeConfirmation();
    submit(choice);
  };

  if (request.missionId !== missionId) {
    return (
      <article className="morrow-attention-card morrow-attention-card--inert">
        <h3>Attention request unavailable</h3>
        <p>
          Morrow could not verify this request against the current mission. No
          decision can be sent from this page.
        </p>
      </article>
    );
  }

  return (
    <article className="morrow-attention-card" data-kind={request.kind}>
      <h3 className="morrow-attention-card__kind">
        {kindLabels[request.kind]}
      </h3>
      <dl className="morrow-attention-card__contract">
        <div>
          <dt>What happened</dt>
          <dd>{request.title}</dd>
        </div>
        <div>
          <dt>Why this matters</dt>
          <dd>{request.explanation}</dd>
        </div>
        <div>
          <dt>Morrow&apos;s recommendation</dt>
          <dd>
            {request.recommendation ??
              "Morrow did not provide a recommendation for this request."}
          </dd>
        </div>
        <div>
          <dt>Unrelated work</dt>
          <dd>
            {request.canContinueElsewhere
              ? "Unrelated work can continue while this request waits."
              : "Unrelated work cannot continue until this request is resolved."}
          </dd>
        </div>
      </dl>

      {request.choices.length > 0 ? (
        <>
          <div className="morrow-attention-card__note">
            <label htmlFor={noteId}>Decision note (optional)</label>
            <textarea
              disabled={mutation.isPending}
              id={noteId}
              maxLength={1000}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Add context for the durable decision. Do not include credentials."
              rows={3}
              value={note}
            />
          </div>
          <div
            aria-labelledby={choicesId}
            className="morrow-attention-card__choices"
            role="group"
          >
            <h4 id={choicesId}>Choices and consequences</h4>
            {request.choices.map((choice, index) => {
              const consequenceId = `${choicesId}-choice-${index}`;
              return (
                <div
                  className="morrow-attention-choice"
                  key={`${choice.id}-${index}`}
                >
                  <Button
                    aria-describedby={consequenceId}
                    data-recommended={choice.recommended ? "true" : "false"}
                    disabled={mutation.isPending}
                    onClick={() => selectChoice(choice)}
                    ref={(node) => {
                      if (node) choiceRefs.current.set(choice.id, node);
                      else choiceRefs.current.delete(choice.id);
                    }}
                    variant={
                      choice.destructive
                        ? "danger"
                        : choice.recommended
                          ? "primary"
                          : "secondary"
                    }
                  >
                    {choice.label}
                    {choice.recommended ? (
                      <span className="morrow-attention-choice__recommended">
                        Recommended
                      </span>
                    ) : null}
                  </Button>
                  <p id={consequenceId}>
                    {choice.description ??
                      "No additional consequence was provided."}
                  </p>
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <p className="morrow-attention-card__no-choice">
          No safe choice was provided for this request. Review the mission
          activity or required connection before continuing.
        </p>
      )}

      {mutation.isPending ? (
        <p aria-live="polite" role="status">
          Submitting this decision…
        </p>
      ) : null}

      {mutation.isError ? (
        <ActionableErrorCard
          error={mutation.error}
          onDiagnostics={() => {
            void queryClient.invalidateQueries({
              queryKey: missionKeys.detail(missionId),
            });
          }}
          onRetry={() => {
            const choice = request.choices.find(
              (candidate) => candidate.id === failedInput?.choiceId,
            );
            if (choice && failedInput) submit(choice, failedInput);
          }}
          retryLabel="Retry decision"
        />
      ) : null}

      {confirmation ? (
        <ConfirmationDialog
          choice={confirmation}
          onCancel={() => closeConfirmation()}
          onConfirm={confirmChoice}
        />
      ) : null}
    </article>
  );
}
