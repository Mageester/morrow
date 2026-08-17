import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ConversationAutoscrollInput {
  history: unknown;
  transcript: string;
  activeTaskId?: string | undefined;
}

export interface ConversationAutoscroll {
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  resume: () => void;
  isPinned: boolean;
  showJumpButton: boolean;
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
  const previousScrollHeight = useRef<number | null>(null);
  const [isPinned, setIsPinned] = useState(true);

  const scrollRoot = () => document.scrollingElement ?? document.documentElement;

  const scrollToLatest = useCallback(() => {
    sentinelRef.current?.scrollIntoView({ block: "end" });
  }, []);

  const resume = useCallback(() => {
    pinnedToLatest.current = true;
    setIsPinned(true);
    scrollToLatest();
  }, [scrollToLatest]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const updatePinnedState = () => {
      const root = scrollRoot();
      const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 16;
      pinnedToLatest.current = atBottom;
      setIsPinned(atBottom);
    };
    const pauseFollowing = () => {
      pinnedToLatest.current = false;
      setIsPinned(false);
    };
    const pauseForKeyboardScroll = (event: KeyboardEvent) => {
      if ([" ", "ArrowUp", "PageUp", "Home"].includes(event.key)) pauseFollowing();
    };
    const observer = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(([entry]) => {
        const intersecting = entry?.isIntersecting ?? true;
        pinnedToLatest.current = intersecting;
        setIsPinned(intersecting);
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

  useLayoutEffect(() => {
    const root = scrollRoot();
    const previousHeight = previousScrollHeight.current;
    if (previousHeight !== null && root.scrollTop + root.clientHeight < previousHeight - 16) {
      pinnedToLatest.current = false;
      setIsPinned(false);
    }
    if (pinnedToLatest.current) scrollToLatest();
    previousScrollHeight.current = root.scrollHeight;
  }, [activeTaskId, history, scrollToLatest, transcript]);

  return { sentinelRef, resume, isPinned, showJumpButton: !isPinned };
}
