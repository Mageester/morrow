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
    // Typed the way a person actually copies a six-character code off the
    // dashboard: lowercase, with a separator they assumed was part of it.
    // Codes carry no separator, so passing this through verbatim produced the
    // same "Code not recognized or expired." as a genuinely wrong code.
    await user.type(screen.getByRole("textbox", { name: /code from your morrow account dashboard/i }), "xkq-9f2");
    await user.click(screen.getByRole("button", { name: /connect/i }));

    expect(await screen.findByText(/this install is now paired/i)).toBeVisible();
    expect(redeemedWith).toEqual({ code: "XKQ9F2" });
  });

  it("keeps all six characters when the typed code contains a separator", async () => {
    let redeemedWith: unknown = null;
    renderPairPage(async (input, init) => {
      if (String(input) === "/api/pairing/redeem" && init?.method === "POST") {
        redeemedWith = JSON.parse(String(init.body));
        return Response.json({ version: 1, paired: true, accountId: "acct-1" });
      }
      throw new Error(`unexpected ${String(input)}`);
    });

    const user = userEvent.setup();
    // "ABC-234" is seven keystrokes for a six-character code. A maxLength of 6
    // on the input consumed the separator against the budget and silently
    // dropped the trailing "4", so a correctly copied code failed to redeem.
    await user.type(screen.getByRole("textbox", { name: /code from your morrow account dashboard/i }), "ABC-234");
    await user.click(screen.getByRole("button", { name: /connect/i }));

    expect(await screen.findByText(/this install is now paired/i)).toBeVisible();
    expect(redeemedWith).toEqual({ code: "ABC234" });
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
