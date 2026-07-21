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
      <main id="main-content" tabIndex={-1}>
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
        onDiagnostics={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toBeVisible();
    expect(screen.getByText(/work is preserved/i)).toBeVisible();
    expect(screen.getByText(/what happens next/i)).toBeVisible();
    expect(screen.getByText(/trace-safe-42/i)).toBeVisible();
    expect(screen.getByRole("button", { name: /retry/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /diagnostics/i })).toBeEnabled();
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
});

// Keep the package import exercised: Task 10 must compose the shared primitive,
// not replace it with a web-only error presentation.
void ErrorCard;
