import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, Paperclip, ShieldCheck } from "lucide-react";
import { useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { conversationApi } from "../../api/conversations.js";
import { saveChatDraft } from "../chat/draft-store.js";

export interface HomeComposerProps {
  /** Undefined until a local project is selected; the field explains why. */
  projectId?: string | undefined;
  /** Model route shown on the resting chip, e.g. "DeepSeek V3.1". */
  routeLabel?: string | undefined;
}

/**
 * Home's opening gesture: state an outcome, and Morrow opens the conversation
 * that will carry it.
 *
 * Deliberately a *start* action rather than a send. Sending commits to a
 * provider route, and the route is chosen in the conversation composer where
 * the resolved model, mode, and supervision are all visible. Seeding the
 * conversation's draft keeps the reference's one-gesture opening while leaving
 * the decision to contact a provider explicit — no message leaves this machine
 * from this field.
 */
export function HomeComposer({ projectId, routeLabel }: HomeComposerProps) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const trimmed = text.trim();

  const start = useMutation({
    mutationFn: () => conversationApi.create(projectId!),
    onSuccess: (conversation) => {
      setError(null);
      // Hand the words over through the draft the conversation composer already
      // reads, so nothing typed here is lost in the transition.
      saveChatDraft({ conversationId: conversation.id, projectId: projectId! }, trimmed);
      void navigate({
        params: { conversationId: conversation.id },
        search: { projectId: projectId! },
        to: "/chats/$conversationId",
      });
    },
    onError: () => {
      setError("Morrow could not open a conversation. Check the local runtime and try again.");
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (!projectId || !trimmed || inFlight.current) return;
    inFlight.current = true;
    setError(null);
    start.mutate();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  const disabled = !projectId || start.isPending;

  return (
    <div className="morrow-home-start">
    <form aria-label="Start something with Morrow" className="morrow-home-composer" onSubmit={submit}>
      <label className="morrow-sr-only" htmlFor="home-composer-input">
        What should Morrow move forward?
      </label>
      <textarea
        className="morrow-home-composer__input"
        disabled={disabled}
        id="home-composer-input"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Ask Morrow to build, investigate, plan, or take action…"
        rows={2}
        value={text}
      />
      <div className="morrow-home-composer__bar">
        <span className="morrow-home-composer__chip" data-disabled="true" title="Attachments are not accepted by the message API yet.">
          <Paperclip aria-hidden="true" size={12} />
          Attach
        </span>
        <span className="morrow-home-composer__chip">
          <ShieldCheck aria-hidden="true" size={12} />
          Private
        </span>
        {routeLabel ? <span className="morrow-home-composer__chip">{routeLabel}</span> : null}
        <button
          aria-label="Start a conversation with this message"
          className="morrow-home-composer__send"
          disabled={disabled || !trimmed}
          type="submit"
        >
          <ArrowUp aria-hidden="true" size={17} />
        </button>
      </div>
      {!projectId ? (
        <p className="morrow-home-composer__note">Open a local project before starting a conversation.</p>
      ) : null}
      {error ? (
        <p className="morrow-home-composer__note" role="alert">
          {error}
        </p>
      ) : null}
    </form>
    {/* Openings, not templates: each one writes the field so the user edits a
        real sentence rather than committing to a canned prompt. */}
    <div className="morrow-home-composer__suggestions">
      {SUGGESTIONS.map((suggestion) => (
        <button
          className="morrow-home-composer__suggestion"
          disabled={disabled}
          key={suggestion.label}
          onClick={() => setText(suggestion.seed)}
          type="button"
        >
          {suggestion.label}
        </button>
      ))}
    </div>
    </div>
  );
}

const SUGGESTIONS: ReadonlyArray<{ label: string; seed: string }> = [
  { label: "Finish something in progress", seed: "Pick up the unfinished work in this project and take it to a reviewable state. Start by telling me what is outstanding." },
  { label: "Research a decision", seed: "Research this decision and separate what is verified from what is still an assumption: " },
  { label: "Build from a brief", seed: "Build this from the brief below. Ask me anything that is ambiguous before you start.\n\n" },
];
