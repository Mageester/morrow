import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserController, BrowserEvidence, PageSnapshot } from "../src/browser/types.js";
import {
  runVerification,
  serviceUrlFromOutput,
  isLoopbackUrl,
  GATE_VIEWPORTS,
  type ServiceHandle,
} from "../src/mission/evidence-runner.js";

/**
 * Service, API-health and browser gates.
 *
 * A working server never exits, so running `npm start` through the command
 * executor could only ever burn the whole timeout and then kill the server —
 * after which every API probe and browser render hit ECONNREFUSED. Observed
 * live: two 300s `node server.js` calls followed by
 * `net::ERR_CONNECTION_REFUSED`, on an app that genuinely worked. A service
 * gate has to start it, prove it answers, and always stop it again.
 */

const roots: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));

function fakeService(opts: { output?: string; exitAfter?: number } = {}) {
  let stopped = 0;
  let polls = 0;
  const handle: ServiceHandle = {
    output: () => opts.output ?? "Server listening at http://127.0.0.1:4599/",
    exited: () => {
      polls += 1;
      return opts.exitAfter !== undefined && polls > opts.exitAfter ? { code: 1 } : null;
    },
    stop: async () => { stopped += 1; },
  };
  return { handle, stops: () => stopped };
}

function fakeBrowser(opts: { text?: string; refs?: number; evidence?: BrowserEvidence[] } = {}) {
  const viewports: string[] = [];
  const opened: string[] = [];
  let closed = 0;
  const snapshot = (width: number, height: number): PageSnapshot => ({
    url: "http://127.0.0.1:4599/",
    title: "Taskflow",
    viewport: { width, height },
    refs: Array.from({ length: opts.refs ?? 3 }, (_, i) => ({ ref: `ref_${i}`, role: "button", name: `b${i}` })),
    text: opts.text ?? "Taskflow tasks",
    injectionFindings: 0,
  });
  let current = { width: 0, height: 0 };
  const controller = {
    id: "test-browser",
    start: async () => undefined,
    open: async (url: string) => { opened.push(url); return snapshot(current.width, current.height); },
    snapshot: async () => snapshot(current.width, current.height),
    setViewport: async (viewport: { width: number; height: number }) => {
      current = viewport;
      viewports.push(`${viewport.width}x${viewport.height}`);
    },
    click: async () => undefined,
    type: async () => undefined,
    key: async () => undefined,
    select: async () => undefined,
    upload: async () => undefined,
    download: async () => ({ path: "", filename: "" }),
    setDialogHandler: async () => undefined,
    screenshot: async () => Buffer.alloc(0),
    evidence: () => opts.evidence ?? [],
    pause: async () => undefined,
    resume: async () => undefined,
    panic: async () => undefined,
    close: async () => { closed += 1; },
  } satisfies BrowserController;
  return { controller, viewports, opened, closes: () => closed };
}

describe("service startup + API health gate", () => {
  it("starts the service, proves it answers, and stops it again", async () => {
    const service = fakeService();
    const outcome = await runVerification(
      { kind: "runtime", command: "npm start", service: true, describe: "npm start serves the API" },
      {
        workspacePath: tmp("gate-"),
        startService: async () => service.handle,
        httpProbe: async () => ({ status: 200, ok: true }),
      },
    );
    expect(outcome.status).toBe("passed");
    expect(outcome.summary).toContain("npm start");
    expect(outcome.type).toBe("runtime");
    // Always torn down: a gate must not leave a server holding a port.
    expect(service.stops()).toBe(1);
  });

  it("fails, and still stops the service, when the health probe never succeeds", async () => {
    const service = fakeService();
    const outcome = await runVerification(
      { kind: "runtime", command: "npm start", service: true },
      {
        workspacePath: tmp("gate-"),
        startService: async () => service.handle,
        httpProbe: async () => ({ status: 0, ok: false, error: "ECONNREFUSED" }),
        readinessTimeoutMs: 600,
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("did not serve");
    expect(service.stops()).toBe(1);
  });

  it("is bounded — an unreachable service cannot stall the mission", async () => {
    const service = fakeService();
    const started = Date.now();
    await runVerification(
      { kind: "runtime", command: "npm start", service: true },
      {
        workspacePath: tmp("gate-"),
        startService: async () => service.handle,
        httpProbe: async () => ({ status: 0, ok: false, error: "ECONNREFUSED" }),
        readinessTimeoutMs: 500,
      },
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reports a service that died before serving", async () => {
    const service = fakeService({ exitAfter: 0, output: "Error: cannot find module ./server\nhttp://127.0.0.1:4599/" });
    const outcome = await runVerification(
      { kind: "runtime", command: "npm start", service: true },
      {
        workspacePath: tmp("gate-"),
        startService: async () => service.handle,
        httpProbe: async () => ({ status: 0, ok: false, error: "ECONNREFUSED" }),
        readinessTimeoutMs: 600,
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("exited");
    expect(service.stops()).toBe(1);
  });

  it("fails when the service answers with the wrong status", async () => {
    const service = fakeService();
    const outcome = await runVerification(
      { kind: "runtime", command: "npm start", service: true, expectStatus: 200 },
      {
        workspacePath: tmp("gate-"),
        startService: async () => service.handle,
        httpProbe: async () => ({ status: 500, ok: false }),
        readinessTimeoutMs: 600,
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("500");
  });

  it("keeps a plain command a plain command", async () => {
    const outcome = await runVerification(
      { kind: "test", command: "npm test", expectExitCode: 0 },
      {
        workspacePath: tmp("gate-"),
        exec: async () => ({ exitCode: 0, output: "14 passing", timedOut: false }),
        startService: async () => { throw new Error("must not start a service for an exiting command"); },
      },
    );
    expect(outcome.status).toBe("passed");
  });
});

describe("service URL discovery", () => {
  it.each([
    ["Server listening at http://127.0.0.1:4319", "http://127.0.0.1:4319"],
    ["Running on http://localhost:3000/", "http://localhost:3000/"],
    ["Listening on port 3000", "http://127.0.0.1:3000/"],
    ["server started :8080", "http://127.0.0.1:8080/"],
  ])("reads %j", (output, expected) => {
    expect(serviceUrlFromOutput(output)).toBe(expected);
  });

  it("rewrites a bind address into an address to connect to", () => {
    expect(serviceUrlFromOutput("listening on http://0.0.0.0:5000/")).toBe("http://127.0.0.1:5000/");
  });

  it("returns null when nothing announced a URL", () => {
    expect(serviceUrlFromOutput("compiling...\ndone")).toBeNull();
  });

  it("is inconclusive when the service announces no URL", async () => {
    const service = fakeService({ output: "starting up" });
    const outcome = await runVerification(
      { kind: "runtime", command: "npm start", service: true },
      { workspacePath: tmp("gate-"), startService: async () => service.handle, readinessTimeoutMs: 500 },
    );
    expect(outcome.status).toBe("inconclusive");
    expect(service.stops()).toBe(1);
  });
});

describe("verification URLs are loopback-only", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1:8080/api", "https://[::1]:4000"])("allows %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(true);
  });

  it.each([
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.5/",
    "https://example.com/",
    "file:///etc/passwd",
    "not a url",
  ])("rejects %s", (url) => {
    expect(isLoopbackUrl(url)).toBe(false);
  });

  it("refuses to probe a criterion that names a remote URL", async () => {
    const outcome = await runVerification(
      { kind: "runtime", command: "npm start", service: true, url: "http://169.254.169.254/latest/meta-data/" },
      {
        workspacePath: tmp("gate-"),
        startService: async () => fakeService().handle,
        httpProbe: async () => { throw new Error("must never probe a remote URL"); },
      },
    );
    expect(outcome.status).toBe("inconclusive");
    expect(outcome.summary).toContain("non-local");
  });

  it("refuses to render a criterion that names a remote URL", async () => {
    const browser = fakeBrowser();
    const outcome = await runVerification(
      { kind: "browser", url: "https://example.com/" },
      { workspacePath: tmp("gate-"), browser: () => browser.controller },
    );
    expect(outcome.status).toBe("inconclusive");
    expect(browser.opened).toHaveLength(0);
  });
});

describe("browser render gate", () => {
  it("renders at the desktop and mobile viewports and passes", async () => {
    const service = fakeService();
    const browser = fakeBrowser();
    const outcome = await runVerification(
      { kind: "browser", command: "npm start", service: true, describe: "UI works at both viewports" },
      {
        workspacePath: tmp("gate-"),
        startService: async () => service.handle,
        httpProbe: async () => ({ status: 200, ok: true }),
        browser: () => browser.controller,
      },
    );
    expect(outcome.status).toBe("passed");
    expect(browser.viewports).toEqual(["1280x800", "375x812"]);
    expect(GATE_VIEWPORTS.map((v) => `${v.width}x${v.height}`)).toEqual(["1280x800", "375x812"]);
    expect(browser.opened).toHaveLength(2);
    // Both the browser and the service are released.
    expect(browser.closes()).toBe(1);
    expect(service.stops()).toBe(1);
  });

  it("fails when the page renders nothing", async () => {
    const browser = fakeBrowser({ text: "   ", refs: 0 });
    const outcome = await runVerification(
      { kind: "browser", url: "http://127.0.0.1:4599/" },
      { workspacePath: tmp("gate-"), browser: () => browser.controller },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("nothing rendered");
  });

  it("fails on console errors even when the page renders", async () => {
    const browser = fakeBrowser({
      evidence: [
        { kind: "console", message: "Uncaught TypeError: t is not a function", detail: { type: "error" }, createdAt: "2026-07-30T12:00:00.000Z" },
        { kind: "page-error", message: "ReferenceError: render is not defined", detail: {}, createdAt: "2026-07-30T12:00:00.000Z" },
      ],
    });
    const outcome = await runVerification(
      { kind: "browser", url: "http://127.0.0.1:4599/" },
      { workspacePath: tmp("gate-"), browser: () => browser.controller },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("console error");
    expect(outcome.output).toContain("Uncaught TypeError");
  });

  it("fails, without rendering, when the service never comes up", async () => {
    const service = fakeService();
    const browser = fakeBrowser();
    const outcome = await runVerification(
      { kind: "browser", command: "npm start", service: true },
      {
        workspacePath: tmp("gate-"),
        startService: async () => service.handle,
        httpProbe: async () => ({ status: 0, ok: false, error: "ECONNREFUSED" }),
        browser: () => browser.controller,
        readinessTimeoutMs: 500,
      },
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.summary).toContain("never served");
    expect(browser.opened).toHaveLength(0);
    expect(service.stops()).toBe(1);
  });

  it("stays inconclusive with no browser available, and never claims a pass", async () => {
    const outcome = await runVerification(
      { kind: "browser", url: "http://127.0.0.1:4599/", describe: "UI renders" },
      { workspacePath: tmp("gate-") },
    );
    expect(outcome.status).toBe("inconclusive");
  });
});

describe("the real background service launcher", () => {
  it("starts a real server, probes it, and kills it on stop", async () => {
    const workspace = tmp("gate-real-");
    writeFileSync(
      join(workspace, "server.js"),
      [
        "const http = require('http');",
        "const s = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });",
        "s.listen(0, '127.0.0.1', () => console.log('Server listening at http://127.0.0.1:' + s.address().port + '/'));",
      ].join("\n"),
    );
    const outcome = await runVerification(
      { kind: "runtime", command: "node server.js", service: true },
      { workspacePath: workspace, readinessTimeoutMs: 15_000 },
    );
    expect(outcome.status).toBe("passed");
    expect(outcome.summary).toContain("127.0.0.1");
  }, 30_000);

  it("fails a service that crashes on startup", async () => {
    const workspace = tmp("gate-crash-");
    writeFileSync(join(workspace, "server.js"), "throw new Error('boom');");
    const outcome = await runVerification(
      { kind: "runtime", command: "node server.js", service: true },
      { workspacePath: workspace, readinessTimeoutMs: 4_000 },
    );
    expect(outcome.status).not.toBe("passed");
  }, 20_000);
});
