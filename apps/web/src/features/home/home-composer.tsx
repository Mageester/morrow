import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowUp, Check, ChevronsUpDown, Paperclip, Search, ShieldCheck } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { conversationApi } from "../../api/conversations.js";
import { saveChatDraft } from "../chat/draft-store.js";
import { saveChatRouteHandoff, type ChatComposerModelRoute } from "../chat/chat-composer.js";
import { providerName } from "../chat/model-picker.js";

export interface HomeComposerProps {
  /** Undefined until a local project is selected; the field explains why. */
  projectId?: string | undefined;
  initialRoute?: ChatComposerModelRoute | undefined;
  routes?: ReadonlyArray<ChatComposerModelRoute> | undefined;
}

function HomeRoutePicker({ onChange, routes, value }: {
  onChange: (route: ChatComposerModelRoute) => void;
  routes: ReadonlyArray<ChatComposerModelRoute>;
  value: ChatComposerModelRoute;
}) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? routes.filter((route) => `${route.label} ${route.providerId ? providerName(route.providerId) : ""}`.toLowerCase().includes(needle))
      : routes;
  }, [query, routes]);

  return (
    <div className="morrow-home-route-picker">
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        className="morrow-home-route-picker__trigger"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>
          <small>{value.providerId ? providerName(value.providerId) : "Model"}</small>
          <b>{value.label}</b>
        </span>
        <ChevronsUpDown aria-hidden="true" size={13} />
      </button>
      {open ? (
        <div className="morrow-home-route-picker__panel">
          <label className="morrow-home-route-picker__search">
            <Search aria-hidden="true" size={13} />
            <span className="morrow-sr-only">Search models</span>
            <input autoFocus onChange={(event) => setQuery(event.target.value)} placeholder="Search models" value={query} />
          </label>
          <div aria-label="Models for new conversation" className="morrow-home-route-picker__list" id={listId} role="menu">
            {visible.map((route) => (
              <button
                aria-checked={route.id === value.id}
                className="morrow-home-route-picker__option"
                key={route.id}
                onClick={() => { onChange(route); setOpen(false); setQuery(""); }}
                role="menuitemradio"
                type="button"
              >
                <span><b>{route.label}</b><small>{route.providerId ? providerName(route.providerId) : "Preset"}</small></span>
                {route.id === value.id ? <Check aria-hidden="true" size={14} /> : null}
              </button>
            ))}
            {visible.length === 0 ? <p>No matching connected model.</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
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
export function HomeComposer({ initialRoute, projectId, routes = [] }: HomeComposerProps) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [selectedRoute, setSelectedRoute] = useState<ChatComposerModelRoute | undefined>(initialRoute ?? routes[0]);
  const inFlight = useRef(false);
  const trimmed = text.trim();

  useEffect(() => {
    setSelectedRoute((current) => {
      if (current && routes.some((route) => route.id === current.id)) return current;
      return initialRoute ?? routes[0];
    });
  }, [initialRoute, routes]);

  const start = useMutation({
    mutationFn: () => conversationApi.create(projectId!),
    onSuccess: (conversation) => {
      setError(null);
      // Hand the words over through the draft the conversation composer already
      // reads, so nothing typed here is lost in the transition.
      saveChatDraft({ conversationId: conversation.id, projectId: projectId! }, trimmed);
      if (selectedRoute) {
        saveChatRouteHandoff({ conversationId: conversation.id, projectId: projectId! }, selectedRoute);
      }
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
        {routes.length > 0 && selectedRoute ? <HomeRoutePicker onChange={setSelectedRoute} routes={routes} value={selectedRoute} /> : null}
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
