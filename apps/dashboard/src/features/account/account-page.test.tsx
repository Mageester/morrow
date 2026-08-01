import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountPage } from "./account-page.js";

const useUser = vi.fn();
const useAuth = vi.fn();
vi.mock("@clerk/react", () => ({
  useUser: () => useUser(),
  useAuth: () => useAuth(),
}));

function renderAccountPage(fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AccountPage />
    </QueryClientProvider>,
  );
}

describe("AccountPage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the signed-in user's email", () => {
    useUser.mockReturnValue({ user: { primaryEmailAddress: { emailAddress: "aidan@example.com" } } });
    useAuth.mockReturnValue({ isLoaded: true, isSignedIn: true, getToken: async () => "session-token" });
    renderAccountPage(async () => {
      throw new Error("no fetch expected before interaction");
    });
    expect(screen.getByText("aidan@example.com")).toBeVisible();
  });

  it("generates and displays a real pairing code, sending the session token", async () => {
    let sentAuthHeader: string | null = null;
    useUser.mockReturnValue({ user: { primaryEmailAddress: { emailAddress: "aidan@example.com" } } });
    useAuth.mockReturnValue({ isLoaded: true, isSignedIn: true, getToken: async () => "session-token" });
    renderAccountPage(async (input, init) => {
      if (String(input) === "/api/pair/create" && init?.method === "POST") {
        sentAuthHeader = (init.headers as Record<string, string>).authorization ?? null;
        return Response.json({ code: "XKQ9F2", expiresInSeconds: 600 });
      }
      throw new Error(`unexpected ${String(input)}`);
    });

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /pair another install/i }));

    expect(await screen.findByText("XKQ9F2")).toBeVisible();
    expect(screen.getByText(/expires in 10 minutes/i)).toBeVisible();
    expect(sentAuthHeader).toBe("Bearer session-token");
  });

  it("surfaces a failed code generation as a real error", async () => {
    useUser.mockReturnValue({ user: { primaryEmailAddress: { emailAddress: "aidan@example.com" } } });
    useAuth.mockReturnValue({ isLoaded: true, isSignedIn: true, getToken: async () => "session-token" });
    renderAccountPage(async () =>
      Response.json({ error: { code: "UNAUTHORIZED", message: "Session expired." } }, { status: 401 }),
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /pair another install/i }));

    expect(await screen.findByText("Session expired.")).toBeVisible();
  });
});
