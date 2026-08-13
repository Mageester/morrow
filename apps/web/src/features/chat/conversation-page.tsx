import type { Conversation, ModelStatus, PresetStatus, WebConversationActivityEntry, WebConversationMessage, WebMissionSummary } from "@morrow/contracts";
import { WebMissionSnapshotSchema } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Archive, ListTree, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
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
import { ChatComposer, type ChatComposerSubmission } from "./chat-composer.js";
import { toConversationMessageInput } from "./conversation-submit.js";
import { MissionCard } from "./mission-card.js";
import { MissionPanel } from "./mission-panel.js";
import { ActivityPanel, ConversationActivity, ConversationTranscript } from "./activity-panel.js";
import { PendingApprovals } from "./pending-approvals.js";
import { useConversationAutoscroll } from "./use-conversation-autoscroll.js";
import { ReasoningDisclosure } from "./reasoning-disclosure.js";

const ACTIVE_STATES = new Set(["queued", "streaming"]);
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
  const activity = useQuery(conversationQueries.activity(projectId, conversationId));
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
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
  const { resume: resumeAutoscroll, sentinelRef } = useConversationAutoscroll({ history, transcript, activeTaskId });
  const activityByTask = useMemo(() => {
    const grouped = new Map<string, WebConversationActivityEntry[]>();
    for (const entry of activity.data?.entries ?? []) {
      grouped.set(entry.taskId, [...(grouped.get(entry.taskId) ?? []), entry]);
    }
    return grouped;
  }, [activity.data]);

  // A task has a transcript only once it has narration to interleave; without
  // it there is nothing to order the tool steps against.
  const transcripts = useMemo(() => {
    const withNarration = new Set<string>();
    for (const entry of activity.data?.entries ?? []) {
      if (entry.kind === "narration") withNarration.add(entry.taskId);
    }
    return withNarration;
  }, [activity.data]);
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
    <section aria-label="Conversation workspace" className="morrow-conversation-page">
      <header className="morrow-conversation-header">
        <h1 id="conversation-heading">{value.title}</h1>
        <div aria-label="Conversation actions" className="morrow-conversation-actions">
          <button
            aria-label="Activity / Inspect"
            aria-pressed={activityOpen}
            className="morrow-conversation-actions__activity"
            onClick={() => setActivityOpen((open) => !open)}
            ref={activityButtonRef}
            type="button"
          >
            <ListTree aria-hidden="true" size={16} />
            <span>Activity</span>
          </button>
          <button aria-label="Rename conversation" disabled={actionBusy} onClick={openRename} ref={renameButtonRef} type="button"><Pencil aria-hidden="true" size={16} /></button>
          <button aria-label={value.archived ? "Restore conversation" : "Archive conversation"} disabled={actionBusy} onClick={() => { void toggleArchive(); }} type="button"><Archive aria-hidden="true" size={16} /></button>
          <button aria-label="Delete conversation" disabled={actionBusy} onClick={() => { setActionMessage(null); setDeleteOpen(true); }} ref={deleteButtonRef} type="button"><Trash2 aria-hidden="true" size={16} /></button>
        </div>
      </header>

      <WorkspaceStatusLine projectId={projectId} />

      {activityOpen ? (
        <ActivityPanel
          conversationId={conversationId}
          onClose={closeActivity}
          projectId={projectId}
        />
      ) : null}

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

      <div aria-live="polite" className="morrow-conversation-history">
        {history.length === 0 ? (
          <div className="morrow-conversation-empty">
            <h2>Start this conversation</h2>
            <p>Ask a question or choose Plan when you want a thoughtful approach without changes.</p>
          </div>
        ) : history.map((message) => {
          const label = routingLabel(message);
          const waiting = message.role === "assistant" && !message.content && ACTIVE_STATES.has(message.streamingState);
          return (
            <article
              className={`morrow-conversation-message morrow-conversation-message--${message.role}`}
              data-testid={`conversation-message-${message.role}`}
              key={message.id}
            >
              {message.role === "assistant" ? <p className="morrow-conversation-message__author">Morrow</p> : null}
              {/* An assistant turn with narration renders as the interleaved
                  transcript — its words and its actions in run order. The flat
                  body is the fallback for turns that produced no narration
                  entries (a plain answer with no tools, or history recorded
                  before the transcript projection existed), so nothing that
                  used to be readable stops being readable. */}
              {message.role === "assistant" && message.taskId && transcripts.has(message.taskId) ? (
                <ConversationTranscript
                  entries={activityByTask.get(message.taskId) ?? []}
                  streaming={ACTIVE_STATES.has(message.streamingState)}
                />
              ) : (
                <>
                  {message.role === "assistant" && message.taskId ? (
                    <ConversationActivity entries={activityByTask.get(message.taskId) ?? []} />
                  ) : null}
                  <div className={`morrow-conversation-message__content${message.role === "assistant" ? " morrow-conversation-message__content--markdown" : ""}`}>
                    {waiting ? <p>Morrow is responding…</p> : message.role === "assistant" ? (
                      <Markdown streaming={ACTIVE_STATES.has(message.streamingState)} text={message.content} />
                    ) : <p>{message.content}</p>}
                  </div>
                </>
              )}
              {showReasoning && message.role === "assistant" && message.taskId ? (
                <ReasoningDisclosure
                  active={ACTIVE_STATES.has(message.streamingState)}
                  conversationId={conversationId}
                  projectId={projectId}
                  taskId={message.taskId}
                />
              ) : null}
              {label ? <p className="morrow-conversation-message__route">{label}</p> : null}
              {message.taskId && RETRYABLE_STATES.has(message.streamingState) ? (
                <button disabled={actionBusy} onClick={() => { void retry(message.taskId!); }} type="button">Retry response</button>
              ) : null}
            </article>
          );
        })}
      </div>

      {activeMessages.map((message) => (
        <TaskStream conversationId={conversationId} key={message.taskId} projectId={projectId} taskId={message.taskId!} />
      ))}

      <PendingApprovals
        active={activeTaskId !== undefined}
        conversationId={conversationId}
        conversationTaskIds={conversationTaskIds}
        projectId={projectId}
      />

      <div className="morrow-conversation-composer">
        <ChatComposer
          activeTaskId={activeTaskId}
          autoFocus
          contextTaskId={latestTaskId}
          draftScope={{ projectId, conversationId }}
          modelCatalogue={modelCatalogue}
          onStop={stop}
          onShowReasoningChange={setShowReasoning}
          onReasoningConfigChange={setReasoningConfig}
          reasoningConfig={reasoningConfig}
          onSubmit={submit}
          showReasoning={showReasoning}
          placeholder="Reply to Morrow…"
        />
      </div>

      <div aria-hidden="true" className="morrow-conversation-autoscroll-sentinel" ref={sentinelRef} />

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
