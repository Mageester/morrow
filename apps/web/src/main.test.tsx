import type { Root, RootOptions } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const rootMocks = vi.hoisted(() => {
  const render = vi.fn();
  const createRoot = vi.fn(
    (
      _container: Element | DocumentFragment,
      _options?: RootOptions,
    ): Root => ({ render }) as unknown as Root,
  );
  return { createRoot, render };
});

vi.mock("react-dom/client", () => ({ createRoot: rootMocks.createRoot }));
vi.mock("./app/router.js", () => ({ createAppRouter: vi.fn(() => ({})) }));

afterEach(() => {
  document.body.innerHTML = "";
  rootMocks.createRoot.mockClear();
  rootMocks.render.mockClear();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("React root error handling", () => {
  it("wires caught and uncaught handlers that never log raw error or component details", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await import("./main.js");

    const options = rootMocks.createRoot.mock.calls[0]?.[1];
    expect(options?.onCaughtError).toBeTypeOf("function");
    expect(options?.onUncaughtError).toBeTypeOf("function");

    options?.onCaughtError?.(
      new Error("Bearer caught-secret at C:\\private\\caught.ts"),
      {
        componentStack: "C:\\private\\Component.tsx\nBearer component-secret",
        errorBoundary: undefined,
      },
    );
    options?.onUncaughtError?.(
      new Error("sk-uncaught-secret at C:\\private\\uncaught.ts"),
      { componentStack: "Bearer uncaught-component-secret" },
    );

    const logged = JSON.stringify(consoleError.mock.calls);
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(logged).toMatch(/Morrow interface error/);
    expect(logged).toMatch(/correlationId/);
    expect(logged).not.toMatch(
      /caught-secret|uncaught-secret|component-secret|private|\.tsx|\.ts/,
    );
  });
});
