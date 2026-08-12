import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { buildServer } from "../src/server.js";

describe("memory settings API", () => {
  let db: ReturnType<typeof openDatabase>;
  let app: ReturnType<typeof buildServer>;

  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db) });
  });

  afterEach(() => {
    void app.close();
    db.close();
  });

  it("defaults automatic memory on and persists an explicit opt-out", async () => {
    const initial = await app.inject({ method: "GET", url: "/api/memory/settings" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ autoCapture: true });

    const changed = await app.inject({
      method: "PATCH",
      url: "/api/memory/settings",
      payload: { autoCapture: false },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ autoCapture: false });

    const reloaded = await app.inject({ method: "GET", url: "/api/memory/settings" });
    expect(reloaded.json()).toEqual({ autoCapture: false });
  });

  it("rejects unknown memory settings", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/memory/settings",
      payload: { autoCapture: true, uploadMemories: true },
    });
    expect(response.statusCode).toBe(400);
  });
});
