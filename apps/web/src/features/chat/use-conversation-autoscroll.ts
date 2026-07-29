import { useCallback, useEffect, useRef } from "react";

export interface ConversationAutoscrollInput {
  history: unknown;
  transcript: string;
  activeTaskId?: string | undefined;
}

export interface ConversationAutoscroll {
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  resume: () => void;
}

/**
 * Keeps a live conversation at its newest message until someone reads older
 * content. Reaching the bottom sentinel resumes following automatically.
 */
export function useConversationAutoscroll({
  history,
  transcript,
  activeTaskId,
}: ConversationAutoscrollInput): ConversationAutoscroll {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pinnedToLatest = useRef(true);

  const scrollToLatest = useCallback(() => {
    sentinelRef.current?.scrollIntoView({ block: "end" });
  }, []);

  const resume = useCallback(() => {
    pinnedToLatest.current = true;
    scrollToLatest();
  }, [scrollToLatest]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const updatePinnedState = () => {
      const bounds = sentinel.getBoundingClientRect();
      pinnedToLatest.current = bounds.top >= 0 && bounds.bottom <= window.innerHeight;
    };
    const pauseFollowing = () => { pinnedToLatest.current = false; };
    const pauseForKeyboardScroll = (event: KeyboardEvent) => {
      if ([" ", "ArrowUp", "PageUp", "Home"].includes(event.key)) pauseFollowing();
    };
    const observer = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(([entry]) => {
        pinnedToLatest.current = entry?.isIntersecting ?? true;
      }, { threshold: 1 });
    observer?.observe(sentinel);
    window.addEventListener("scroll", updatePinnedState, { passive: true });
    window.addEventListener("wheel", pauseFollowing, { passive: true });
    window.addEventListener("touchmove", pauseFollowing, { passive: true });
    window.addEventListener("keydown", pauseForKeyboardScroll);
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", updatePinnedState);
      window.removeEventListener("wheel", pauseFollowing);
      window.removeEventListener("touchmove", pauseFollowing);
      window.removeEventListener("keydown", pauseForKeyboardScroll);
    };
  }, []);

  useEffect(() => {
    if (pinnedToLatest.current) scrollToLatest();
  }, [activeTaskId, history, scrollToLatest, transcript]);

  return { sentinelRef, resume };
}
