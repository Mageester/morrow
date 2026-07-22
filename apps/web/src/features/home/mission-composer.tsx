import {
  CreateWebMissionSchema,
  WebMissionSnapshotSchema,
  type CreateWebMissionInput,
} from "@morrow/contracts";
import { Button, Surface } from "@morrow/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { Link } from "@tanstack/react-router";
import { api, ApiClientError } from "../../api/client.js";
import { missionKeys } from "../../api/query-keys.js";
import { providerQueries } from "../../api/providers.js";
import {
  clearChatDraft,
  loadChatDraft,
  saveChatDraft,
} from "../chat/draft-store.js";

type Autonomy = CreateWebMissionInput["autonomy"];

function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `web-${crypto.randomUUID()}`;
  }
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError) return error.message;
  return "Morrow could not start this mission. Try again.";
}

export function MissionComposer({
  activeProjectId,
}: {
  activeProjectId?: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [autonomy, setAutonomy] = useState<Autonomy>("recommended");
  const [draft, setDraft] = useState("");
  const [objectiveValidationError, setObjectiveValidationError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const providers = useQuery(providerQueries.list());
  // The mock provider is a test-only fixture; it never counts as a real model
  // the user connected, so exclude it from both the empty and ready states.
  const configuredProviders = providers.isSuccess
    ? providers.data.filter((provider) => provider.configured && provider.id !== "mock")
    : [];
  const noProviderConnected = providers.isSuccess && configuredProviders.length === 0;
  // When exactly one provider is connected, name the model that will run; with
  // several, the router chooses per preset, so summarise instead of guessing.
  const singleProvider = configuredProviders.length === 1 ? configuredProviders[0] : null;
  const currentIdempotencyKey = useRef(createIdempotencyKey());
  const failedSubmission = useRef(false);
  const isCurrent = useRef(false);
  const submissionInFlight = useRef(false);
  const objectiveInput = useRef<HTMLTextAreaElement>(null);
  const priorProjectId = useRef<string | undefined>(undefined);

  useEffect(() => {
    isCurrent.current = true;
    return () => {
      isCurrent.current = false;
    };
  }, []);

  useEffect(() => {
    if (!activeProjectId) return;
    const storedDraft = loadChatDraft({ projectId: activeProjectId });
    const liveDraft = objectiveInput.current?.value ?? "";
    const nextDraft = priorProjectId.current === undefined && liveDraft
      ? liveDraft
      : storedDraft;
    setDraft(nextDraft);
    if (nextDraft && nextDraft !== storedDraft) {
      saveChatDraft({ projectId: activeProjectId }, nextDraft);
    }
    priorProjectId.current = activeProjectId;
    objectiveInput.current?.focus();
  }, [activeProjectId]);

  const createMission = useMutation({
    mutationFn: (input: CreateWebMissionInput) =>
      api.post("/api/web/missions", input, WebMissionSnapshotSchema),
    onError: (error) => {
      failedSubmission.current = true;
      setRequestError(errorMessage(error));
    },
    onSuccess: (snapshot) => {
      queryClient.setQueryData(
        missionKeys.detail(snapshot.summary.id),
        snapshot,
      );
      if (!isCurrent.current) return;

      failedSubmission.current = false;
      currentIdempotencyKey.current = createIdempotencyKey();
      if (activeProjectId) clearChatDraft({ projectId: activeProjectId });
      setDraft("");
      setObjectiveValidationError(null);
      setRequestError(null);
      void navigate({
        params: { missionId: snapshot.summary.id },
        to: "/missions/$missionId",
      });
    },
    onSettled: () => {
      submissionInFlight.current = false;
    },
  });

  function resetFailedSubmissionForEdit() {
    if (!failedSubmission.current) return;
    currentIdempotencyKey.current = createIdempotencyKey();
    failedSubmission.current = false;
    setRequestError(null);
  }

  function submit() {
    // Read the live control so an immediate Enter after a large paste or
    // browser autofill cannot race React's state update.
    const objective = (objectiveInput.current?.value ?? draft).trim();
    if (!objective || !activeProjectId) return;
    if (objective.length > 8_000) {
      setObjectiveValidationError(
        "Mission objectives must be 8,000 characters or fewer.",
      );
      return;
    }

    const parsed = CreateWebMissionSchema.safeParse({
      autonomy,
      idempotencyKey: currentIdempotencyKey.current,
      objective,
      projectId: activeProjectId,
    });
    if (!parsed.success) {
      setRequestError("Review the mission details and try again.");
      return;
    }
    if (submissionInFlight.current) return;

    submissionInFlight.current = true;
    setRequestError(null);
    createMission.mutate(parsed.data);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <Surface aria-labelledby="mission-composer-heading" padding="large" variant="raised">
      <form className="morrow-composer" onSubmit={handleSubmit}>
        <div className="morrow-composer__intro">
          <h2 id="mission-composer-heading">What should Morrow accomplish?</h2>
          <p>Describe the outcome. Morrow will determine the capabilities needed.</p>
        </div>
        {noProviderConnected ? (
          <p className="morrow-composer__provider-note" role="status">
            No AI model is connected yet, so missions will wait until one is
            added. <Link to="/connections">Connect a model</Link>
          </p>
        ) : configuredProviders.length > 0 ? (
          <p className="morrow-composer__provider-ready" role="status">
            <span aria-hidden="true" className="morrow-composer__provider-dot" />
            {singleProvider ? (
              <>
                Ready —{" "}
                <strong>{singleProvider.defaultModel ?? singleProvider.label}</strong>{" "}
                via {singleProvider.label}. <Link to="/connections">Change model</Link>
              </>
            ) : (
              <>
                {configuredProviders.length} models connected.{" "}
                <Link to="/connections">Manage models</Link>
              </>
            )}
          </p>
        ) : null}
        <label className="morrow-sr-only" htmlFor="mission-objective">
          Mission objective
        </label>
        <textarea
          aria-describedby={
            objectiveValidationError ? "mission-objective-error" : undefined
          }
          aria-invalid={objectiveValidationError ? true : undefined}
          className="morrow-composer__objective"
          id="mission-objective"
          onChange={(event) => {
            const nextDraft = event.target.value;
            if (nextDraft !== draft) setObjectiveValidationError(null);
            if (failedSubmission.current && nextDraft !== draft) {
              resetFailedSubmissionForEdit();
            }
            if (activeProjectId) {
              saveChatDraft({ projectId: activeProjectId }, nextDraft);
            }
            setDraft(nextDraft);
          }}
          onKeyDown={handleKeyDown}
          placeholder="For example: compare these options and recommend the best next step."
          ref={objectiveInput}
          rows={5}
          value={draft}
        />
        <details className="morrow-composer__advanced">
          <summary>Advanced mission options</summary>
          <div className="morrow-composer__advanced-body">
            <div className="morrow-composer__field">
              <label htmlFor="mission-autonomy">Autonomy</label>
              <select
                id="mission-autonomy"
                onChange={(event) => {
                  const nextAutonomy = event.target.value as Autonomy;
                  if (nextAutonomy !== autonomy) resetFailedSubmissionForEdit();
                  setAutonomy(nextAutonomy);
                }}
                value={autonomy}
              >
                <option value="ask_at_risk">Ask before risky actions</option>
                <option value="recommended">Use Morrow’s recommendations</option>
                <option value="autonomous">Proceed autonomously</option>
              </select>
            </div>
            <p className="morrow-composer__advanced-note">
              Deadlines, attachments, and connections are not available in this
              local slice.
            </p>
          </div>
        </details>
        {objectiveValidationError ? (
          <p id="mission-objective-error" role="alert">
            {objectiveValidationError}
          </p>
        ) : null}
        {requestError ? (
          <p aria-live="polite" role="status">
            {requestError}
          </p>
        ) : null}
        <div className="morrow-composer__actions">
          <Button
            disabled={!activeProjectId || !draft.trim() || createMission.isPending}
            type="submit"
          >
            Start mission
          </Button>
        </div>
      </form>
    </Surface>
  );
}
