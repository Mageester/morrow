import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * Node 26 added a built-in `localStorage` global that resolves to `undefined`
 * unless the process was started with `--localstorage-file`. Because it is a
 * *global* accessor it shadows the jsdom window's own Storage, so every suite
 * that touches localStorage throws `Cannot read properties of undefined` before
 * reaching its first assertion — 95 of them here, none of which are about
 * storage. Restore a real Storage when the platform hands us nothing.
 *
 * Deliberately scoped to the test harness: the application code is unchanged
 * and still talks to whatever Storage the browser provides.
 */
function installStorage(name: "localStorage" | "sessionStorage"): void {
  const existing = (globalThis as Record<string, unknown>)[name];
  if (existing !== undefined && existing !== null) return;
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key: string) => (entries.has(String(key)) ? entries.get(String(key))! : null),
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => { entries.delete(String(key)); },
    setItem: (key: string, value: string) => { entries.set(String(key), String(value)); },
  };
  Object.defineProperty(globalThis, name, { configurable: true, value: storage, writable: true });
}

installStorage("localStorage");
installStorage("sessionStorage");

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
