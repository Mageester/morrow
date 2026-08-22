import { describe, expect, it } from "vitest";
import { entryMatchesCommandLine } from "../src/service/lifecycle.js";

/**
 * Identifying the process behind a reachable Morrow service.
 *
 * `morrow stop` refused to stop a service it was talking to happily, because it
 * only recognised a process whose command line contained the launcher path and
 * the word "serve". A source checkout is launched as:
 *
 *   node --require .../tsx/preflight.cjs --import .../tsx/loader.mjs src/index.ts
 *
 * from the orchestrator package directory — the entry is RELATIVE, while
 * /api/health reports it absolute. Resolving the argument against the process's
 * working directory is what connects the two, and the resolved path must equal
 * the entry the service named for itself.
 */
describe("entryMatchesCommandLine", () => {
  // Verbatim from the process that caused this bug.
  const devCmdline =
    "/home/dread/.hermes/node/bin/node --require /home/dread/Code/morrow/node_modules/.pnpm/tsx@4.20.6/node_modules/tsx/dist/preflight.cjs " +
    "--import file:///home/dread/Code/morrow/node_modules/.pnpm/tsx@4.20.6/node_modules/tsx/dist/loader.mjs src/index.ts";
  const cwd = "/home/dread/Code/morrow/services/orchestrator";
  const entry = "/home/dread/Code/morrow/services/orchestrator/src/index.ts";

  it("matches a dev service whose entry is relative to its working directory", () => {
    expect(entryMatchesCommandLine(devCmdline, entry, cwd)).toBe(true);
  });

  it("still matches when the command line carries the absolute entry", () => {
    expect(entryMatchesCommandLine(`node ${entry}`, entry, null)).toBe(true);
  });

  it("does not match a different checkout of the same project", () => {
    // Same relative arg, different working directory: a second clone must not be
    // mistaken for this one, or stop would kill the wrong service.
    expect(entryMatchesCommandLine(devCmdline, entry, "/home/dread/Code/morrow-two/services/orchestrator")).toBe(false);
  });

  it("does not match on a bare filename", () => {
    // "index.ts" alone appears in far too many command lines to be evidence.
    expect(entryMatchesCommandLine("node index.ts", "/srv/app/index.ts", "/srv/app")).toBe(false);
  });

  it("refuses to guess when the working directory is unknown", () => {
    expect(entryMatchesCommandLine(devCmdline, entry, null)).toBe(false);
  });

  it("does not match an unrelated process that merely mentions a path", () => {
    expect(entryMatchesCommandLine("tail -f /var/log/syslog", entry, cwd)).toBe(false);
  });

  it("is not fooled by a token that resolves somewhere else", () => {
    expect(entryMatchesCommandLine("node ../other/src/index.ts", entry, cwd)).toBe(false);
  });
});
