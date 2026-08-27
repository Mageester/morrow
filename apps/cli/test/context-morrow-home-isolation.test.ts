import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/cli/args.js";
import { Context } from "../src/cli/context.js";
import { ConfigStore } from "../src/config/config.js";
import { Output } from "../src/cli/output.js";
import { readServiceRecord, writeServiceRecord } from "../src/service/record.js";

// Regression coverage for a real bug: MORROW_HOME isolated the *service* (which
// starts with --db $MORROW_HOME/morrow.db) but not the *client*. resolveService
// consulted flags, config, MORROW_BIND_HOST, PORT and MORROW_SERVICE_URL, and
// then fell straight through to the global default 4317 — so a CLI run against
// an isolated home silently drove whichever service owned that port, including
// the user's production one, backed by ~/.morrow/morrow.db.
describe("MORROW_HOME isolates the CLI's service target", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function isolatedHome() {
    const home = mkdtempSync(join(tmpdir(), "morrow-home-isolation-"));
    tempDirs.push(home);
    return home;
  }

  function contextForHome(home: string, argv: string[] = ["processes", "list"]) {
    const config = ConfigStore.load({ MORROW_HOME: home }, home);
    const parsed = parseArgs(argv, { valueFlags: ["port", "host"] });
    return new Context({
      out: new Output({ json: false, quiet: true, color: false }),
      config,
      paths: config.paths,
      flags: parsed.flags,
    });
  }

  it("targets the endpoint this home's service recorded, not the global default", () => {
    const home = isolatedHome();
    writeServiceRecord(join(home, "service.json"), "127.0.0.1", 4455);

    const ctx = contextForHome(home);

    expect(ctx.service.port).toBe(4455);
    expect(ctx.service.baseUrl).toBe("http://127.0.0.1:4455");
  });

  it("still uses the global default when the home has never run a service", () => {
    const ctx = contextForHome(isolatedHome());

    expect(ctx.service.port).toBe(4317);
    expect(ctx.service.baseUrl).toBe("http://127.0.0.1:4317");
  });

  it("lets an explicit --port override the recorded endpoint", () => {
    const home = isolatedHome();
    writeServiceRecord(join(home, "service.json"), "127.0.0.1", 4455);

    const ctx = contextForHome(home, ["processes", "list", "--port", "4999"]);

    expect(ctx.service.port).toBe(4999);
  });

  it("two isolated homes never resolve to each other's service", () => {
    const a = isolatedHome();
    const b = isolatedHome();
    writeServiceRecord(join(a, "service.json"), "127.0.0.1", 4455);
    writeServiceRecord(join(b, "service.json"), "127.0.0.1", 4466);

    expect(contextForHome(a).service.port).toBe(4455);
    expect(contextForHome(b).service.port).toBe(4466);
  });

  it("ignores a corrupt or partial service record rather than throwing", () => {
    const home = isolatedHome();
    const file = join(home, "service.json");
    rmSync(file, { force: true });
    expect(readServiceRecord(file)).toBeNull();

    writeServiceRecord(file, "127.0.0.1", 4455);
    expect(readServiceRecord(file)).toEqual({ host: "127.0.0.1", port: 4455 });
  });
});
