import type { Conversation, ModelStatus, PresetStatus, ThreadHandoff, WebConversationActivityEntry, WebConversationMessage, WebMissionSummary } from "@morrow/contracts";
import { WebMissionSnapshotSchema } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Archive, ArrowDown, ListTree, Pencil, Trash2 } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { clearChatStreamCursor, resumeChatStreamAfter, useChatTaskStream } from "../../api/chat-stream.js";
import { useMissionStream } from "../../api/mission-stream.js";
import {
  conversationApi,
  conversationKeys,
  conversationQueries,
  pendingWebMessage,
} from "../../api/conversations.js";
import { modelQueries } from "../../api/models.js";
import { Markdown } from "../../components/markdown.js";
import { projectQueries } from "../../api/projects.js";
import { missionKeys, missionQueries } from "../../api/query-keys.js";
import { api, ApiClientError } from "../../api/client.js";
import { saveChatDraft } from "./draft-store.js";
import { ChatComposer, type ChatComposerSubmission } from "./chat-composer.js";
import { toConversationMessageInput } from "./conversation-submit.js";
import { MissionCard } from "./mission-card.js";
import { MissionPanel } from "./mission-panel.js";
import { ActivityPanel } from "./activity-panel.js";
import { usePublishShellTitle } from "../../app/shell-title.js";
import { PendingApprovals } from "./pending-approvals.js";
import { ProcessDock } from "./process-dock.js";
import { useConversationAutoscroll } from "./use-conversation-autoscroll.js";
import { ReasoningDisclosure } from "./reasoning-disclosure.js";
import { projectTurnWork } from "./chat-projection.js";
import { NotableEvent, WorkSummary } from "./work-summary.js";
import { parseTurnFailure } from "./turn-failure.js";
import { TurnFailureNotice } from "./turn-failure-notice.js";
import { LiveTurnStatus } from "./live-status.js";
import { AskTeammate } from "./ask-teammate.js";
import { HandoffRow } from "./handoff-row.js";
import { RecordRoutine } from "./record-routine.js";
import { handoffQueries } from "../../api/handoffs.js";
import { TeammateAvatar } from "../roster/teammate-avatar.js";
import { useThreadTeammate } from "../roster/use-thread-teammate.js";

const ACTIVE_STATES = new Set(["queued", "streaming"]);
const FAILED_STATES = new Set(["failed", "interrupted"]);
const RETRYABLE_STATES = new Set(["failed", "interrupted"]);
const REASONING_VISIBILITY_STORAGE_KEY = "morrow.chat.show-reasoning.v1";

function loadReasoningVisibility(): boolean {
  try {
    return localStorage.getItem(REASONING_VISIBILITY_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveReasoningVisibility(show: boolean): void {
  try {
    localStorage.setItem(REASONING_VISIBILITY_STORAGE_KEY, String(show));
  } catch {
    // Storage can be disabled; the current conversation still updates.
  }
}

function routingLabel(message: WebConversationMessage): string | null {
  const routing = message.routing;
  if (!routing) return message.model && message.provider ? `${message.model} via ${message.provider}` : null;
  const mode = routing.mode === "read-only"
    ? "Ask"
    : routing.mode === "plan-only"
      ? "Plan"
      : routing.mode === "agent"
        ? routing.autoApprove ? "Build Auto" : "Build"
        : null;
  return `${mode ? `${mode} · ` : ""}${routing.model} via ${routing.providerId}`;
}

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

function reconcileConversationLists(
  queryClient: QueryClient,
  projectId: string,
  conversationId: string,
  updated: Conversation | null,
): void {
  for (const includeArchived of [false, true]) {
    queryClient.setQueryData<Conversation[]>(
      conversationKeys.list(projectId, includeArchived),
      (current) => {
        if (!current) return current;
        const withoutCurrent = current.filter((item) => item.id !== conversationId);
        if (!updated || (!includeArchived && updated.archived)) return withoutCurrent;
        return [...withoutCurrent, updated].sort(
          (left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
        );
      },
    );
  }
}

/** Publishes the conversation's name to the shell breadcrumb. */
function ConversationTitle({ title }: { title: string }) {
  usePublishShellTitle(title);
  return null;
}

function TaskStream({ projectId, conversationId, taskId }: { projectId: string; conversationId: string; taskId: string }) {
  const stream = useChatTaskStream({ projectId, conversationId, taskId });
  if (stream.status === "offline") {
    return <p className="morrow-chat-sync" role="status">Offline — showing saved conversation history.</p>;
  }
  if (stream.status === "reconnecting") {
    return <p className="morrow-chat-sync" role="status">Reconnecting to this response…</p>;
  }
  return null;
}

/**
 * Makes the active workspace visible and trustworthy in the surface where work
 * actually happens, instead of only in the Projects switcher. Fetched lazily
 * (dedicated status endpoint) so opening a conversation doesn't pay for a git
 * spawn until this line actually renders.
 */
function WorkspaceStatusLine({ projectId }: { projectId: string }) {
  const status = useQuery(projectQueries.status(projectId));

  if (status.isPending) {
    return <p className="morrow-conversation-workspace">Checking workspace…</p>;
  }
  if (status.isError || !status.data) {
    // Not surfaced as role="alert": the status ping failing is a cosmetic
    // degradation (the conversation still works), unlike the workspace itself
    // being inaccessible below, which is a real blocker worth an interruption.
    return <p className="morrow-conversation-workspace">Workspace status unavailable.</p>;
  }
  if (!status.data.accessible) {
    return (
      <p className="morrow-conversation-workspace morrow-conversation-workspace--blocked" role="alert">
        Workspace &quot;{status.data.name}&quot; is not accessible: {status.data.workspacePath}
      </p>
    );
  }
  return (
    <p className="morrow-conversation-workspace" title={status.data.workspacePath}>
      <span className="morrow-conversation-workspace__project">{status.data.name}</span>
      <span className="morrow-conversation-workspace__path">{status.data.workspacePath}</span>
      {status.data.gitDetected ? (
        <span className="morrow-conversation-workspace__branch">{status.data.branch ?? "detached HEAD"}</span>
      ) : null}
    </p>
  );
}

export interface ConversationMessageItemProps {
  message: WebConversationMessage;
  conversationId: string;
  projectId: string;
  entries?: readonly WebConversationActivityEntry[] | undefined;
  showReasoning: boolean;
  actionBusy: boolean;
  onRetry: (taskId: string) => void;
  onOpenActivity: () => void;
  /** Who is speaking. Falls back to the product's own voice when the thread's
   * teammate cannot be resolved, rather than inventing a name. */
  teammate?: { name: string; isDefault: boolean } | undefined;
  /** Work this turn handed to another teammate, shown where it happened. */
  handoffs?: readonly ThreadHandoff[] | undefined;
}

/**
 * One turn of the conversation.
 *
 * An assistant turn is a single coherent unit: the work Morrow did, folded into
 * one compact summary; any exceptional transition that changes how the answer
 * should be read; then the answer itself, which is what the turn is for and
 * therefore what dominates once it exists.
 *
 * The ordered interleaving of narration and tool calls is not reproduced here.
 * It remains complete in Activity / Inspect, where a reader is asking "in what
 * order did this happen?" — a different question from the one a conversation
 * answers. Rendering it inline is what turned this surface into an event feed.
 */
/**
 * "10:53 AM" — the clock time a message was written.
 *
 * A thread with a teammate is a conversation that happened at particular
 * moments, and reading one back without them is like reading a chat log with
 * the timestamps stripped: you can see what was said but not the shape of it.
 * The date belongs to the day separator above, so this is time only.
 */
function messageTime(iso: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export const ConversationMessageItem = memo(function ConversationMessageItem({
  message,
  conversationId,
  projectId,
  entries,
  showReasoning,
  actionBusy,
  onRetry,
  onOpenActivity,
  teammate,
  handoffs,
}: ConversationMessageItemProps) {
  const streaming = ACTIVE_STATES.has(message.streamingState);
  const failed = FAILED_STATES.has(message.streamingState);
  const work = useMemo(
    () => projectTurnWork(entries, streaming),
    [entries, streaming],
  );
  // The recorded failure reason is split out of the body so the prose above it
  // still renders as prose and the reason gets a surface built for it.
  const failure = useMemo(
    () => (failed ? parseTurnFailure(message.content) : null),
    [failed, message.content],
  );

  if (message.role === "user") {
    const sentAt = messageTime(message.createdAt);
    return (
      <article
        className="morrow-conversation-message morrow-conversation-message--user"
        data-testid="conversation-message-user"
      >
        <div className="morrow-conversation-message__bubble">
          <div className="morrow-conversation-message__content">
            <p>{message.content}</p>
          </div>
        </div>
        {sentAt ? <time className="morrow-conversation-message__time">{sentAt}</time> : null}
      </article>
    );
  }

  const label = routingLabel(message);
  const speaker = teammate?.name ?? "Morrow";
  const sentAt = messageTime(message.createdAt);
  const body = failure ? failure.content : message.content;
  // Exactly one waiting signal per turn: the line below until work starts, the
  // work summary once it has, the answer once there is one.
  const waiting = !body && streaming && work.steps.length === 0;

  return (
    <article
      className="morrow-conversation-message morrow-conversation-message--assistant"
      data-testid="conversation-message-assistant"
    >
      {/* Mark in the gutter, name and time on the byline — the shape a
          message thread has. With a roster, "who said this and when" is a real
          question in a way it never was with one assistant. */}
      <p className="morrow-conversation-message__author">
        <TeammateAvatar isDefault={teammate?.isDefault ?? true} name={speaker} />
        <span className="morrow-visually-hidden">{speaker}</span>
      </p>
      <div className="morrow-conversation-message__turn">
        <p className="morrow-conversation-message__byline">
          <span className="morrow-conversation-message__speaker">{speaker}</span>
          {sentAt ? <time className="morrow-conversation-message__time">{sentAt}</time> : null}
        </p>
        {message.taskId ? (
          <WorkSummary
            conversationId={conversationId}
            onInspect={onOpenActivity}
            projectId={projectId}
            work={work}
          />
        ) : null}

        {work.notables.map((entry) => <NotableEvent entry={entry} key={entry.id} />)}

        {(handoffs ?? []).map((handoff) => (
          <HandoffRow handoff={handoff} key={handoff.id} projectId={projectId} />
        ))}

        {showReasoning && message.taskId ? (
          <ReasoningDisclosure
            active={streaming}
            conversationId={conversationId}
            projectId={projectId}
            taskId={message.taskId}
          />
        ) : null}

        {/* No role="status" here: announcing a running turn is the live status
            line's job, and two live regions saying it produced double
            announcements on every token. */}
        {waiting ? (
          <p className="morrow-typing-indicator">
            {speaker} is responding…
            <span aria-hidden="true" className="morrow-typing-indicator__dots">
              <span />
              <span />
              <span />
            </span>
          </p>
        ) : body ? (
          <div className="morrow-conversation-message__content morrow-conversation-message__content--markdown">
            <Markdown streaming={streaming} text={body} />
          </div>
        ) : null}

        {failed ? (
          <TurnFailureNotice
            failure={failure}
            retryDisabled={actionBusy}
            {...(message.taskId && RETRYABLE_STATES.has(message.streamingState)
              ? { onRetry: () => onRetry(message.taskId!) }
              : {})}
          />
        ) : null}

        {label ? <p className="morrow-conversation-message__route">{label}</p> : null}
      </div>
    </article>
  );
});

export interface ConversationPageContentProps {
  projectId: string;
  conversationId: string;
  onDeleted: () => void;
  modelCatalogue?: { models: ReadonlyArray<ModelStatus>; presets: ReadonlyArray<PresetStatus> } | undefined;
  /** The durable mission started from this conversation, when one exists. */
  linkedMission?: WebMissionSummary | undefined;
  /** Enables the "Start a mission from this chat" action (real usage only). */
  missionsEnabled?: boolean | undefined;
}

export function ConversationPageContent({
  projectId,
  conversationId,
  onDeleted,
  modelCatalogue,
  linkedMission,
  missionsEnabled = false,
}: ConversationPageContentProps) {
  const queryClient = useQueryClient();
  const conversation = useQuery(conversationQueries.detail(projectId, conversationId));
  const messages = useQuery(conversationQueries.messages(projectId, conversationId));
  // Who this thread belongs to. Resolved from the roster the rail already
  // polls, so opening a thread costs no extra request.
  const rosterTeammate = useThreadTeammate(projectId, conversation.data?.agentId);
  const handoffs = useQuery(handoffQueries.thread(projectId, conversationId));
  const teammate = rosterTeammate
    ? { name: rosterTeammate.name, isDefault: rosterTeammate.agentId === null }
    : undefined;
  const activity = useQuery(conversationQueries.activity(projectId, conversationId));
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  // Activity is opt-in. The conversation owns the width by default and the
  // drawer is one click away; a permanently docked execution panel duplicated
  // what the turn summaries already say and pushed the reading column into a
  // corner of its own screen.
  const [activityOpen, setActivityOpen] = useState(false);
  // Set synchronously when Send is pressed, before any request resolves, so the
  // interface acknowledges the message in the same frame as the click.
  const [sending, setSending] = useState(false);
  const [showReasoning, setShowReasoning] = useState(loadReasoningVisibility);
  const [reasoningConfig, setReasoningConfig] = useState<import("@morrow/contracts").ReasoningConfiguration>({ mode: "auto" });
  const activityButtonRef = useRef<HTMLButtonElement>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const restoreRenameFocus = useRef(false);
  const restoreDeleteFocus = useRef(false);
  const cancellationRequests = useRef(new Set<string>());
  const startMission = useMutation({
    mutationFn: (objective: string) =>
      api.post(
        "/api/web/missions",
        { projectId, conversationId, objective, autonomy: "recommended" },
        WebMissionSnapshotSchema,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: missionKeys.list(projectId) });
    },
  });

  const history = messages.data ?? [];
  const activeMessages = useMemo(
    () => history.filter((message) => message.taskId && ACTIVE_STATES.has(message.streamingState)),
    [history],
  );
  const activeTaskId = activeMessages.at(-1)?.taskId ?? undefined;
  // Latest task regardless of state — the context meter should keep reporting
  // the last turn's usage after that turn finishes, not blank out.
  const latestTaskId = [...history].reverse().find((message) => message.taskId)?.taskId ?? undefined;
  const transcript = useMemo(
    () => history.map(({ content, id, streamingState, updatedAt }) => `${id}\u0000${content}\u0000${streamingState}\u0000${updatedAt}`).join("\u0001"),
    [history],
  );
  const {
    containerRef: historyRef,
    resume: resumeAutoscroll,
    sentinelRef,
    showJumpButton,
  } = useConversationAutoscroll({ history, transcript, activeTaskId });
  const [queuedMessage, setQueuedMessage] = useState<ChatComposerSubmission | null>(null);
  const prevActiveTaskId = useRef(activeTaskId);

  useEffect(() => {
    if (prevActiveTaskId.current && !activeTaskId && queuedMessage) {
      const next = queuedMessage;
      setQueuedMessage(null);
      void submit(next);
    }
    prevActiveTaskId.current = activeTaskId;
  }, [activeTaskId, queuedMessage]);
  const activityByTask = useMemo(() => {
    const grouped = new Map<string, WebConversationActivityEntry[]>();
    for (const entry of activity.data?.entries ?? []) {
      grouped.set(entry.taskId, [...(grouped.get(entry.taskId) ?? []), entry]);
    }
    return grouped;
  }, [activity.data]);

  // Handoffs hang off the turn that started them, so each appears at the point
  // in the thread where the work was actually given away.
  const handoffsByTask = useMemo(() => {
    const grouped = new Map<string, ThreadHandoff[]>();
    for (const handoff of handoffs.data?.handoffs ?? []) {
      grouped.set(handoff.parentTaskId, [...(grouped.get(handoff.parentTaskId) ?? []), handoff]);
    }
    return grouped;
  }, [handoffs.data]);

  // The live status line reports the turn in flight; it reads the same
  // projection the turn's own summary does, so the two can never disagree.
  const activeWork = useMemo(
    () => projectTurnWork(activeTaskId ? activityByTask.get(activeTaskId) : undefined, true),
    [activeTaskId, activityByTask],
  );
  const openActivity = useCallback(() => setActivityOpen(true), []);
  const conversationTaskIds = useMemo(
    () => new Set(history.flatMap((message) => (message.taskId ? [message.taskId] : []))),
    [history],
  );

  useEffect(() => {
    saveReasoningVisibility(showReasoning);
  }, [showReasoning]);

  useEffect(() => {
    if (renameOpen) {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
      return;
    }
    if (restoreRenameFocus.current) {
      restoreRenameFocus.current = false;
      renameButtonRef.current?.focus();
    }
  }, [renameOpen]);

  useEffect(() => {
    if (deleteOpen) {
      deleteCancelRef.current?.focus();
      return;
    }
    if (restoreDeleteFocus.current) {
      restoreDeleteFocus.current = false;
      deleteButtonRef.current?.focus();
    }
  }, [deleteOpen]);

  const closeRename = () => {
    restoreRenameFocus.current = true;
    setRenameOpen(false);
  };
  const closeDelete = () => {
    restoreDeleteFocus.current = true;
    setDeleteOpen(false);
  };
  const closeActivity = () => {
    setActivityOpen(false);
    window.setTimeout(() => activityButtonRef.current?.focus(), 0);
  };
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>, close: () => void) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
    )].filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  async function submit(submission: ChatComposerSubmission) {
    resumeAutoscroll();
    // Before the network is touched: the status line appears now, not when the
    // provider gets around to answering.
    setSending(true);
    try {
      const result = await conversationApi.sendMessage(
        projectId,
        conversationId,
        toConversationMessageInput(submission),
      );
      queryClient.setQueryData<WebConversationMessage[]>(
        conversationKeys.messages(projectId, conversationId),
        (current = []) => {
          const next = [...current];
          const candidates = [
            pendingWebMessage(result.userMessage, null, null),
            pendingWebMessage(result.assistantMessage, result.task.status, result.routing),
          ];
          for (const candidate of candidates) {
            const index = next.findIndex((message) => message.id === candidate.id);
            if (index >= 0) next[index] = candidate;
            else next.push(candidate);
          }
          return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
        },
      );
      return { accepted: true } as const;
    } catch (error) {
      return {
        accepted: false,
        error: safeError(error, "Morrow could not accept this message. Check the connection and try again."),
      } as const;
    } finally {
      setSending(false);
    }
  }

  async function stop(taskId: string) {
    if (cancellationRequests.current.has(taskId)) return;
    cancellationRequests.current.add(taskId);
    try {
      await conversationApi.cancel(projectId, conversationId, taskId);
      await queryClient.refetchQueries(
        { queryKey: conversationKeys.messages(projectId, conversationId), exact: true },
        { throwOnError: true },
      );
      clearChatStreamCursor({ projectId, conversationId, taskId });
    } finally {
      cancellationRequests.current.delete(taskId);
    }
  }

  async function retry(taskId: string) {
    setActionBusy(true);
    setActionMessage(null);
    try {
      const result = await conversationApi.retry(projectId, conversationId, taskId);
      if (result.afterCursor === undefined) clearChatStreamCursor({ projectId, conversationId, taskId });
      else resumeChatStreamAfter({ projectId, conversationId, taskId }, result.afterCursor);
      await queryClient.invalidateQueries({ queryKey: conversationKeys.messages(projectId, conversationId) });
    } catch (error) {
      setActionMessage(safeError(error, "Morrow could not retry this response. Try again."));
    } finally {
      setActionBusy(false);
    }
  }

  function openRename() {
    setRenameTitle(conversation.data?.title ?? "");
    setActionMessage(null);
    setRenameOpen(true);
  }

  async function saveRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameTitle.trim() || actionBusy) return;
    setActionBusy(true);
    setActionMessage(null);
    try {
      const updated = await conversationApi.update(projectId, conversationId, { title: renameTitle });
      queryClient.setQueryData(conversationKeys.detail(projectId, conversationId), updated);
      reconcileConversationLists(queryClient, projectId, conversationId, updated);
      closeRename();
    } catch (error) {
      setActionMessage(safeError(error, "The conversation could not be renamed. Try again."));
    } finally {
      setActionBusy(false);
    }
  }

  async function toggleArchive() {
    if (!conversation.data || actionBusy) return;
    setActionBusy(true);
    setActionMessage(null);
    try {
      const archived = !conversation.data.archived;
      const updated = await conversationApi.update(projectId, conversationId, { archived });
      queryClient.setQueryData(conversationKeys.detail(projectId, conversationId), updated);
      reconcileConversationLists(queryClient, projectId, conversationId, updated);
      setActionMessage(archived ? "Conversation archived." : "Conversation restored.");
    } catch (error) {
      setActionMessage(safeError(error, "The conversation could not be updated. Try again."));
    } finally {
      setActionBusy(false);
    }
  }

  async function confirmDelete() {
    if (actionBusy) return;
    setActionBusy(true);
    setActionMessage(null);
    try {
      await conversationApi.delete(projectId, conversationId);
      queryClient.removeQueries({ queryKey: conversationKeys.detail(projectId, conversationId) });
      queryClient.removeQueries({ queryKey: conversationKeys.messages(projectId, conversationId) });
      reconcileConversationLists(queryClient, projectId, conversationId, null);
      setDeleteOpen(false);
      onDeleted();
    } catch (error) {
      setActionMessage(safeError(error, "The conversation could not be deleted. Stop any active response and try again."));
      closeDelete();
    } finally {
      setActionBusy(false);
    }
  }

  const handleRetry = useCallback((taskId: string) => {
    void retry(taskId);
  }, [projectId, conversationId, queryClient]);

  if (conversation.isPending || messages.isPending) {
    return <section className="morrow-conversation-page"><p aria-live="polite" role="status">Loading conversation…</p></section>;
  }
  if ((conversation.isError && !conversation.data) || (messages.isError && !messages.data)) {
    return (
      <section className="morrow-conversation-page">
        <h1>Conversation unavailable</h1>
        <p role="alert">This conversation could not be loaded. Check the local runtime and try again.</p>
      </section>
    );
  }

  const value = conversation.data as Conversation;

  function startMissionFromChat() {
    if (startMission.isPending) return;
    const lastUser = [...history].reverse().find((message) => message.role === "user");
    const objective = (lastUser?.content?.trim() || value.title).slice(0, 8000);
    if (!objective) return;
    startMission.mutate(objective);
  }

  return (
    <section
      aria-label={`Conversation: ${value.title}`}
      className="morrow-conversation-page"
      data-activity={activityOpen ? "open" : "closed"}
    >
      {/* The conversation's name goes to the shell breadcrumb instead of being
          repeated as a page heading, so the reading column opens on the
          conversation itself. */}
      <ConversationTitle title={value.title} />

      <div className="morrow-conversation">
      <header className="morrow-conversation-header">
        <div aria-label="Conversation actions" className="morrow-conversation-actions">
          <button
            aria-label={activityOpen ? "Hide activity" : "Show activity"}
            aria-pressed={activityOpen}
            className="morrow-conversation-actions__activity"
            onClick={() => setActivityOpen((open) => !open)}
            ref={activityButtonRef}
            type="button"
          >
            <ListTree aria-hidden="true" size={15} />
            <span>Activity</span>
          </button>
          <button aria-label="Rename conversation" disabled={actionBusy} onClick={openRename} ref={renameButtonRef} type="button"><Pencil aria-hidden="true" size={15} /></button>
          <button aria-label={value.archived ? "Restore conversation" : "Archive conversation"} disabled={actionBusy} onClick={() => { void toggleArchive(); }} type="button"><Archive aria-hidden="true" size={15} /></button>
          <button aria-label="Delete conversation" disabled={actionBusy} onClick={() => { setActionMessage(null); setDeleteOpen(true); }} ref={deleteButtonRef} type="button"><Trash2 aria-hidden="true" size={15} /></button>
        </div>
      </header>

      <div aria-live="polite" className="morrow-conversation-history" ref={historyRef}>
        <div className="morrow-conversation-history__inner">
        {/* Whose thread this is, stated once at the top. Without it a thread
            with a specialist is indistinguishable from a thread with the
            default assistant, which is the whole distinction the roster
            introduces. */}
        {rosterTeammate ? (
          <div className="morrow-thread-teammate" data-testid="thread-teammate">
            <TeammateAvatar isDefault={rosterTeammate.agentId === null} name={rosterTeammate.name} />
            <span className="morrow-thread-teammate__text">
              <span className="morrow-thread-teammate__name">{rosterTeammate.name}</span>
              <span className="morrow-thread-teammate__job">
                {rosterTeammate.instructions
                  ?? (rosterTeammate.agentId === null
                    ? "Your general assistant"
                    : `${rosterTeammate.role.replace(/-/g, " ")} · no standing instructions`)}
              </span>
            </span>
            {/* Live status, from the same projection the rail reads. In a
                thread you are looking at, "working" is usually obvious; it is
                the teammate that is waiting on YOU, or switched off, that this
                has to say out loud. */}
            <span className="morrow-thread-teammate__status" data-status={rosterTeammate.status}>
              <span aria-hidden="true" className="morrow-roster__dot" />
              {rosterTeammate.status === "working" ? "Working"
                : rosterTeammate.status === "waiting" ? "Waiting on you"
                : rosterTeammate.status === "disabled" ? "Off"
                : "Idle"}
            </span>
            {rosterTeammate.modelLabel ? (
              <span className="morrow-thread-teammate__model">{rosterTeammate.modelLabel}</span>
            ) : null}
          </div>
        ) : null}
        <WorkspaceStatusLine projectId={projectId} />

        {(conversation.isRefetchError && conversation.data) || (messages.isRefetchError && messages.data) ? (
          <p className="morrow-chat-warning" role="status">Morrow could not refresh this conversation. Showing saved history.</p>
        ) : null}
        {actionMessage ? <p aria-live="polite" role={actionMessage.includes("could not") ? "alert" : "status"}>{actionMessage}</p> : null}

        {linkedMission ? (
          <ConversationMissionSurface fallbackSummary={linkedMission} missionId={linkedMission.id} />
        ) : missionsEnabled ? (
          <div className="morrow-conversation-mission">
            <button
              className="morrow-conversation-mission__start"
              disabled={startMission.isPending}
              onClick={startMissionFromChat}
              type="button"
            >
              {startMission.isPending ? "Starting a mission…" : "Start a mission from this chat"}
            </button>
            {startMission.isError ? (
              <p role="alert">Morrow could not start a mission. Check the connection and try again.</p>
            ) : null}
          </div>
        ) : null}

        {history.length === 0 ? (
          <div className="morrow-conversation-empty">
            <h2>Start this conversation</h2>
            <p>Ask a question or choose Plan when you want a thoughtful approach without changes.</p>
          </div>
        ) : history.map((message) => (
          <ConversationMessageItem
            actionBusy={actionBusy}
            conversationId={conversationId}
            entries={message.taskId ? activityByTask.get(message.taskId) : undefined}
            key={message.id}
            message={message}
            onOpenActivity={openActivity}
            onRetry={handleRetry}
            projectId={projectId}
            handoffs={message.taskId ? handoffsByTask.get(message.taskId) : undefined}
            showReasoning={showReasoning}
            teammate={teammate}
          />
        ))}

        {activeMessages.map((message) => (
          <TaskStream conversationId={conversationId} key={message.taskId} projectId={projectId} taskId={message.taskId!} />
        ))}

        <div aria-hidden="true" className="morrow-conversation-autoscroll-sentinel" ref={sentinelRef} />
        </div>
        {showJumpButton ? (
          <button
            aria-label="Jump to latest messages"
            className="morrow-jump-to-latest"
            onClick={resumeAutoscroll}
            type="button"
          >
            <ArrowDown aria-hidden="true" size={14} />
            <span>Jump to latest</span>
          </button>
        ) : null}
      </div>

      <div className="morrow-conversation-action-shelf">
        {/* Above approvals: a dev server that is already up is context for the
            decision you are about to make, not another thing to decide. */}
        <ProcessDock projectId={projectId} />
        <PendingApprovals
          active={activeTaskId !== undefined}
          conversationId={conversationId}
          conversationTaskIds={conversationTaskIds}
          projectId={projectId}
        />
        {activeTaskId || sending ? (
          <LiveTurnStatus
            onOpenActivity={openActivity}
            queued={activeMessages.at(-1)?.streamingState === "queued"}
            sending={sending}
            taskId={activeTaskId}
            work={activeWork}
          />
        ) : null}
        {queuedMessage ? (
          <div className="morrow-queued-message" role="status">
            <div className="morrow-queued-message__head">
              <span className="morrow-queued-message__badge">Queued for next step</span>
              <div className="morrow-queued-message__actions">
                <button
                  aria-label="Edit queued message"
                  className="morrow-queued-message__btn"
                  onClick={() => {
                    saveChatDraft({ projectId, conversationId }, queuedMessage.content);
                    setQueuedMessage(null);
                  }}
                  type="button"
                >
                  Edit
                </button>
                <button
                  aria-label="Cancel queued message"
                  className="morrow-queued-message__btn"
                  onClick={() => setQueuedMessage(null)}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </div>
            <p className="morrow-queued-message__content">{queuedMessage.content}</p>
          </div>
        ) : null}
      </div>

      <div className="morrow-conversation-composer">
        {/* Beside the composer, not inside it: asking someone else is an act
            on the thread, not a modifier on the message you are writing. */}
        <div className="morrow-thread-actions">
          <AskTeammate
            conversationId={conversationId}
            currentAgentId={conversation.data?.agentId ?? null}
            parentTaskId={latestTaskId ?? null}
            projectId={projectId}
          />
          <RecordRoutine
            agentId={conversation.data?.agentId ?? null}
            conversationId={conversationId}
            projectId={projectId}
          />
        </div>
        <ChatComposer
          activeTaskId={activeTaskId}
          autoFocus
          contextTaskId={latestTaskId}
          draftScope={{ projectId, conversationId }}
          modelCatalogue={modelCatalogue}
          onQueueMessage={setQueuedMessage}
          onReasoningConfigChange={setReasoningConfig}
          onShowReasoningChange={setShowReasoning}
          onStop={stop}
          onSubmit={submit}
          placeholder={activeTaskId ? "Type a follow-up or steering message to queue…" : `Reply to ${teammate?.name ?? "Morrow"}…`}
          queuedMessage={queuedMessage}
          reasoningConfig={reasoningConfig}
          showReasoning={showReasoning}
        />
      </div>
      </div>

      {/* One activity surface, not two. It carries the full, raw, redacted
          execution record; the conversation carries the curated view of it. */}
      {activityOpen ? (
        <ActivityPanel
          conversationId={conversationId}
          onClose={closeActivity}
          projectId={projectId}
        />
      ) : null}

      {renameOpen ? (
        <div aria-labelledby="rename-conversation-heading" aria-modal="true" className="morrow-conversation-dialog-backdrop" onKeyDown={(event) => onDialogKeyDown(event, closeRename)} role="dialog">
          <form className="morrow-conversation-dialog" onSubmit={saveRename}>
            <h2 id="rename-conversation-heading">Rename conversation</h2>
            <label>Conversation title<input maxLength={200} onChange={(event) => setRenameTitle(event.target.value)} ref={renameInputRef} value={renameTitle} /></label>
            <div className="morrow-conversation-dialog__actions">
              <button disabled={actionBusy} onClick={closeRename} type="button">Cancel</button>
              <button disabled={actionBusy || !renameTitle.trim()} type="submit">Save name</button>
            </div>
          </form>
        </div>
      ) : null}

      {deleteOpen ? (
        <div aria-labelledby="delete-conversation-heading" aria-modal="true" className="morrow-conversation-dialog-backdrop" onKeyDown={(event) => onDialogKeyDown(event, closeDelete)} role="alertdialog">
          <div className="morrow-conversation-dialog">
            <h2 id="delete-conversation-heading">Delete this conversation?</h2>
            <p>The saved messages will be removed. Completed task records and the project stay intact. This cannot be undone.</p>
            <div className="morrow-conversation-dialog__actions">
              <button disabled={actionBusy} onClick={closeDelete} ref={deleteCancelRef} type="button">Keep conversation</button>
              <button disabled={actionBusy} onClick={() => { void confirmDelete(); }} type="button">Delete permanently</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

/**
 * The live mission surface inside a conversation. It subscribes to the mission
 * event stream and reads the authoritative snapshot, so the card AND the detail
 * panel both update in place as the mission progresses — no refresh, no second
 * state machine. The card falls back to the list summary until the first
 * snapshot resolves. This is a child (not inline) so the stream and snapshot
 * hooks only mount when a conversation actually has a linked mission.
 */
function ConversationMissionSurface({
  missionId,
  fallbackSummary,
}: {
  missionId: string;
  fallbackSummary: WebMissionSummary;
}) {
  const [open, setOpen] = useState(false);
  const { status } = useMissionStream(missionId);
  const snapshot = useQuery(missionQueries.detail(missionId));
  const summary = snapshot.data?.summary ?? fallbackSummary;

  return (
    <div className="morrow-conversation-mission">
      <MissionCard
        expanded={open}
        liveStatus={status}
        onToggle={() => setOpen((value) => !value)}
        summary={summary}
      />
      {open ? (
        snapshot.isPending ? (
          <p aria-live="polite" className="morrow-mission-panel__status" role="status">
            Loading mission details…
          </p>
        ) : snapshot.isError || !snapshot.data ? (
          <p className="morrow-mission-panel__status" role="alert">
            Mission details are unavailable right now.
          </p>
        ) : (
          <MissionPanel snapshot={snapshot.data} />
        )
      ) : null}
    </div>
  );
}

export function ConversationPage() {
  const { conversationId } = useParams({ strict: false }) as { conversationId?: string };
  const search = useSearch({ strict: false }) as { projectId?: string };
  const navigate = useNavigate();
  // Fetched once for the whole conversation; the picker degrades to the
  // recommended route until the catalogue resolves. Hooks run before the guard.
  const catalogue = useQuery(modelQueries.catalogue());
  const presets = useQuery(modelQueries.presets());
  const missions = useQuery({
    ...missionQueries.list(search.projectId ?? ""),
    enabled: Boolean(search.projectId),
  });
  if (!conversationId || !search.projectId) {
    return (
      <section className="morrow-conversation-page">
        <h1>Conversation unavailable</h1>
        <p role="alert">Open this conversation from its project so Morrow can verify its local ownership.</p>
      </section>
    );
  }
  const linkedMission = (missions.data ?? [])
    .filter((mission) => mission.conversationId === conversationId)
    .at(-1);
  return (
    <ConversationPageContent
      conversationId={conversationId}
      linkedMission={linkedMission}
      missionsEnabled
      modelCatalogue={{ models: catalogue.data ?? [], presets: presets.data ?? [] }}
      onDeleted={() => { void navigate({ to: "/" }); }}
      projectId={search.projectId}
    />
  );
}
