import type { Conversation, WebConversationMessage } from "@morrow/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Archive, Pencil, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useChatTaskStream } from "../../api/chat-stream.js";
import {
  conversationApi,
  conversationKeys,
  conversationQueries,
  pendingWebMessage,
} from "../../api/conversations.js";
import { ApiClientError } from "../../api/client.js";
import { ChatComposer, type ChatComposerSubmission } from "./chat-composer.js";

const ACTIVE_STATES = new Set(["queued", "streaming"]);
const RETRYABLE_STATES = new Set(["failed", "interrupted"]);

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

export interface ConversationPageContentProps {
  projectId: string;
  conversationId: string;
  onDeleted: () => void;
}

export function ConversationPageContent({ projectId, conversationId, onDeleted }: ConversationPageContentProps) {
  const queryClient = useQueryClient();
  const conversation = useQuery(conversationQueries.detail(projectId, conversationId));
  const messages = useQuery(conversationQueries.messages(projectId, conversationId));
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const renameButtonRef = useRef<HTMLButtonElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const restoreRenameFocus = useRef(false);
  const restoreDeleteFocus = useRef(false);
  const cancellationRequests = useRef(new Set<string>());

  const history = messages.data ?? [];
  const activeMessages = useMemo(
    () => history.filter((message) => message.taskId && ACTIVE_STATES.has(message.streamingState)),
    [history],
  );
  const activeTaskId = activeMessages.at(-1)?.taskId ?? undefined;

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
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>, close: () => void) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    close();
  };

  async function submit(submission: ChatComposerSubmission) {
    try {
      const result = await conversationApi.sendMessage(projectId, conversationId, {
        content: submission.content,
        mode: submission.mode,
        autoApprove: submission.autoApprove,
        ...(submission.preset ? { preset: submission.preset } : {}),
        ...(submission.providerId ? { providerId: submission.providerId } : {}),
        ...(submission.model ? { model: submission.model } : {}),
      });
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
      await queryClient.invalidateQueries({ queryKey: conversationKeys.messages(projectId, conversationId) });
    } finally {
      cancellationRequests.current.delete(taskId);
    }
  }

  async function retry(taskId: string) {
    setActionBusy(true);
    setActionMessage(null);
    try {
      await conversationApi.retry(projectId, conversationId, taskId);
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
      setDeleteOpen(false);
      onDeleted();
    } catch (error) {
      setActionMessage(safeError(error, "The conversation could not be deleted. Stop any active response and try again."));
      setDeleteOpen(false);
      queueMicrotask(() => deleteButtonRef.current?.focus());
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
  return (
    <section aria-labelledby="conversation-heading" className="morrow-conversation-page">
      <header className="morrow-conversation-header">
        <h1 id="conversation-heading">{value.title}</h1>
        <div aria-label="Conversation actions" className="morrow-conversation-actions">
          <button aria-label="Rename conversation" disabled={actionBusy} onClick={openRename} ref={renameButtonRef} type="button"><Pencil aria-hidden="true" size={16} /></button>
          <button aria-label={value.archived ? "Restore conversation" : "Archive conversation"} disabled={actionBusy} onClick={() => { void toggleArchive(); }} type="button"><Archive aria-hidden="true" size={16} /></button>
          <button aria-label="Delete conversation" disabled={actionBusy} onClick={() => { setActionMessage(null); setDeleteOpen(true); }} ref={deleteButtonRef} type="button"><Trash2 aria-hidden="true" size={16} /></button>
        </div>
      </header>

      {(conversation.isRefetchError && conversation.data) || (messages.isRefetchError && messages.data) ? (
        <p className="morrow-chat-warning" role="status">Morrow could not refresh this conversation. Showing saved history.</p>
      ) : null}
      {actionMessage ? <p aria-live="polite" role={actionMessage.includes("could not") ? "alert" : "status"}>{actionMessage}</p> : null}

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
              <div className="morrow-conversation-message__content">
                {waiting ? <p>Morrow is responding…</p> : <p>{message.content}</p>}
              </div>
              {label ? <p className="morrow-conversation-message__route">{label}</p> : null}
              {message.toolActivity.length > 0 ? (
                <ul aria-label="Tool activity" className="morrow-conversation-tools">
                  {message.toolActivity.map((tool) => <li key={tool.id}>{tool.toolName.replaceAll("_", " ")} · {tool.status}</li>)}
                </ul>
              ) : null}
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

      <div className="morrow-conversation-composer">
        <ChatComposer
          activeTaskId={activeTaskId}
          autoFocus
          draftScope={{ projectId, conversationId }}
          onStop={stop}
          onSubmit={submit}
          placeholder="Reply to Morrow…"
        />
      </div>

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

export function ConversationPage() {
  const { conversationId } = useParams({ strict: false }) as { conversationId?: string };
  const search = useSearch({ strict: false }) as { projectId?: string };
  const navigate = useNavigate();
  if (!conversationId || !search.projectId) {
    return (
      <section className="morrow-conversation-page">
        <h1>Conversation unavailable</h1>
        <p role="alert">Open this conversation from its project so Morrow can verify its local ownership.</p>
      </section>
    );
  }
  return (
    <ConversationPageContent
      conversationId={conversationId}
      onDeleted={() => { void navigate({ to: "/" }); }}
      projectId={search.projectId}
    />
  );
}
