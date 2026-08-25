import type { WebProcess } from "@morrow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProcessDock } from "./process-dock.js";

function job(over: Partial<WebProcess> = {}): WebProcess {
  return {
    id: "proc-1",
    projectId: "project-1",
    taskId: null,
    agentId: null,
    command: "pnpm",
    args: ["dev"],
    cwd: "/w",
    mode: "pipe",
    pid: 4242,
    status: "running",
    exitCode: null,
    runId: "run-1",
    detail: null,
    startedAt: new Date(Date.now() - 74_000).toISOString(),
    endedAt: null,
    createdAt: new Date().toISOString(),
    endpoints: [],
    ...over,
  };
}

function renderDock() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProcessDock projectId="project-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ProcessDock", () => {
  it("offers the address that actually reaches a running server", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/processes")) {
        return new Response(JSON.stringify([job({
          endpoints: [
            { url: "http://192.168.1.9:5173", host: "192.168.1.9", port: 5173, rewritten: false },
            { url: "http://localhost:5173", host: "localhost", port: 5173, rewritten: false },
          ],
        })]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected request ${String(input)}`);
    }));
    renderDock();

    const link = await screen.findByRole("link");
    // Loopback over the LAN address: only one of a machine's IPs is guaranteed
    // to reach the process, and the reader should not have to know which.
    expect(link).toHaveAttribute("href", "http://localhost:5173");
    expect(link).toHaveTextContent("localhost:5173");
    expect(await screen.findByText("pnpm dev")).toBeVisible();
    expect(await screen.findByText("1m 14s")).toBeVisible();
  });

  it("admits a rewritten wildcard bind rather than quietly showing a different address", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([job({
      endpoints: [{ url: "http://127.0.0.1:3000", host: "127.0.0.1", port: 3000, rewritten: true }],
    })]), { status: 200, headers: { "Content-Type": "application/json" } })));
    renderDock();

    const link = await screen.findByRole("link");
    expect(link.getAttribute("title")).toContain("bound every interface");
  });

  it("says an address is not known yet instead of rendering a dead link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([job()]), {
      status: 200, headers: { "Content-Type": "application/json" },
    })));
    renderDock();

    expect(await screen.findByText("no address announced yet")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows nothing at all when no job is running", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([
      job({ status: "exited", exitCode: 0 }),
      job({ id: "proc-2", status: "failed", exitCode: 1 }),
    ]), { status: 200, headers: { "Content-Type": "application/json" } })));
    const { container } = renderDock();

    // A finished job is history. The shelf sits above the composer and must not
    // accumulate rows for things that are no longer happening.
    await waitFor(() => expect(container.querySelector("[data-testid='process-dock']")).toBeNull());
  });

  it("reads the job's own output on request, and each stream separately", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.includes("/output")) {
        requested.push(new URL(path, "http://x").searchParams.get("stream")!);
        const stderr = path.includes("stderr");
        return new Response(JSON.stringify({
          processId: "proc-1",
          stream: stderr ? "stderr" : "stdout",
          data: stderr ? "EADDRINUSE :5173" : "VITE v5.4.2 ready",
          nextOffset: 17,
          eof: false,
          truncated: false,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([job()]), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const user = userEvent.setup();
    renderDock();

    // Nothing is fetched until asked for: a dev server can print megabytes and
    // the dock is on screen for the whole session.
    await screen.findByTestId("process-row");
    expect(requested).toEqual([]);

    await user.click(screen.getByRole("button", { name: /Logs/ }));
    expect(await screen.findByTestId("process-log")).toHaveTextContent("VITE v5.4.2 ready");

    await user.click(screen.getByRole("tab", { name: "stderr" }));
    // Why a server failed to come up is usually on stderr, which is exactly the
    // question a stopped server raises.
    expect(await screen.findByTestId("process-log")).toHaveTextContent("EADDRINUSE :5173");
    expect(requested).toEqual(["stdout", "stderr"]);
  });

  it("renders a coloured server banner as text, not as escape-code garbage", async () => {
    const esc = String.fromCharCode(27);
    const banner = `  ${esc}[32m>${esc}[39m  ${esc}[1mLocal${esc}[22m:   ${esc}[36mhttp://localhost:${esc}[1m5173${esc}[22m/${esc}[39m`;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/output")) {
        return new Response(JSON.stringify({
          processId: "proc-1", stream: "stdout", data: banner, nextOffset: 1, eof: false, truncated: false,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify([job()]), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const user = userEvent.setup();
    renderDock();

    await user.click(await screen.findByRole("button", { name: /Logs/ }));
    const log = await screen.findByTestId("process-log");
    // Dev servers colour their output. A browser cannot act on those bytes, so
    // rendering them raw turns a startup banner into what looks like corruption.
    expect(log.textContent).toContain("Local:   http://localhost:5173/");
    expect(log.textContent).not.toContain(esc);
    expect(log.textContent).not.toContain("[32m");
  });

  it("stops a job through the supervisor and reports a refusal honestly", async () => {
    const posts: string[] = [];
    let failNext = true;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (init?.method === "POST" && path.includes("/terminate")) {
        posts.push(path);
        if (failNext) {
          failNext = false;
          return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 409 });
        }
        return new Response(JSON.stringify({ status: "terminating", processId: "proc-1", forced: false }), {
          status: 202, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify([job()]), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const user = userEvent.setup();
    renderDock();

    const row = await screen.findByTestId("process-row");
    await user.click(within(row).getByRole("button", { name: /Stop/ }));
    // A refused stop is surfaced. Silently leaving the row in place would read
    // as "nothing happened" for a process that is still holding a port.
    expect(await screen.findByRole("alert")).toHaveTextContent("could not stop");

    await user.click(within(row).getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(posts).toHaveLength(2));
  });
});
