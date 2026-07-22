import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useRef, useState } from "react";
import { conversationApi } from "../../api/conversations.js";

export interface NewChatButtonProps {
  projectId?: string | undefined;
  /** Extra classes for the button so callers can size it (Home vs sidebar). */
  className?: string | undefined;
}

/**
 * Starts exactly one new conversation and moves the user straight into it.
 *
 * With no project there is nothing to own the conversation, so the control is
 * disabled with an explanation rather than failing on click. When a project is
 * present the navigation-capable variant is mounted; keeping the router hook out
 * of the no-project branch lets the disabled state render without a router.
 */
export function NewChatButton({ projectId, className }: NewChatButtonProps) {
  if (!projectId) {
    return (
      <div className="morrow-new-chat">
        <button
          className={`morrow-new-chat__button${className ? ` ${className}` : ""}`}
          disabled
          type="button"
        >
          <Plus aria-hidden="true" size={16} strokeWidth={2} />
          <span>New chat</span>
        </button>
        <p className="morrow-new-chat__hint">
          Open a local project before starting a chat.
        </p>
      </div>
    );
  }
  return <ActiveNewChatButton className={className} projectId={projectId} />;
}

function ActiveNewChatButton({ projectId, className }: { projectId: string; className?: string | undefined }) {
  const navigate = useNavigate();
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => conversationApi.create(projectId),
    onSuccess: (conversation) => {
      setError(null);
      void navigate({
        params: { conversationId: conversation.id },
        search: { projectId },
        to: "/chats/$conversationId",
      });
    },
    onError: () => {
      setError("Morrow could not create a new chat. Check the connection and try again.");
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });

  // A synchronous guard so a double click (or a rerender-driven double submit)
  // can never create two conversations, even before `isPending` has propagated.
  function start() {
    if (inFlight.current) return;
    inFlight.current = true;
    setError(null);
    create.mutate();
  }

  return (
    <div className="morrow-new-chat">
      <button
        className={`morrow-new-chat__button${className ? ` ${className}` : ""}`}
        disabled={create.isPending}
        onClick={start}
        type="button"
      >
        <Plus aria-hidden="true" size={16} strokeWidth={2} />
        <span>New chat</span>
      </button>
      {error ? (
        <div className="morrow-new-chat__error">
          <p role="alert">{error}</p>
          <button className="morrow-new-chat__retry" onClick={start} type="button">
            Try again
          </button>
        </div>
      ) : null}
    </div>
  );
}
