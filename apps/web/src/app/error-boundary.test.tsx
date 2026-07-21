import { ErrorCard } from "@morrow/ui";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError } from "../api/client.js";
import {
  ActionableErrorCard,
  GlobalErrorBoundary,
  toErrorCard,
} from "./error-boundary.js";

class ThrowingChild extends Component<{ shouldThrow: () => boolean }> {
  override render(): ReactNode {
    if (this.props.shouldThrow()) {
      throw new Error(
        "Bearer super-secret-token at C:\\private\\source.ts:42",
      );
    }
    return (
      <main
        data-error-boundary-focus-target="true"
        id="main-content"
        tabIndex={-1}
      >
        Mission state restored
      </main>
    );
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("error card conversion", () => {
  it.each([
    [
      new ApiClientError(
        503,
        "RUNTIME_UNAVAILABLE",
        "The local service is offline.",
        "trace-runtime",
      ),
      "Morrow is not connected",
      true,
      "trace-runtime",
    ],
    [
      new ApiClientError(
        503,
        "SERVICE_UNAVAILABLE",
        "The service could not finish.",
        "trace-server",
      ),
      "Morrow could not complete that action",
      true,
      "trace-server",
    ],
    [
      new ApiClientError(
        400,
        "INVALID_CHOICE",
        "Bearer client-secret must never render.",
        "trace-client",
      ),
      "Morrow could not complete that action",
      false,
      "trace-client",
    ],
    [
      new Error("Bearer unknown-secret"),
      "Morrow could not complete that action",
      true,
      null,
    ],
  ])(
    "maps runtime, server, permanent client, and unknown errors safely",
    (error, title, retryable, traceId) => {
      expect(toErrorCard(error)).toMatchObject({
        retryable,
        title,
        traceId,
      });
      expect(JSON.stringify(toErrorCard(error))).not.toMatch(
        /unknown-secret|client-secret/,
      );
    },
  );

  it("renders the complete shared error-card contract and a safe trace reference", () => {
    const refresh = vi.fn();
    const retry = vi.fn();
    render(
      <ActionableErrorCard
        error={
          new ApiClientError(
            503,
            "SERVICE_UNAVAILABLE",
            "The service could not finish.",
            "trace-safe-42",
          )
        }
        onRefresh={refresh}
        onRetry={retry}
      />,
    );

    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByText(/synchronized work remains available/i)).toBeVisible();
    expect(screen.getByText(/what happens next/i)).toBeVisible();
    expect(screen.getByText(/trace-safe-42/i)).toBeVisible();
    const action = screen.getByRole("button", {
      name: "Refresh mission state",
    });
    expect(action).toBeEnabled();
    expect(
      screen.queryByRole("button", { name: /diagnostics/i }),
    ).not.toBeInTheDocument();
    fireEvent.click(action);
    expect(refresh).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(screen.getByText(/reload authoritative state/i)).toBeVisible();
  });

  it("never promises a diagnostics action in generic fallback copy", () => {
    expect(JSON.stringify(toErrorCard(new Error("private")))).not.toMatch(
      /diagnostics/i,
    );
  });
});

describe("GlobalErrorBoundary", () => {
  it("hides render error details, focuses recovery, and restores focus after retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    let shouldThrow = true;
    const view = render(
      <GlobalErrorBoundary>
        <ThrowingChild shouldThrow={() => shouldThrow} />
      </GlobalErrorBoundary>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveFocus();
    expect(screen.queryByText(/super-secret-token/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/source\.ts/i)).not.toBeInTheDocument();
    expect(screen.getByText(/mission state is still safe/i)).toBeVisible();

    shouldThrow = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry Morrow" }));

    expect(await screen.findByText("Mission state restored")).toBeVisible();
    await waitFor(() => {
      expect(document.getElementById("main-content")).toHaveFocus();
    });

    view.unmount();
  });

  it("keeps focus on the replacement error card when retry rethrows", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const requestFrame = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation(() => 42);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    const view = render(
      <GlobalErrorBoundary>
        <ThrowingChild shouldThrow={() => true} />
      </GlobalErrorBoundary>,
    );

    expect(await screen.findByRole("alert")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Retry Morrow" }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveFocus();
    });
    expect(requestFrame).toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(
      document.querySelector('[data-error-boundary-focus-target="true"]'),
    ).not.toBeInTheDocument();
    view.unmount();
  });
});

// Keep the package import exercised: Task 10 must compose the shared primitive,
// not replace it with a web-only error presentation.
void ErrorCard;
