import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PairPage } from "./pair-page.js";

function renderPairPage(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <PairPage />
    </QueryClientProvider>,
  );
}

describe("PairPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redeems a code and shows a paired confirmation", async () => {
    let redeemedWith: unknown = null;
    renderPairPage(async (input, init) => {
      if (String(input) === "/api/pairing/redeem" && init?.method === "POST") {
        redeemedWith = JSON.parse(String(init.body));
        return Response.json({ version: 1, paired: true, accountId: "acct-1" });
      }
      throw new Error(`unexpected ${String(input)}`);
    });

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: /code from your morrow account dashboard/i }), "XKQ-9F2");
    await user.click(screen.getByRole("button", { name: /connect/i }));

    expect(await screen.findByText(/this install is now paired/i)).toBeVisible();
    expect(redeemedWith).toEqual({ code: "XKQ-9F2" });
  });

  it("surfaces an invalid/expired code as a real error, not a silent failure", async () => {
    renderPairPage(async () =>
      Response.json(
        { version: 1, error: { code: "PAIRING_CODE_INVALID", message: "Code not recognized or expired." } },
        { status: 404 },
      ),
    );

    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: /code from your morrow account dashboard/i }), "STALE");
    await user.click(screen.getByRole("button", { name: /connect/i }));

    expect(await screen.findByText(/code not recognized or expired/i)).toBeVisible();
  });
});
