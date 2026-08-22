import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/**
 * A dropdown panel that can never be clipped.
 *
 * The composer's floating panels used to be absolutely positioned inside the
 * chip bar, whose `overflow-x: auto` silently became a both-axis clip
 * container — every panel opened straight into it and vanished. This hook
 * renders nothing itself; it hands back positioning for a panel the caller
 * portals to `document.body`, anchored above (or, when there is no headroom,
 * below) its trigger with fixed coordinates that no ancestor overflow can
 * touch.
 *
 * Owns the full open lifecycle: toggle/close, outside-pointer dismissal,
 * Escape with focus restored to the trigger, and repositioning while open
 * (window resize, any scroll including inner scrollers, virtual viewport).
 */
export interface AnchoredPanel<T extends HTMLElement = HTMLElement> {
  open: boolean;
  toggle(): void;
  close(): void;
  /** Attach to the trigger element the panel anchors against. */
  anchorRef: RefObject<T | null>;
  /** Attach to the portaled panel element. */
  panelRef: RefObject<HTMLDivElement | null>;
  /** Spread onto the panel's style while open; undefined until positioned. */
  style: CSSProperties | undefined;
}

const EDGE_MARGIN = 8;

export function useAnchoredPanel<T extends HTMLElement = HTMLElement>({ gap = 8 }: { gap?: number } = {}): AnchoredPanel<T> {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | undefined>(undefined);
  const anchorRef = useRef<T | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const position = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const rect = anchor.getBoundingClientRect();
    // A trigger that has been hidden underneath us — a responsive rule dropping
    // its container at a breakpoint, most often. Because the panel is portaled
    // to the body it does not disappear with its trigger the way an in-flow
    // child would; anchoring to the resulting 0x0 rect at the origin strands it
    // in the top-left corner with nothing left on screen to close it. Follow
    // the trigger instead.
    //
    // An empty rect alone is not proof: environments without a layout engine
    // report every element as 0x0, which would close the panel the instant it
    // opened. `checkVisibility` is what separates "hidden" from "unmeasured",
    // and where it is unavailable the guard correctly declines to fire.
    const unrendered = rect.width === 0 && rect.height === 0
      && typeof anchor.checkVisibility === "function"
      && !anchor.checkVisibility();
    if (unrendered) {
      setOpen(false);
      return;
    }
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const panelWidth = panel.offsetWidth;
    const panelHeight = panel.offsetHeight;

    let left = rect.left;
    left = Math.min(left, viewportWidth - panelWidth - EDGE_MARGIN);
    left = Math.max(EDGE_MARGIN, left);

    // Open upward like the in-flow original; flip below only when there is
    // more room beneath than above, so short windows degrade gracefully.
    const headroom = rect.top;
    const footroom = viewportHeight - rect.bottom;
    const alignment = headroom >= footroom
      ? ({ bottom: viewportHeight - rect.top + gap, top: "auto" } as const)
      : ({ top: rect.bottom + gap, bottom: "auto" } as const);

    // No inline max-width: each panel's stylesheet already caps itself in vw,
    // so it cannot outgrow the viewport, and an inline value overrides that cap
    // rather than reinforcing it — it stretched the 340px Thinking popover to
    // 569px on a 1280px screen. Staying on screen is the left clamp's job.
    setStyle({
      ...alignment,
      left,
      position: "fixed",
      zIndex: 90,
    });
  }, [gap]);

  useLayoutEffect(() => {
    if (!open) return;
    // Measure and place before the browser paints so a freshly opened panel
    // never flashes at an unpositioned origin.
    position();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;

    const reposition = () => position();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    window.visualViewport?.addEventListener("resize", reposition);

    function isInside(target: Node): boolean {
      return Boolean(anchorRef.current?.contains(target) || panelRef.current?.contains(target));
    }
    function onPointerDown(event: PointerEvent) {
      if (!isInside(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeWithFocus();
      }
    }
    function closeWithFocus() {
      setOpen(false);
      anchorRef.current?.focus();
    }

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
      window.visualViewport?.removeEventListener("resize", reposition);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, position]);

  const toggle = useCallback(() => setOpen((value) => !value), []);
  const close = useCallback(() => setOpen(false), []);

  return { open, toggle, close, anchorRef, panelRef, style };
}
