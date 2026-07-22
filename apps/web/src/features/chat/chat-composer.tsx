import type { AgentMode, PresetId, ProviderId } from "@morrow/contracts";
import { Send, Square } from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type InputEvent,
  type KeyboardEvent,
} from "react";
import {
  clearChatDraft,
  loadChatDraft,
  saveChatDraft,
  type ChatDraftScope,
} from "./draft-store.js";

export const CHAT_PROMPT_MAX_LENGTH = 32_000;
const TEXTAREA_MAX_HEIGHT = 192;

type ComposerMode = "ask" | "plan" | "build" | "build-auto";

export interface ChatComposerModelRoute {
  id: string;
  label: string;
  preset?: PresetId | undefined;
  providerId?: ProviderId | undefined;
  model?: string | undefined;
}

export interface ChatComposerSubmission {
  content: string;
  projectId: string;
  conversationId?: string | undefined;
  mode: AgentMode;
  autoApprove: boolean;
  preset?: PresetId | undefined;
  providerId?: ProviderId | undefined;
  model?: string | undefined;
}

export interface ChatComposerSubmitResult {
  accepted: boolean;
  error?: string | undefined;
}

export interface ChatComposerProps {
  draftScope: ChatDraftScope;
  onSubmit: (submission: ChatComposerSubmission) => Promise<ChatComposerSubmitResult>;
  autoFocus?: boolean | undefined;
  disabled?: boolean | undefined;
  placeholder?: string | undefined;
  projects?: ReadonlyArray<{ id: string; name: string }> | undefined;
  projectId?: string | undefined;
  onProjectChange?: ((projectId: string) => void) | undefined;
  modelRoutes?: ReadonlyArray<ChatComposerModelRoute> | undefined;
  activeTaskId?: string | undefined;
  onStop?: ((taskId: string) => Promise<void>) | undefined;
}

const DEFAULT_ROUTE: ChatComposerModelRoute = {
  id: "balanced",
  label: "Balanced route",
  preset: "balanced",
};

const MODES: ReadonlyArray<{ id: ComposerMode; label: string }> = [
  { id: "ask", label: "Ask" },
  { id: "plan", label: "Plan" },
  { id: "build", label: "Build" },
  { id: "build-auto", label: "Build Auto" },
];

function mapMode(mode: ComposerMode): Pick<ChatComposerSubmission, "mode" | "autoApprove"> {
  if (mode === "ask") return { mode: "read-only", autoApprove: false };
  if (mode === "plan") return { mode: "plan-only", autoApprove: false };
  return { mode: "agent", autoApprove: mode === "build-auto" };
}

function scopeId(scope: ChatDraftScope): string {
  return `${scope.projectId}\u0000${scope.conversationId ?? ""}`;
}

export function ChatComposer({
  draftScope,
  onSubmit,
  autoFocus = false,
  disabled = false,
  placeholder = "Ask anything, or describe something for Morrow to take on…",
  projects = [],
  projectId = draftScope.projectId,
  onProjectChange,
  modelRoutes = [DEFAULT_ROUTE],
  activeTaskId,
  onStop,
}: ChatComposerProps) {
  const id = useId();
  const inputId = `morrow-chat-message-${id}`;
  const helpId = `morrow-chat-help-${id}`;
  const limitId = `morrow-chat-limit-${id}`;
  const initialDraft = useRef(loadChatDraft(draftScope));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const sendingRef = useRef(false);
  const currentScopeId = scopeId(draftScope);
  const priorScopeId = useRef(currentScopeId);
  const currentScope = useRef(draftScope);
  currentScope.current = draftScope;

  const availableRoutes = modelRoutes.length > 0 ? modelRoutes : [DEFAULT_ROUTE];
  const [mode, setMode] = useState<ComposerMode>("ask");
  const [routeId, setRouteId] = useState(availableRoutes[0]!.id);
  const [length, setLength] = useState(() => initialDraft.current.length);
  const [hasContent, setHasContent] = useState(() => Boolean(initialDraft.current.trim()));
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const resize = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = "auto";
    const height = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  };

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (priorScopeId.current !== currentScopeId) {
      textarea.value = loadChatDraft(draftScope);
      setLength(textarea.value.length);
      setHasContent(Boolean(textarea.value.trim()));
      setMessage(null);
      priorScopeId.current = currentScopeId;
    }
    resize(textarea);
  }, [currentScopeId, draftScope]);

  useEffect(() => {
    if (autoFocus && !disabled) textareaRef.current?.focus();
  }, [autoFocus, disabled]);

  function handleInput(event: InputEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    setLength(textarea.value.length);
    setHasContent(Boolean(textarea.value.trim()));
    setMessage(null);
    saveChatDraft(currentScope.current, textarea.value);
    resize(textarea);
  }

  async function submit() {
    const textarea = textareaRef.current;
    if (!textarea || disabled || sendingRef.current) return;
    const content = textarea.value;
    if (!content.trim() || content.length > CHAT_PROMPT_MAX_LENGTH) return;

    sendingRef.current = true;
    setSending(true);
    setMessage(null);
    const submittedScope = currentScope.current;
    const submittedScopeId = scopeId(submittedScope);
    const selectedRoute = availableRoutes.find((route) => route.id === routeId) ?? availableRoutes[0]!;
    const routing = selectedRoute.providerId
      ? {
          providerId: selectedRoute.providerId,
          ...(selectedRoute.model ? { model: selectedRoute.model } : {}),
        }
      : selectedRoute.preset
        ? { preset: selectedRoute.preset }
        : {};

    try {
      const result = await onSubmit({
        content,
        projectId: submittedScope.projectId,
        ...(submittedScope.conversationId
          ? { conversationId: submittedScope.conversationId }
          : {}),
        ...mapMode(mode),
        ...routing,
      });
      if (!result.accepted) {
        setMessage(result.error ?? "Message was not accepted. Review the details and try again.");
        return;
      }
      clearChatDraft(submittedScope);
      if (textareaRef.current && submittedScopeId === scopeId(currentScope.current)) {
        textareaRef.current.value = "";
        setLength(0);
        setHasContent(false);
        resize(textareaRef.current);
        textareaRef.current.focus();
      }
      setMessage("Message accepted.");
    } catch {
      setMessage("Message was not accepted. Try again.");
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submit();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !composing.current &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      void submit();
    }
  }

  async function stop() {
    if (!activeTaskId || !onStop || stopping) return;
    setStopping(true);
    setMessage(null);
    try {
      await onStop(activeTaskId);
      setMessage("Stop requested.");
    } catch {
      setMessage("Morrow could not stop generation. Try again.");
    } finally {
      setStopping(false);
    }
  }

  const overLimit = Math.max(0, length - CHAT_PROMPT_MAX_LENGTH);
  const showCounter = length >= 30_000;
  const cannotSend = disabled || sending || !hasContent || overLimit > 0;

  return (
    <form
      aria-busy={sending || stopping ? "true" : undefined}
      className="morrow-chat-composer"
      onSubmit={handleSubmit}
    >
      <label className="morrow-sr-only" htmlFor={inputId}>
        Message Morrow
      </label>
      <textarea
        aria-describedby={overLimit > 0 ? limitId : helpId}
        aria-invalid={overLimit > 0 ? "true" : undefined}
        autoComplete="on"
        className="morrow-chat-composer__input"
        defaultValue={initialDraft.current}
        disabled={disabled || sending}
        enterKeyHint="send"
        id={inputId}
        onCompositionEnd={() => { composing.current = false; }}
        onCompositionStart={() => { composing.current = true; }}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        ref={textareaRef}
        rows={1}
      />

      <div aria-label="How Morrow should work" className="morrow-chat-composer__modes" role="group">
        {MODES.map((item) => (
          <button
            aria-pressed={mode === item.id}
            className={mode === item.id ? "is-active" : undefined}
            disabled={disabled || sending}
            key={item.id}
            onClick={() => setMode(item.id)}
            type="button"
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="morrow-chat-composer__toolbar">
        {projects.length > 1 && onProjectChange ? (
          <label className="morrow-chat-composer__select">
            <span>Project</span>
            <select
              disabled={disabled || sending}
              onChange={(event) => onProjectChange(event.target.value)}
              value={projectId}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="morrow-chat-composer__select">
          <span>Model route</span>
          <select
            disabled={disabled || sending}
            onChange={(event) => setRouteId(event.target.value)}
            value={availableRoutes.some((route) => route.id === routeId) ? routeId : availableRoutes[0]!.id}
          >
            {availableRoutes.map((route) => (
              <option key={route.id} value={route.id}>{route.label}</option>
            ))}
          </select>
        </label>

        {activeTaskId && onStop ? (
          <button
            aria-label="Stop generation"
            className="morrow-chat-composer__stop"
            disabled={stopping}
            onClick={() => { void stop(); }}
            type="button"
          >
            <Square aria-hidden="true" size={15} />
            <span>{stopping ? "Stopping…" : "Stop"}</span>
          </button>
        ) : (
          <button
            aria-label={sending ? "Sending message" : "Send message"}
            className="morrow-chat-composer__send"
            disabled={cannotSend}
            type="submit"
          >
            <Send aria-hidden="true" size={18} />
          </button>
        )}
      </div>

      <div className="morrow-chat-composer__meta">
        <p id={helpId}>
          Attachments are unavailable because the message API does not accept files yet.
        </p>
        {showCounter ? (
          <p aria-live="polite" className="morrow-chat-composer__counter">
            {length.toLocaleString("en-US")} / {CHAT_PROMPT_MAX_LENGTH.toLocaleString("en-US")} characters
          </p>
        ) : null}
      </div>
      {overLimit > 0 ? (
        <p id={limitId} role="alert">
          {overLimit.toLocaleString("en-US")} {overLimit === 1 ? "character" : "characters"} over the limit. Shorten the message to send it.
        </p>
      ) : null}
      {message ? (
        <p aria-live="polite" role={message === "Message accepted." || message === "Stop requested." ? "status" : "alert"}>
          {message}
        </p>
      ) : null}
    </form>
  );
}
