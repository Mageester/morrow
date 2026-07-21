import { z } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, api } from "./client.js";
import { missionQueries } from "./query-keys.js";

const resultSchema = z.object({ value: z.string() }).strict();

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("typed API client", () => {
  it("uses same-origin credentials and JSON content type for GET requests", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ value: "ok" }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.get("/api/example", resultSchema)).resolves.toEqual({
      value: "ok",
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [path, init] = fetchMock.mock.calls[0] ?? [];
    expect(path).toBe("/api/example");
    expect(init?.credentials).toBe("same-origin");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("serializes POST bodies without changing credential behavior", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ value: "created" }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.post("/api/example", { objective: "Help" }, resultSchema);

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.credentials).toBe("same-origin");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ objective: "Help" }));
    expect(new Headers(init?.headers).get("content-type")).toBe(
      "application/json",
    );
  });

  it("maps structured failures to an ApiClientError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            version: 1,
            error: {
              code: "MISSION_BLOCKED",
              message: "The mission needs a decision.",
            },
          },
          { headers: { "x-trace-id": "trace-42" }, status: 409 },
        ),
      ),
    );

    const error = await api
      .get("/api/web/missions/mission-42", resultSchema)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({
      code: "MISSION_BLOCKED",
      message: "The mission needs a decision.",
      status: 409,
      traceId: "trace-42",
    });
  });

  it("provides stable mission query keys for lists and workspaces", () => {
    expect(missionQueries.list("project/one").queryKey).toEqual([
      "missions",
      "list",
      "project/one",
    ]);
    expect(missionQueries.detail("mission-42").queryKey).toEqual([
      "missions",
      "detail",
      "mission-42",
    ]);
  });
});
