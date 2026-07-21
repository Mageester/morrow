import {
  CreateWebMissionSchema,
  WebMissionSnapshotSchema,
  type CreateWebMissionInput,
} from "@morrow/contracts";
import { Button, Surface } from "@morrow/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { api, ApiClientError } from "../../api/client.js";
import { missionKeys } from "../../api/query-keys.js";

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
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const currentIdempotencyKey = useRef(createIdempotencyKey());
  const failedSubmission = useRef(false);
  const isCurrent = useRef(false);
  const submissionInFlight = useRef(false);
  const objectiveInput = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    isCurrent.current = true;
    return () => {
      isCurrent.current = false;
    };
  }, []);

  useEffect(() => {
    if (activeProjectId) objectiveInput.current?.focus();
  }, [activeProjectId]);

  const createMission = useMutation({
    mutationFn: (input: CreateWebMissionInput) =>
      api.post("/api/web/missions", input, WebMissionSnapshotSchema),
    onError: (error) => {
      failedSubmission.current = true;
      setSubmissionError(errorMessage(error));
    },
    onSuccess: (snapshot) => {
      queryClient.setQueryData(
        missionKeys.detail(snapshot.summary.id),
        snapshot,
      );
      if (!isCurrent.current) return;

      failedSubmission.current = false;
      currentIdempotencyKey.current = createIdempotencyKey();
      setDraft("");
      setSubmissionError(null);
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
    setSubmissionError(null);
  }

  function submit() {
    const objective = draft.trim();
    if (!objective || !activeProjectId) return;
    if (objective.length > 8_000) {
      setSubmissionError("Mission objectives must be 8,000 characters or fewer.");
      return;
    }

    const parsed = CreateWebMissionSchema.safeParse({
      autonomy,
      idempotencyKey: currentIdempotencyKey.current,
      objective,
      projectId: activeProjectId,
    });
    if (!parsed.success) {
      setSubmissionError("Review the mission details and try again.");
      return;
    }
    if (submissionInFlight.current) return;

    submissionInFlight.current = true;
    setSubmissionError(null);
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
      <form onSubmit={handleSubmit}>
        <div>
          <h2 id="mission-composer-heading">What should Morrow accomplish?</h2>
          <p>Describe the outcome. Morrow will determine the capabilities needed.</p>
        </div>
        <label htmlFor="mission-objective">Mission objective</label>
        <textarea
          aria-describedby={submissionError ? "mission-composer-error" : undefined}
          aria-invalid={submissionError ? true : undefined}
          id="mission-objective"
          onChange={(event) => {
            const nextDraft = event.target.value;
            if (failedSubmission.current && nextDraft !== draft) {
              resetFailedSubmissionForEdit();
            }
            setDraft(nextDraft);
          }}
          onKeyDown={handleKeyDown}
          placeholder="For example: compare these options and recommend the best next step."
          ref={objectiveInput}
          rows={5}
          value={draft}
        />
        <details>
          <summary>Advanced mission options</summary>
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
          <fieldset disabled>
            <label htmlFor="mission-deadline">Optional deadline</label>
            <input id="mission-deadline" type="datetime-local" />
          </fieldset>
          <p>
            Deadlines, attachments, and connections are not available in this
            local slice.
          </p>
        </details>
        {submissionError ? (
          <p id="mission-composer-error" role="alert">
            {submissionError}
          </p>
        ) : null}
        <Button
          disabled={!activeProjectId || !draft.trim() || createMission.isPending}
          type="submit"
        >
          Start mission
        </Button>
      </form>
    </Surface>
  );
}
