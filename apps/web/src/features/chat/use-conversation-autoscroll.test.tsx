import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationAutoscroll } from "./use-conversation-autoscroll.js";

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  private target: Element | null = null;

  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }

  disconnect = vi.fn();
  observe = vi.fn((target: Element) => { this.target = target; });
  takeRecords = vi.fn(() => [] as IntersectionObserverEntry[]);
  unobserve = vi.fn();

  emit(isIntersecting: boolean) {
    if (!this.target) throw new Error("Sentinel not observed");
    this.callback([{ isIntersecting, target: this.target } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

function Harness({ history, transcript, activeTaskId }: { history: string; transcript: string; activeTaskId?: string }) {
  const { resume, sentinelRef } = useConversationAutoscroll({ history, transcript, activeTaskId });
  return <><button onClick={resume} type="button">Resume following</button><div ref={sentinelRef} /></>;
}

describe("useConversationAutoscroll", () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    Element.prototype.scrollIntoView = scrollIntoView;
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("stops while unpinned, follows again at bottom, and resumes when requested", () => {
    const { getByRole, rerender } = render(<Harness activeTaskId="task-1" history="first" transcript="first" />);
    const observer = FakeIntersectionObserver.instances[0]!;
    expect(observer.observe).toHaveBeenCalledTimes(1);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    act(() => observer.emit(false));
    rerender(<Harness activeTaskId="task-1" history="second" transcript="second" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    act(() => observer.emit(true));
    rerender(<Harness activeTaskId="task-1" history="third" transcript="third" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(2);

    act(() => observer.emit(false));
    fireEvent.click(getByRole("button", { name: "Resume following" }));
    rerender(<Harness activeTaskId="task-1" history="fourth" transcript="fourth" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(4);
  });

  it("stops when page position moved above its prior bottom between transcript updates", () => {
    scrollIntoView.mockClear();
    let scrollTop = 900;
    Object.defineProperties(document.documentElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 },
      scrollTop: { configurable: true, get: () => scrollTop },
    });
    const { rerender } = render(<Harness activeTaskId="task-1" history="first" transcript="first" />);
    scrollTop = 300;
    rerender(<Harness activeTaskId="task-1" history="second" transcript="second" />);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
