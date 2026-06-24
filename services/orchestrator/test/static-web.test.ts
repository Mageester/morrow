import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/database.js";
import { TaskRunner } from "../src/runner.js";
import { buildServer } from "../src/server.js";

describe("packaged web UI", () => {
  let directory: string;
  let app: ReturnType<typeof buildServer>;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "morrow-static-web-"));
    mkdirSync(join(directory, "assets"));
    writeFileSync(join(directory, "index.html"), "<html><body>Morrow onboarding</body></html>");
    writeFileSync(join(directory, "assets", "app.js"), "console.log('morrow')");
    db = openDatabase(join(directory, "morrow.db"));
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), webDir: directory });
  });

  afterEach(async () => {
    await app.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it("serves the bundled UI and its SPA routes from the loopback server", async () => {
    const root = await app.inject({ method: "GET", url: "/" });
    const route = await app.inject({ method: "GET", url: "/onboarding" });
    const asset = await app.inject({ method: "GET", url: "/assets/app.js" });

    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("Morrow onboarding");
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain("Morrow onboarding");
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain("console.log");
  });
});
