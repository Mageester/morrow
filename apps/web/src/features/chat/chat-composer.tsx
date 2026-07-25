import type { AgentMode, ModelStatus, PresetId, PresetStatus, ProviderId } from "@morrow/contracts";
import { Send, Square } from "lucide-react";
import { ModelPicker } from "./model-picker.js";
import {
  useEffect,
  useId,
  useLayoutEffect,
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
  /** When provided, the live model catalogue replaces the simple route select
   * with the searchable model picker. */
  modelCatalogue?: { models: ReadonlyArray<ModelStatus>; presets: ReadonlyArray<PresetStatus> } | undefined;
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
  return JSON.stringify([scope.projectId, scope.conversationId ?? null]);
}

interface SelectionSnapshot {
  direction: "backward" | "forward" | "none";
  end: number;
  start: number;
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
  modelCatalogue,
  activeTaskId,
  onStop,
}: ChatComposerProps) {
  const id = useId();
  const inputId = `morrow-chat-message-${id}`;
  const helpId = `morrow-chat-help-${id}`;
  const limitId = `morrow-chat-limit-${id}`;
  const [initialDraft] = useState(() => loadChatDraft(draftScope));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const sendingRef = useRef(false);
  const currentScopeId = scopeId(draftScope);
  const committedScope = useRef({ id: currentScopeId, scope: { ...draftScope } });
  const pendingFocus = useRef<{
    scopeId: string;
    selection: SelectionSnapshot;
  } | null>(null);

  const availableRoutes = modelRoutes.length > 0 ? modelRoutes : [DEFAULT_ROUTE];
  const [mode, setMode] = useState<ComposerMode>("ask");
  const [routeId, setRouteId] = useState(availableRoutes[0]!.id);
  // Selection from the searchable catalogue; undefined means "Auto — recommended".
  const [catalogueRoute, setCatalogueRoute] = useState<ChatComposerModelRoute | undefined>(undefined);
  const [length, setLength] = useState(() => initialDraft.length);
  const [hasContent, setHasContent] = useState(() => Boolean(initialDraft.trim()));
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const resize = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = "auto";
    const height = Math.min(textarea.scrollHeight, TEXTAREA_MAX_HEIGHT);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > TEXTAREA_MAX_HEIGHT ? "auto" : "hidden";
  };

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (committedScope.current.id !== currentScopeId) {
      const retainedFocus = document.activeElement === textarea;
      const nextScope = { ...draftScope };
      textarea.value = loadChatDraft(nextScope);
      setLength(textarea.value.length);
      setHasContent(Boolean(textarea.value.trim()));
      setMessage(null);
      committedScope.current = { id: currentScopeId, scope: nextScope };
      if (retainedFocus) {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    }
    resize(textarea);
  }, [currentScopeId]);

  useEffect(() => {
    if (autoFocus && !disabled && !activeTaskId && !sending) textareaRef.current?.focus();
  }, [activeTaskId, autoFocus, disabled, sending]);

  // Transient confirmations announce to assistive tech through the polite live
  // region, then clear themselves — "Message accepted." must never linger in the
  // UI as if it were a standing status. Errors are left in place (they need the
  // user to act), so only the known success notices auto-dismiss.
  useEffect(() => {
    if (message !== "Message accepted." && message !== "Stop requested.") return;
    const timer = setTimeout(() => {
      setMessage((current) => (current === message ? null : current));
    }, 2500);
    return () => clearTimeout(timer);
  }, [message]);

  useLayoutEffect(() => {
    const request = pendingFocus.current;
    const textarea = textareaRef.current;
    if (!request || !textarea || disabled || activeTaskId || sending) return;
    pendingFocus.current = null;
    if (request.scopeId !== committedScope.current.id) return;
    textarea.focus();
    const end = Math.min(request.selection.end, textarea.value.length);
    const start = Math.min(request.selection.start, end);
    textarea.setSelectionRange(start, end, request.selection.direction);
  }, [activeTaskId, currentScopeId, disabled, sending]);

  function handleInput(event: InputEvent<HTMLTextAreaElement>) {
    const textarea = event.currentTarget;
    setLength(textarea.value.length);
    setHasContent(Boolean(textarea.value.trim()));
    setMessage(null);
    saveChatDraft(committedScope.current.scope, textarea.value);
    resize(textarea);
  }

  async function submit() {
    const textarea = textareaRef.current;
    if (!textarea || disabled || activeTaskId || stopping || sendingRef.current) return;
    const content = textarea.value;
    if (!content.trim() || content.length > CHAT_PROMPT_MAX_LENGTH) return;

    sendingRef.current = true;
    setSending(true);
    setMessage(null);
    const submittedScope = committedScope.current.scope;
    const submittedScopeId = scopeId(submittedScope);
    const submittedSelection: SelectionSnapshot = {
      direction: textarea.selectionDirection,
      end: textarea.selectionEnd,
      start: textarea.selectionStart,
    };
    const effectiveRoute = modelCatalogue
      ? catalogueRoute
      : availableRoutes.find((route) => route.id === routeId) ?? availableRoutes[0];
    const routing = effectiveRoute?.providerId
      ? {
          providerId: effectiveRoute.providerId,
          ...(effectiveRoute.model ? { model: effectiveRoute.model } : {}),
        }
      : effectiveRoute?.preset
        ? { preset: effectiveRoute.preset }
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
        if (submittedScopeId === committedScope.current.id) {
          setMessage(result.error ?? "Message was not accepted. Review the details and try again.");
          pendingFocus.current = { scopeId: submittedScopeId, selection: submittedSelection };
        }
        return;
      }
      clearChatDraft(submittedScope);
      if (textareaRef.current && submittedScopeId === committedScope.current.id) {
        textareaRef.current.value = "";
        setLength(0);
        setHasContent(false);
        resize(textareaRef.current);
        pendingFocus.current = {
          scopeId: submittedScopeId,
          selection: { direction: "none", end: 0, start: 0 },
        };
        setMessage("Message accepted.");
      }
    } catch {
      if (submittedScopeId === committedScope.current.id) {
        setMessage("Message was not accepted. Try again.");
        pendingFocus.current = { scopeId: submittedScopeId, selection: submittedSelection };
      }
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
      !event.nativeEvent.isComposing &&
      event.keyCode !== 229 &&
      event.which !== 229
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
  const interactionDisabled = disabled || sending || Boolean(activeTaskId);
  const cannotSend = interactionDisabled || stopping || !hasContent || overLimit > 0;

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
        defaultValue={initialDraft}
        disabled={interactionDisabled}
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
            disabled={interactionDisabled}
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
              disabled={interactionDisabled}
              onChange={(event) => onProjectChange(event.target.value)}
              value={projectId}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
        ) : null}

        {modelCatalogue ? (
          <ModelPicker
            disabled={interactionDisabled}
            models={modelCatalogue.models}
            onChange={setCatalogueRoute}
            presets={modelCatalogue.presets}
            value={catalogueRoute}
          />
        ) : (
          <label className="morrow-chat-composer__select">
            <span>Model route</span>
            <select
              disabled={interactionDisabled}
              onChange={(event) => setRouteId(event.target.value)}
              value={availableRoutes.some((route) => route.id === routeId) ? routeId : availableRoutes[0]!.id}
            >
              {availableRoutes.map((route) => (
                <option key={route.id} value={route.id}>{route.label}</option>
              ))}
            </select>
          </label>
        )}

        {activeTaskId && onStop ? (
          <button
            aria-label="Stop generation"
            className="morrow-chat-composer__stop"
            disabled={disabled || stopping}
            onClick={() => { void stop(); }}
            type="button"
          >
            <Square aria-hidden="true" size={15} />
            <span>{stopping ? "Stopping…" : "Stop"}</span>
          </button>
        ) : activeTaskId ? null : (
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
