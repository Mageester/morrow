import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionsPage } from "../features/placeholders/connections-page.js";
import { RuntimeStatusProvider } from "./runtime-status.js";

interface Deferred<T> {
  promise: Promise<T>;
  reject: (reason?: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, reject, resolve };
}

function healthResponse(service = "morrow-orchestrator"): Response {
  return Response.json({ ok: true, service }, { status: 200 });
}

function renderConnections({ strict = false }: { strict?: boolean } = {}) {
  const content = (
    <RuntimeStatusProvider>
      <ConnectionsPage />
    </RuntimeStatusProvider>
  );
  return render(strict ? <StrictMode>{content}</StrictMode> : content);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RuntimeStatusProvider", () => {
  it("times out a hanging health check and enables another attempt", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderConnections();

    expect(screen.getByRole("status")).toHaveTextContent(
      "Checking the local Morrow runtime.",
    );
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The local Morrow runtime is unavailable.",
    );
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("aborts the active request during StrictMode cleanup", () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const view = renderConnections({ strict: true });
    const signals = fetchMock.mock.calls
      .map(([, init]) => init?.signal)
      .filter((signal): signal is AbortSignal => signal !== undefined);

    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals.some((signal) => signal.aborted)).toBe(true);

    view.unmount();

    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it("keeps the latest manual or online result when requests finish out of order", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const third = deferred<Response>();
    const fetchMock = vi
      .fn<(_input: RequestInfo | URL, _init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementationOnce(() => third.promise);
    vi.stubGlobal("fetch", fetchMock);

    renderConnections();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    window.dispatchEvent(new Event("online"));
    expect(fetchMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      third.resolve(healthResponse());
      await third.promise;
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "The local Morrow runtime is connected.",
    );

    await act(async () => {
      first.resolve(new Response(null, { status: 503 }));
      second.resolve(new Response(null, { status: 503 }));
      await Promise.all([first.promise, second.promise]);
    });

    expect(screen.getByRole("status")).toHaveTextContent(
      "The local Morrow runtime is connected.",
    );
  });

  it("announces checking-to-result changes in a polite status region", async () => {
    const response = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => response.promise));

    renderConnections();

    const visibleStatus = screen.getByRole("status");
    expect(visibleStatus).toHaveAttribute("aria-live", "polite");
    expect(visibleStatus).toHaveTextContent(
      "Checking the local Morrow runtime.",
    );

    await act(async () => {
      response.resolve(healthResponse());
      await response.promise;
    });

    expect(visibleStatus).toHaveTextContent(
      "The local Morrow runtime is connected.",
    );
  });

  it("rejects a health payload for an unexpected service", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => healthResponse("different-service")),
    );

    renderConnections();

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "The local Morrow runtime is unavailable.",
      );
    });
  });
});
