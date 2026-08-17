import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface ConversationAutoscrollInput {
  history: unknown;
  transcript: string;
  activeTaskId?: string | undefined;
}

export interface ConversationAutoscroll {
  /** Attach to the element that actually scrolls the conversation. Optional:
   * without it the hook falls back to the document scrolling element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  resume: () => void;
  isPinned: boolean;
  showJumpButton: boolean;
}

/** How close to the bottom still counts as "reading the latest". */
const BOTTOM_TOLERANCE = 24;

/**
 * Keeps a live conversation at its newest message until someone reads older
 * content, and then stays out of the way.
 *
 * Two rules, in this order:
 *
 * 1. Scrolling upward hands control to the reader immediately. Nothing the
 *    stream does afterwards moves the viewport — not a new token, not a tool
 *    row completing, not a disclosure expanding above the fold.
 * 2. Returning to the bottom hands control back. That is the only way to
 *    re-engage other than the explicit Jump to latest control, so following
 *    can never resume as a surprise.
 *
 * Downward scrolling is deliberately not treated as disengagement: a reader
 * chasing the output is agreeing with the follow behaviour, not fighting it.
 */
export function useConversationAutoscroll({
  history,
  transcript,
  activeTaskId,
}: ConversationAutoscrollInput): ConversationAutoscroll {
  const containerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const pinnedToLatest = useRef(true);
  const previousScrollHeight = useRef<number | null>(null);
  const [isPinned, setIsPinned] = useState(true);

  const scrollRoot = useCallback(
    (): Element => containerRef.current ?? document.scrollingElement ?? document.documentElement,
    [],
  );

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
    const container = containerRef.current;

    const setPinned = (pinned: boolean) => {
      pinnedToLatest.current = pinned;
      setIsPinned(pinned);
    };
    const atBottom = () => {
      const root = scrollRoot();
      return root.scrollTop + root.clientHeight >= root.scrollHeight - BOTTOM_TOLERANCE;
    };
    const updatePinnedState = () => setPinned(atBottom());
    const pauseFollowing = () => setPinned(false);
    // Only an upward gesture is a request to stop following; chasing the
    // output downward is not.
    const pauseOnUpwardWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) pauseFollowing();
    };
    const pauseOnUpwardTouch = () => {
      if (!atBottom()) pauseFollowing();
    };
    const pauseForKeyboardScroll = (event: KeyboardEvent) => {
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) pauseFollowing();
    };

    const observer = typeof IntersectionObserver === "undefined"
      ? null
      : new IntersectionObserver(([entry]) => {
        setPinned(entry?.isIntersecting ?? true);
      }, { threshold: 1, ...(container ? { root: container } : {}) });
    observer?.observe(sentinel);

    const scrollTarget: EventTarget = container ?? window;
    scrollTarget.addEventListener("scroll", updatePinnedState, { passive: true });
    scrollTarget.addEventListener("wheel", pauseOnUpwardWheel as EventListener, { passive: true });
    scrollTarget.addEventListener("touchmove", pauseOnUpwardTouch, { passive: true });
    window.addEventListener("keydown", pauseForKeyboardScroll);
    return () => {
      observer?.disconnect();
      scrollTarget.removeEventListener("scroll", updatePinnedState);
      scrollTarget.removeEventListener("wheel", pauseOnUpwardWheel as EventListener);
      scrollTarget.removeEventListener("touchmove", pauseOnUpwardTouch);
      window.removeEventListener("keydown", pauseForKeyboardScroll);
    };
  }, [scrollRoot]);

  useLayoutEffect(() => {
    const root = scrollRoot();
    const previousHeight = previousScrollHeight.current;
    // The viewport sitting above where the bottom used to be means the reader
    // moved it there between updates — a scroll this hook did not perform.
    if (previousHeight !== null && root.scrollTop + root.clientHeight < previousHeight - BOTTOM_TOLERANCE) {
      pinnedToLatest.current = false;
      setIsPinned(false);
    }
    if (pinnedToLatest.current) scrollToLatest();
    previousScrollHeight.current = root.scrollHeight;
  }, [activeTaskId, history, scrollRoot, scrollToLatest, transcript]);

  return { containerRef, sentinelRef, resume, isPinned, showJumpButton: !isPinned };
}
