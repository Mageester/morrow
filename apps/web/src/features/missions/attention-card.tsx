import {
  ResolveWebAttentionSchema,
  type ResolveWebAttentionInput,
  type WebAttentionRequest,
  type WebMissionSnapshot,
} from "@morrow/contracts";
import { Button } from "@morrow/ui";
import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  readAuthoritativeMission,
  resolveMissionAttention,
} from "../../api/attention.js";
import { missionKeys } from "../../api/query-keys.js";
import { ActionableErrorCard } from "../../app/error-boundary.js";

const kindLabels: Record<WebAttentionRequest["kind"], string> = {
  approval: "Waiting for your approval",
  blocker: "External blocker",
  connection: "Connection required",
  decision: "Decision needed",
};

type WebAttentionChoice = WebAttentionRequest["choices"][number];

interface MissionCacheGeneration {
  dataUpdateCount: number;
  query: object | undefined;
}

interface AttentionResolutionOperation {
  attentionId: string;
  cacheGeneration: MissionCacheGeneration;
  generation: number;
}

interface MissionResolutionState {
  active: AttentionResolutionOperation | null;
  listeners: Set<() => void>;
  nextGeneration: number;
}

const resolutionStates = new WeakMap<
  QueryClient,
  Map<string, MissionResolutionState>
>();

function missionResolutionState(
  queryClient: QueryClient,
  missionId: string,
): MissionResolutionState {
  let missions = resolutionStates.get(queryClient);
  if (!missions) {
    missions = new Map();
    resolutionStates.set(queryClient, missions);
  }
  let state = missions.get(missionId);
  if (!state) {
    state = { active: null, listeners: new Set(), nextGeneration: 0 };
    missions.set(missionId, state);
  }
  return state;
}

function missionCacheGeneration(
  queryClient: QueryClient,
  missionId: string,
): MissionCacheGeneration {
  const query = queryClient.getQueryCache().find({
    exact: true,
    queryKey: missionKeys.detail(missionId),
  });
  return {
    dataUpdateCount: query?.state.dataUpdateCount ?? 0,
    query,
  };
}

function notifyResolutionState(state: MissionResolutionState): void {
  for (const listener of state.listeners) listener();
}

interface AttentionResolutionContextValue {
  acquire: (attentionId: string) => AttentionResolutionOperation | null;
  activeAttentionId: string | null;
  commitSnapshot: (
    operation: AttentionResolutionOperation,
    snapshot: WebMissionSnapshot,
  ) => boolean;
  missionId: string;
  release: (operation: AttentionResolutionOperation) => void;
}

const AttentionResolutionContext =
  createContext<AttentionResolutionContextValue | null>(null);

export function AttentionResolutionCoordinator({
  children,
  missionId,
}: {
  children: ReactNode;
  missionId: string;
}) {
  const queryClient = useQueryClient();
  const state = useMemo(
    () => missionResolutionState(queryClient, missionId),
    [missionId, queryClient],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    [state],
  );
  const getSnapshot = useCallback(() => state.active, [state]);
  const activeOperation = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );

  const acquire = useCallback((attentionId: string) => {
    if (state.active !== null) return null;
    state.nextGeneration += 1;
    const operation = {
      attentionId,
      cacheGeneration: missionCacheGeneration(queryClient, missionId),
      generation: state.nextGeneration,
    };
    state.active = operation;
    notifyResolutionState(state);
    return operation;
  }, [missionId, queryClient, state]);

  const commitSnapshot = useCallback(
    (
      operation: AttentionResolutionOperation,
      snapshot: WebMissionSnapshot,
    ) => {
      if (state.active?.generation !== operation.generation) return false;
      const current = missionCacheGeneration(queryClient, missionId);
      if (
        current.query !== operation.cacheGeneration.query ||
        current.dataUpdateCount !== operation.cacheGeneration.dataUpdateCount
      ) {
        return false;
      }
      queryClient.setQueryData<WebMissionSnapshot>(
        missionKeys.detail(missionId),
        snapshot,
      );
      return true;
    },
    [missionId, queryClient, state],
  );

  const release = useCallback(
    (operation: AttentionResolutionOperation) => {
      if (state.active?.generation !== operation.generation) return;
      state.active = null;
      notifyResolutionState(state);
    },
    [state],
  );

  const value = useMemo(
    () => ({
      acquire,
      activeAttentionId: activeOperation?.attentionId ?? null,
      commitSnapshot,
      missionId,
      release,
    }),
    [acquire, activeOperation, commitSnapshot, missionId, release],
  );

  return (
    <AttentionResolutionContext.Provider value={value}>
      {children}
    </AttentionResolutionContext.Provider>
  );
}

function useAttentionResolution(missionId: string) {
  const coordinator = useContext(AttentionResolutionContext);
  if (!coordinator || coordinator.missionId !== missionId) {
    throw new Error(
      "AttentionCard must be rendered inside its mission attention coordinator.",
    );
  }
  return coordinator;
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
  const resolution = useAttentionResolution(missionId);
  const [note, setNote] = useState("");
  const [confirmation, setConfirmation] =
    useState<WebAttentionChoice | null>(null);
  const [failedInput, setFailedInput] =
    useState<ResolveWebAttentionInput | null>(null);
  const [refreshError, setRefreshError] = useState<unknown | null>(null);
  const [refreshPending, setRefreshPending] = useState(false);
  const [resolutionConfirmed, setResolutionConfirmed] = useState(false);
  const choiceRefs = useRef(new Map<string, HTMLButtonElement>());
  const confirmationSubmitting = useRef(false);
  const submissionPending = useRef(false);
  const choicesId = useId();
  const noteId = useId();

  const mutation = useMutation({
    mutationFn: ({ input }: {
      input: ResolveWebAttentionInput;
      operation: AttentionResolutionOperation;
    }) => resolveMissionAttention(missionId, request.id, input),
    onError: (_error, submission) => {
      setFailedInput(submission.input);
    },
    onSuccess: (resolved, submission) => {
      setFailedInput(null);
      setRefreshError(null);
      resolution.commitSnapshot(submission.operation, resolved);
      void queryClient.invalidateQueries({
        queryKey: missionKeys.all,
        refetchType: "none",
      });
    },
    onSettled: (_resolved, _error, submission) => {
      submissionPending.current = false;
      confirmationSubmitting.current = false;
      resolution.release(submission.operation);
    },
  });

  const closeConfirmation = (restoreFocus = true) => {
    const choiceId = confirmation?.id;
    setConfirmation(null);
    if (restoreFocus && choiceId) choiceRefs.current.get(choiceId)?.focus();
  };

  const submit = (choice: WebAttentionChoice) => {
    if (submissionPending.current || resolution.activeAttentionId !== null) {
      return;
    }
    const trimmedNote = note.trim();
    const input = ResolveWebAttentionSchema.parse(
      {
        choiceId: choice.id,
        ...(trimmedNote ? { note: trimmedNote } : {}),
      },
    );
    const operation = resolution.acquire(request.id);
    if (!operation) return;
    submissionPending.current = true;
    mutation.reset();
    setRefreshError(null);
    mutation.mutate({ input, operation });
  };

  const selectChoice = (choice: WebAttentionChoice) => {
    if (submissionPending.current || resolution.activeAttentionId !== null) {
      return;
    }
    if (choice.destructive) {
      confirmationSubmitting.current = false;
      setConfirmation(choice);
      return;
    }
    submit(choice);
  };

  const confirmChoice = () => {
    if (
      !confirmation ||
      confirmationSubmitting.current ||
      resolution.activeAttentionId !== null
    ) {
      return;
    }
    confirmationSubmitting.current = true;
    const choice = confirmation;
    closeConfirmation();
    submit(choice);
  };

  const refreshAfterFailure = async () => {
    if (
      submissionPending.current ||
      refreshPending ||
      resolution.activeAttentionId !== null
    ) {
      return;
    }
    const operation = resolution.acquire(request.id);
    if (!operation) return;
    submissionPending.current = true;
    setRefreshPending(true);
    setRefreshError(null);

    try {
      const authoritative = await readAuthoritativeMission(missionId);
      const committed = resolution.commitSnapshot(operation, authoritative);
      await queryClient.invalidateQueries({
        queryKey: missionKeys.all,
        refetchType: "none",
      });

      const effectiveSnapshot = committed
        ? authoritative
        : queryClient.getQueryData<WebMissionSnapshot>(
            missionKeys.detail(missionId),
          );
      if (!effectiveSnapshot) {
        throw new Error("Authoritative mission state changed during refresh.");
      }

      const pendingRequest = effectiveSnapshot.attention.find(
        (candidate) => candidate.id === request.id,
      );
      mutation.reset();
      setFailedInput(null);
      if (!pendingRequest) {
        closeConfirmation(false);
        setResolutionConfirmed(true);
        return;
      }

      const failedChoice = pendingRequest.choices.find(
        (candidate) => candidate.id === failedInput?.choiceId,
      );
      if (failedChoice?.destructive) {
        setConfirmation(failedChoice);
      }
    } catch (error: unknown) {
      setRefreshError(error);
    } finally {
      submissionPending.current = false;
      setRefreshPending(false);
      resolution.release(operation);
    }
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

  if (resolutionConfirmed) {
    return (
      <article className="morrow-attention-card" data-kind={request.kind}>
        <h3>Attention request refreshed</h3>
        <p aria-live="polite" role="status">
          This attention request is no longer pending. Authoritative mission
          state was refreshed, and the decision was not posted again.
        </p>
      </article>
    );
  }

  const operationPending =
    mutation.isPending ||
    refreshPending ||
    resolution.activeAttentionId !== null;
  const displayedError =
    refreshError ?? (mutation.isError ? mutation.error : null);

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
              disabled={operationPending}
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
                    disabled={operationPending}
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

      {refreshPending ? (
        <p aria-live="polite" role="status">
          Refreshing authoritative mission state…
        </p>
      ) : null}

      {displayedError ? (
        <ActionableErrorCard
          error={displayedError}
          onRefresh={() => void refreshAfterFailure()}
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
