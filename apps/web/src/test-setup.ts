import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

window.scrollTo = () => undefined;
Element.prototype.scrollIntoView = () => undefined;

class IntersectionObserverStub {
  constructor(_: IntersectionObserverCallback, __?: IntersectionObserverInit) {}
  disconnect() {}
  observe(_: Element) {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  unobserve(_: Element) {}
}

window.IntersectionObserver = IntersectionObserverStub as unknown as typeof IntersectionObserver;

afterEach(() => {
  cleanup();
});
