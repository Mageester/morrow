import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/config/config.js";
import { Output } from "../src/cli/output.js";
import { Context } from "../src/cli/context.js";
import { readPid, stop } from "../src/service/lifecycle.js";

describe("service lifecycle", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeContext(baseUrl: string) {
    const home = mkdtempSync(join(tmpdir(), "morrow-cli-lifecycle-"));
    tempDirs.push(home);
    const config = ConfigStore.load({ MORROW_HOME: home }, home);
    return new Context({
      out: new Output({ json: false, quiet: true, color: false }),
      config,
      paths: config.paths,
      flags: { url: baseUrl },
    });
  }

  it("rejects malformed pid files", () => {
    const home = mkdtempSync(join(tmpdir(), "morrow-cli-pid-"));
    tempDirs.push(home);
    const pidFile = join(home, "orchestrator.pid");
    writeFileSync(pidFile, "123abc\n");
    expect(readPid(pidFile)).toBeNull();
    writeFileSync(pidFile, "456\n");
    expect(readPid(pidFile)).toBe(456);
  });

  it("does not claim success for reachable unmanaged service", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, service: "morrow-orchestrator", apiVersion: 1, migrations: { applied: 5, latest: 5 } }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unexpected server address");
      const ctx = makeContext(`http://127.0.0.1:${address.port}`);

      await expect(stop(ctx)).rejects.toMatchObject({ code: "SERVICE_UNMANAGED" });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
