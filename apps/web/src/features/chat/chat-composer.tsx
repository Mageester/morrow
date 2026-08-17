import { normalizeReasoningForRoute, reasoningModesForRoute, type AgentMode, type ModelStatus, type PresetId, type PresetStatus, type ProviderId, type ReasoningConfiguration, type RouteReasoningCapability } from "@morrow/contracts";
import { Send, Square } from "lucide-react";
import { CapabilityStatus } from "./capability-status.js";
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
const COMPOSER_MODE_STORAGE_KEY = "morrow.chat.composer-mode.v1";

type ComposerMode = "chat" | "build";

interface ComposerModePreference {
  mode: ComposerMode;
  autoApprove: boolean;
}

function loadComposerModePreference(): ComposerModePreference {
  try {
    const saved = JSON.parse(localStorage.getItem(COMPOSER_MODE_STORAGE_KEY) ?? "null") as Partial<ComposerModePreference> | null;
    if (saved?.mode === "chat") {
      return { mode: "chat", autoApprove: false };
    }
    if (saved?.mode === "build") {
      return { mode: "build", autoApprove: saved.autoApprove === true };
    }
  } catch {
    // Corrupt or unavailable browser storage must not block chat.
  }
  return { mode: "build", autoApprove: true };
}

function saveComposerModePreference(preference: ComposerModePreference): void {
  try {
    localStorage.setItem(COMPOSER_MODE_STORAGE_KEY, JSON.stringify(preference));
  } catch {
    // Storage can be disabled; current-session state still works.
  }
}

export interface ChatComposerModelRoute {
  id: string;
  label: string;
  preset?: PresetId | undefined;
  providerId?: ProviderId | undefined;
  model?: string | undefined;
  reasoning?: RouteReasoningCapability | undefined;
}

const ROUTE_HANDOFF_PREFIX = "morrow.chat-route-handoff.v1";

function routeHandoffKey(scope: ChatDraftScope): string {
  return `${ROUTE_HANDOFF_PREFIX}.${encodeURIComponent(JSON.stringify([scope.projectId, scope.conversationId ?? null]))}`;
}

/** Persist only a non-secret route choice for the conversation Home is about
 * to open. Credentials and message content are stored elsewhere. */
export function saveChatRouteHandoff(scope: ChatDraftScope, route: ChatComposerModelRoute): void {
  try {
    window.localStorage.setItem(routeHandoffKey(scope), JSON.stringify({ route, version: 1 }));
  } catch {
    // A denied storage write must not block opening the conversation.
  }
}

/** Forget the stored choice, so the composer falls back to "Auto — recommended". */
export function clearChatRouteHandoff(scope: ChatDraftScope): void {
  try {
    window.localStorage.removeItem(routeHandoffKey(scope));
  } catch {
    // A denied storage write must not block the selection itself.
  }
}

export function loadChatRouteHandoff(scope: ChatDraftScope): ChatComposerModelRoute | undefined {
  try {
    const raw = window.localStorage.getItem(routeHandoffKey(scope));
    if (!raw) return undefined;
    const stored: unknown = JSON.parse(raw);
    if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== 1 || !("route" in stored)) return undefined;
    const route = stored.route;
    if (!route || typeof route !== "object" || !("id" in route) || typeof route.id !== "string" || !("label" in route) || typeof route.label !== "string") return undefined;
    return route as ChatComposerModelRoute;
  } catch {
    return undefined;
  }
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
  reasoning?: ReasoningConfiguration | undefined;
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
  /** The most recent task in this conversation, running or finished. The
   * context meter reads usage from it; activeTaskId alone would blank the
   * meter the moment a turn completed, which is exactly when the reader wants
   * to know how much of the window that turn consumed. */
  contextTaskId?: string | undefined;
  onStop?: ((taskId: string) => Promise<void>) | undefined;
  showReasoning?: boolean | undefined;
  onShowReasoningChange?: ((show: boolean) => void) | undefined;
  reasoningConfig?: ReasoningConfiguration | undefined;
  onReasoningConfigChange?: ((config: ReasoningConfiguration) => void) | undefined;
  queuedMessage?: ChatComposerSubmission | null | undefined;
  onQueueMessage?: ((submission: ChatComposerSubmission) => void) | undefined;
}

const DEFAULT_ROUTE: ChatComposerModelRoute = {
  id: "balanced",
  label: "Balanced route",
  preset: "balanced",
};

/**
 * Two modes, not four.
 *
 * The previous set — Ask, Plan, Build, Build Auto — asked people to make two
 * unrelated decisions through one control. Build and Build Auto were the same
 * mode differing only by `autoApprove`, which is a question about supervision,
 * not about what Morrow should do; and Plan sat between them describing an
 * output format rather than a capability. What is left is the one real choice
 * (may Morrow change my files?) with workspace trust as its own visible switch.
 *
 * The wire contract is unchanged: the orchestrator still receives
 * read-only / plan-only / agent plus autoApprove.
 */
const MODES: ReadonlyArray<{ id: ComposerMode; label: string; hint: string }> = [
  { id: "chat", label: "Chat", hint: "Answers and reads your project. Changes nothing." },
  { id: "build", label: "Build", hint: "Makes changes to your project." },
];

function mapMode(
  mode: ComposerMode,
  autoApprove: boolean,
): Pick<ChatComposerSubmission, "mode" | "autoApprove"> {
  if (mode === "chat") return { mode: "read-only", autoApprove: false };
  return { mode: "agent", autoApprove };
}

interface ReasoningSliderOption {
  label: string;
  config: ReasoningConfiguration;
}

/** Render an opaque provider mode id readably when the provider named no label. */
function displayCaseModeId(id: string): string {
  if (id === "xhigh") return "xHigh";
  return id.length > 0 ? id[0]!.toUpperCase() + id.slice(1) : id;
}

function reasoningSliderOptions(capability: RouteReasoningCapability | undefined): ReasoningSliderOption[] {
  const auto: ReasoningSliderOption = { label: "Auto", config: { mode: "auto" } };
  if (!capability) return [auto];
  switch (capability.control) {
    case "none":
    case "fixed":
    case "unknown":
      return [auto];
    case "effort": {
      // The set of modes and their order come from the provider — the picker
      // never assumes a low/medium/high ladder, so a route offering only
      // "minimal" and "max" renders exactly those two.
      //
      // Labels come from the provider too when it supplied them. A route that
      // reported only ids (a live discovery response) gets display casing
      // applied here: presenting an opaque id readably is this component's
      // job, and doing it here keeps it out of the capability contract, where
      // it would read as a claim the provider never made.
      const providerLabelled = (capability.modes?.length ?? 0) > 0;
      return [
        auto,
        ...(capability.supportsOff ? [{ label: "Off", config: { mode: "off" } as ReasoningConfiguration }] : []),
        ...reasoningModesForRoute(capability).map((mode): ReasoningSliderOption => ({
          label: providerLabelled ? mode.label : displayCaseModeId(mode.id),
          config: { mode: "effort", effort: mode.id },
        })),
      ];
    }
    case "budget":
      return [
        auto,
        { label: "Off", config: { mode: "off" } },
        ...capability.budgets.map((tokens): ReasoningSliderOption => ({
          label: tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens),
          config: { mode: "budget", tokens },
        })),
      ];
  }
}

function sameReasoningConfig(left: ReasoningConfiguration, right: ReasoningConfiguration): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === "effort" && right.mode === "effort") return left.effort === right.effort;
  if (left.mode === "budget" && right.mode === "budget") return left.tokens === right.tokens;
  return true;
}

function ReasoningSlider({
  capability,
  disabled,
  onChange,
  value,
}: {
  capability: RouteReasoningCapability | undefined;
  disabled: boolean;
  onChange: (config: ReasoningConfiguration) => void;
  value: ReasoningConfiguration;
}) {
  const options = reasoningSliderOptions(capability);
  const normalized = capability
    ? normalizeReasoningForRoute(value, capability).config
    : { mode: "auto" as const };
  const selectedIndex = Math.max(0, options.findIndex((option) => sameReasoningConfig(option.config, normalized)));
  const progress = options.length <= 1 ? 0 : (selectedIndex / (options.length - 1)) * 100;
  const isAdjustable = capability?.control === "effort" || capability?.control === "budget";
  const selectedLabel = options[selectedIndex]?.label ?? "Auto";
  const description = !capability
    ? "Select a model to adjust reasoning"
    : capability.control === "fixed"
      ? "Reasoning is fixed by the provider"
      : capability.control === "none"
        ? "This model does not expose reasoning controls"
        : "Set reasoning effort / thinking depth for the model";

  return (
    <div
      aria-label="Reasoning effort"
      className={`morrow-reasoning-slider${isAdjustable ? "" : " is-static"}`}
      title={description}
    >
      <span className="morrow-reasoning-slider__label">Reasoning</span>
      <div className="morrow-reasoning-slider__control">
        <div className="morrow-reasoning-slider__track" aria-hidden="true">
          <span className="morrow-reasoning-slider__fill" style={{ width: `${progress}%` }} />
        </div>
        <input
          aria-label="Reasoning effort"
          aria-valuetext={selectedLabel}
          className="morrow-reasoning-slider__input"
          data-adjustable={isAdjustable ? "true" : "false"}
          data-value={selectedLabel.toLowerCase()}
          disabled={disabled || !isAdjustable}
          max={Math.max(0, options.length - 1)}
          min={0}
          onChange={(event) => {
            const option = options[Number(event.target.value)];
            if (option) onChange(option.config);
          }}
          type="range"
          value={selectedIndex}
        />
        <span aria-atomic="true" aria-live="polite" className="morrow-reasoning-slider__value">
          {selectedLabel}
        </span>
        <div className="morrow-reasoning-slider__labels" aria-hidden="true">
          {options.map((option) => <span key={option.label}>{option.label}</span>)}
        </div>
      </div>
    </div>
  );
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
  contextTaskId,
  onStop,
  showReasoning = false,
  onShowReasoningChange,
  reasoningConfig,
  onReasoningConfigChange,
  queuedMessage,
  onQueueMessage,
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
  const [initialRoute] = useState(() => loadChatRouteHandoff(draftScope));
  const [initialModePreference] = useState(loadComposerModePreference);
  const [mode, setMode] = useState<ComposerMode>(initialModePreference.mode);
  const [autoApprove, setAutoApprove] = useState(initialModePreference.autoApprove);
  const [routeId, setRouteId] = useState(
    availableRoutes.some((route) => route.id === initialRoute?.id) ? initialRoute!.id : availableRoutes[0]!.id,
  );
  // Selection from the searchable catalogue; undefined means "Auto — recommended".
  // The choice is durable per conversation: a remount (navigating away and
  // back, a reload, a task finishing) must never silently drop the user's model
  // back to Auto or to a stale one.
  const [catalogueRoute, setCatalogueRoute] = useState<ChatComposerModelRoute | undefined>(
    modelCatalogue ? initialRoute : undefined,
  );
  const chooseCatalogueRoute = (route: ChatComposerModelRoute | undefined) => {
    setCatalogueRoute(route);
    if (route) saveChatRouteHandoff(draftScope, route);
    else clearChatRouteHandoff(draftScope);
  };
  const [length, setLength] = useState(() => initialDraft.length);
  const [hasContent, setHasContent] = useState(() => Boolean(initialDraft.trim()));
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selectedRoute = modelCatalogue
    ? catalogueRoute
    : availableRoutes.find((route) => route.id === routeId) ?? availableRoutes[0];
  const selectedReasoningCapability = selectedRoute?.reasoning;
  const selectedReasoning = onReasoningConfigChange
    ? selectedReasoningCapability
      ? normalizeReasoningForRoute(reasoningConfig, selectedReasoningCapability).config
      : { mode: "auto" as const }
    : undefined;

  useEffect(() => {
    saveComposerModePreference({ mode, autoApprove: mode === "build" && autoApprove });
  }, [mode, autoApprove]);

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
      // The stored choice belongs to the conversation, not to this mount.
      if (modelCatalogue) setCatalogueRoute(loadChatRouteHandoff(nextScope));
      if (retainedFocus) {
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }
    }
    resize(textarea);
  }, [currentScopeId]);

  useEffect(() => {
    if (autoFocus && !disabled && !activeTaskId && !sending) textareaRef.current?.focus({ preventScroll: true });
  }, [activeTaskId, autoFocus, disabled, sending]);

  // Transient confirmations announce to assistive tech through the polite live
  // region, then clear themselves — "Message accepted." must never linger in the
  // UI as if it were a standing status. Errors are left in place (they need the
  // user to act), so only the known success notices auto-dismiss.
  useEffect(() => {
    if (message !== "Message accepted." && message !== "Stop requested." && message !== "Message queued for next turn.") return;
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
    if (!textarea || disabled || stopping || sendingRef.current) return;
    const content = textarea.value;
    if (!content.trim() || content.length > CHAT_PROMPT_MAX_LENGTH) return;

    const submittedScope = committedScope.current.scope;
    const submittedScopeId = scopeId(submittedScope);
    const submittedSelection: SelectionSnapshot = {
      direction: textarea.selectionDirection,
      end: textarea.selectionEnd,
      start: textarea.selectionStart,
    };
    const routing = selectedRoute?.providerId
      ? {
          providerId: selectedRoute.providerId,
          ...(selectedRoute.model ? { model: selectedRoute.model } : {}),
        }
      : selectedRoute?.preset
        ? { preset: selectedRoute.preset }
        : {};

    const submission: ChatComposerSubmission = {
      content,
      projectId: submittedScope.projectId,
      ...(submittedScope.conversationId
        ? { conversationId: submittedScope.conversationId }
        : {}),
      ...mapMode(mode, autoApprove),
      ...routing,
      ...(selectedReasoning ? { reasoning: selectedReasoning } : {}),
    };

    if (activeTaskId) {
      if (onQueueMessage) {
        onQueueMessage(submission);
        clearChatDraft(submittedScope);
        if (textareaRef.current && submittedScopeId === committedScope.current.id) {
          textareaRef.current.value = "";
          setLength(0);
          setHasContent(false);
          resize(textareaRef.current);
          setMessage("Message queued for next turn.");
        }
      }
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setMessage(null);

    try {
      const result = await onSubmit(submission);
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
  const inputDisabled = disabled || sending || stopping;
  const controlsDisabled = disabled || sending || Boolean(activeTaskId);
  const cannotSend = inputDisabled || (!activeTaskId && !hasContent) || (Boolean(activeTaskId) && !hasContent) || overLimit > 0;

  return (
    <form
      aria-label="Message Morrow"
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
        disabled={inputDisabled}
        enterKeyHint="send"
        id={inputId}
        onCompositionEnd={() => { composing.current = false; }}
        onCompositionStart={() => { composing.current = true; }}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        placeholder={activeTaskId ? "Type a follow-up or steering message to queue…" : placeholder}
        ref={textareaRef}
        rows={1}
      />

      {/* One bar of chips, as in the premium reference: how Morrow should work,
          how far it may go, and where it thinks — then send. Everything that
          was on a second row is still here and still reachable in tab order. */}
      <div className="morrow-chat-composer__toolbar">
        <div aria-label="How Morrow should work" className="morrow-chat-composer__modes" role="group">
          {MODES.map((item) => (
            <button
              aria-pressed={mode === item.id}
              className={mode === item.id ? "is-active" : undefined}
              disabled={controlsDisabled}
              key={item.id}
              onClick={() => setMode(item.id)}
              title={item.hint}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Supervision is only a question once Morrow can actually change
            something, so the switch appears with Build rather than sitting
            inert next to Chat. */}
        {mode === "build" ? (
          <label className="morrow-chat-composer__auto-approve">
            <input
              checked={autoApprove}
              disabled={controlsDisabled}
              onChange={(event) => setAutoApprove(event.target.checked)}
              type="checkbox"
            />
            <span>Trusted workspace</span>
          </label>
        ) : null}

        {projects.length > 1 && onProjectChange ? (
          <label className="morrow-chat-composer__select">
            <span>Project</span>
            <select
              disabled={controlsDisabled}
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
            disabled={controlsDisabled}
            models={modelCatalogue.models}
            onChange={chooseCatalogueRoute}
            presets={modelCatalogue.presets}
            value={catalogueRoute}
          />
        ) : (
          <label className="morrow-chat-composer__select">
            <span>Model route</span>
            <select
              disabled={controlsDisabled}
              onChange={(event) => setRouteId(event.target.value)}
              value={availableRoutes.some((route) => route.id === routeId) ? routeId : availableRoutes[0]!.id}
            >
              {availableRoutes.map((route) => (
                <option key={route.id} value={route.id}>{route.label}</option>
              ))}
            </select>
          </label>
        )}

        <CapabilityStatus
          disabled={disabled}
          reasoningConfig={selectedReasoning}
          route={selectedRoute}
          taskId={contextTaskId ?? activeTaskId}
        />

        <div aria-label="Thinking controls" className="morrow-chat-composer__thinking-controls">
        {onReasoningConfigChange ? (
          <ReasoningSlider
            capability={selectedReasoningCapability}
            disabled={controlsDisabled}
            onChange={onReasoningConfigChange}
            value={reasoningConfig ?? { mode: "auto" }}
          />
        ) : null}

        {/* Named for what it reveals, not for the same word the depth control
            uses — two chips both reading "Reasoning" sat side by side and
            neither said which was which. */}
        {onShowReasoningChange ? (
          <label
            className="morrow-chat-composer__reasoning-toggle"
            title="Show the reasoning text supplied by the model provider"
          >
            <input
              checked={showReasoning}
              disabled={disabled}
              onChange={(event) => onShowReasoningChange(event.target.checked)}
              type="checkbox"
            />
            <span aria-hidden="true" className="morrow-chat-composer__toggle-mark" />
            <span>Show thinking</span>
          </label>
        ) : null}
        </div>

        {activeTaskId ? (
          <div className="morrow-chat-composer__actions">
            {onStop ? (
              <button
                aria-label="Stop generation"
                className="morrow-chat-composer__stop"
                disabled={disabled || stopping}
                onClick={() => { void stop(); }}
                type="button"
              >
                <Square aria-hidden="true" size={14} />
                <span>{stopping ? "Stopping…" : "Stop"}</span>
              </button>
            ) : null}
            {onQueueMessage && hasContent ? (
              <button
                aria-label="Queue message"
                className="morrow-chat-composer__queue"
                disabled={cannotSend}
                type="submit"
              >
                <Send aria-hidden="true" size={16} />
                <span>Queue</span>
              </button>
            ) : null}
          </div>
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

      {/* The consequence of the current mode, stated plainly under the bar. */}
      <p className="morrow-chat-composer__mode-hint">
        {mode === "build"
          ? autoApprove
            ? "Ordinary workspace actions can continue without stopping; other actions still ask."
            : "Morrow will ask before workspace changes and commands."
          : "Morrow will answer and read your project, but will not change anything."}
      </p>

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
