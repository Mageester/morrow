/**
 * Morrow Harness Benchmark v1 — task definitions.
 *
 * Each task owns a deterministic fixture generator and an objective verifier.
 * Fixtures are regenerated from scratch for every run, so a run is always a
 * reset run. Nothing here is tailored to a specific model or provider: the
 * prompt states the goal, and the verifier checks the finished artifact.
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { ToolCallRecord } from "../src/repositories/conversations.js";

const execFileAsync = promisify(execFile);

export interface VerificationStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface TaskVerification {
  ok: boolean;
  steps: VerificationStep[];
}

export interface BenchmarkTask {
  id: string;
  letter: string;
  title: string;
  /** What agent behaviour this task is meant to exercise. */
  exercises: string;
  prompt: string;
  /** Populates a fresh workspace. Must be deterministic. */
  fixture: (workspace: string) => void;
  verify: (context: { workspace: string; toolCalls: ReadonlyArray<ToolCallRecord> }) => Promise<TaskVerification> | TaskVerification;
}

// ── fixture helpers ─────────────────────────────────────────────────────────

function write(workspace: string, path: string, content: string): void {
  const target = join(workspace, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/**
 * Makes a real `tsc` available inside a fixture without any network install,
 * so a TypeScript task can be type-checked exactly as its own project would.
 */
function linkTypescript(workspace: string): void {
  const require = createRequire(import.meta.url);
  const typescriptDir = dirname(require.resolve("typescript/package.json"));
  const modules = join(workspace, "node_modules");
  mkdirSync(join(modules, ".bin"), { recursive: true });
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  try { symlinkSync(typescriptDir, join(modules, "typescript"), "dir"); } catch { /* already linked */ }
  try { symlinkSync(join(typescriptDir, "bin", "tsc"), join(modules, ".bin", "tsc"), "file"); } catch { /* already linked */ }
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
    strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
  },
  include: ["src", "test"],
}, null, 2);

// ── verification helpers ────────────────────────────────────────────────────

function step(name: string, ok: boolean, detail: string): VerificationStep {
  return { name, ok, detail };
}

function collect(steps: VerificationStep[]): TaskVerification {
  return { ok: steps.every((entry) => entry.ok), steps };
}

function fileText(workspace: string, path: string): string | null {
  const target = join(workspace, path);
  if (!existsSync(target) || !statSync(target).isFile()) return null;
  return readFileSync(target, "utf8");
}

function nonEmpty(workspace: string, path: string, minBytes = 1): VerificationStep {
  const text = fileText(workspace, path);
  if (text === null) return step(`${path} exists`, false, "file is missing");
  return step(`${path} exists`, text.trim().length >= minBytes, `${text.length} bytes`);
}

async function run(command: string, args: string[], cwd: string, timeoutMs = 120_000): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, output: `${stdout}${stderr}`.trim().slice(0, 2_000) };
  } catch (error) {
    const shell = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: `${shell.stdout ?? ""}${shell.stderr ?? ""}${shell.message ?? ""}`.trim().slice(0, 2_000) };
  }
}

async function nodeTests(workspace: string, extraFlags: string[] = []): Promise<VerificationStep> {
  const result = await run(process.execPath, [...extraFlags, "--test"], workspace);
  return step("node --test passes", result.ok, result.output.slice(-800) || "no output");
}

async function typeChecks(workspace: string): Promise<VerificationStep> {
  const result = await run(process.execPath, [join(workspace, "node_modules", "typescript", "lib", "tsc.js"), "--noEmit", "-p", "tsconfig.json"], workspace);
  return step("tsc --noEmit passes", result.ok, result.output.slice(-600) || "clean");
}

/** Every local `href`/`src` an HTML file references resolves to a real file. */
function referencedAssetsResolve(workspace: string, htmlPath: string): VerificationStep {
  const html = fileText(workspace, htmlPath);
  if (html === null) return step(`${htmlPath} references resolve`, false, "html file is missing");
  const references = [...html.matchAll(/(?:href|src)\s*=\s*["']([^"']+)["']/gi)]
    .map((match) => match[1] ?? "")
    .filter((value) => value && !/^(?:[a-z]+:|\/\/|#|data:|mailto:)/i.test(value))
    .map((value) => value.split(/[?#]/)[0] ?? value);
  const missing = references.filter((reference) => {
    const target = resolve(dirname(join(workspace, htmlPath)), reference);
    if (!target.startsWith(resolve(workspace))) return true;
    return !existsSync(target) || readFileSync(target, "utf8").trim().length === 0;
  });
  return step(
    `${htmlPath} references resolve`,
    references.length > 0 && missing.length === 0,
    missing.length > 0 ? `unresolved or empty: ${missing.join(", ")}` : `${references.length} local references all resolve`,
  );
}

async function javascriptParses(workspace: string, path: string): Promise<VerificationStep> {
  if (fileText(workspace, path) === null) return step(`${path} parses`, false, "file is missing");
  const result = await run(process.execPath, ["--check", join(workspace, path)], workspace);
  return step(`${path} parses`, result.ok, result.output || "valid JavaScript");
}

function walk(dir: string, base = dir): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules" || entry.name === ".git") return [];
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [relative(base, full)];
  });
}

// ── tasks ───────────────────────────────────────────────────────────────────

export const BENCHMARK_TASKS: BenchmarkTask[] = [
  {
    id: "missing-assets-website",
    letter: "A",
    title: "Missing-assets website",
    exercises: "Noticing that referenced files do not exist, creating them, and verifying the page is actually whole.",
    prompt:
      "This project is a landing page that is currently broken: index.html references stylesheets, scripts and data files that do not exist in the workspace. "
      + "Finish the site so that every local file index.html references actually exists with real, working content (not placeholders), the styling is applied, and the JavaScript runs without errors. "
      + "Verify your work before you report it as done, and tell me what you verified.",
    fixture: (workspace) => {
      write(workspace, "index.html", `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Harbour Analytics</title>
    <link rel="stylesheet" href="styles/reset.css" />
    <link rel="stylesheet" href="styles/main.css" />
  </head>
  <body>
    <header class="site-header"><h1>Harbour Analytics</h1></header>
    <main>
      <section id="features"></section>
      <section id="pricing"></section>
    </main>
    <footer class="site-footer"><p>&copy; 2026 Harbour Analytics</p></footer>
    <script src="scripts/data.js"></script>
    <script src="scripts/app.js"></script>
  </body>
</html>
`);
      write(workspace, "README.md", "# Harbour Analytics landing page\n\nStatic site. Open index.html in a browser.\n");
    },
    verify: async ({ workspace }) => collect([
      nonEmpty(workspace, "index.html"),
      referencedAssetsResolve(workspace, "index.html"),
      nonEmpty(workspace, "styles/main.css", 40),
      nonEmpty(workspace, "styles/reset.css", 10),
      await javascriptParses(workspace, "scripts/app.js"),
      await javascriptParses(workspace, "scripts/data.js"),
    ]),
  },

  {
    id: "fresh-website-build",
    letter: "B",
    title: "Fresh website build",
    exercises: "Producing a coherent multi-file artifact from a prompt with no starting code.",
    prompt:
      "Build a small, polished static website for a fictional coffee roastery called \"Northwind Roasters\" in this empty workspace. "
      + "It must have at least two linked pages (index.html and menu.html), a shared external stylesheet, and an external JavaScript file that adds at least one piece of real interactive behaviour. "
      + "Every page must link to the others and reference only files that exist. Verify the result before reporting it done.",
    fixture: () => { /* deliberately empty workspace */ },
    verify: async ({ workspace }) => {
      const index = fileText(workspace, "index.html") ?? "";
      const menu = fileText(workspace, "menu.html") ?? "";
      const cssFiles = walk(workspace).filter((path) => path.endsWith(".css"));
      const jsFiles = walk(workspace).filter((path) => path.endsWith(".js"));
      const steps = [
        nonEmpty(workspace, "index.html", 100),
        nonEmpty(workspace, "menu.html", 100),
        step("shared external stylesheet exists", cssFiles.length > 0, cssFiles.join(", ") || "none"),
        step("external javascript exists", jsFiles.length > 0, jsFiles.join(", ") || "none"),
        step("pages are cross-linked", index.includes("menu.html") && menu.includes("index.html"), "index->menu and menu->index"),
        referencedAssetsResolve(workspace, "index.html"),
        referencedAssetsResolve(workspace, "menu.html"),
      ];
      for (const path of jsFiles) steps.push(await javascriptParses(workspace, path));
      return collect(steps);
    },
  },

  {
    id: "typescript-bugfix",
    letter: "C",
    title: "TypeScript bugfix",
    exercises: "Diagnosing a real type error plus a real behavioural failure and repairing both.",
    prompt:
      "This TypeScript project does not type-check and its tests fail. Run the checks, diagnose the actual root cause, and fix the source so that both "
      + "`node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json` and `node --test` pass. Do not weaken the tests or the types to make them pass. Verify before reporting done.",
    fixture: (workspace) => {
      linkTypescript(workspace);
      write(workspace, "tsconfig.json", TSCONFIG);
      write(workspace, "package.json", JSON.stringify({ name: "invoice", private: true, type: "module" }, null, 2));
      // Two defects: `rate` is typed as string but used as a number, and the
      // discount branch applies the discount to the wrong subtotal.
      write(workspace, "src/invoice.ts", `export interface LineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
}

export interface Invoice {
  items: LineItem[];
  taxRate: string;
  discountPercent: number;
}

export function subtotalCents(invoice: Invoice): number {
  return invoice.items.reduce((total, item) => total + item.quantity * item.unitPriceCents, 0);
}

export function totalCents(invoice: Invoice): number {
  const subtotal = subtotalCents(invoice);
  const discounted = subtotal - Math.round(subtotal * invoice.discountPercent);
  return discounted + Math.round(subtotal * invoice.taxRate);
}
`);
      write(workspace, "test/invoice.test.mjs", `import test from "node:test";
import assert from "node:assert/strict";
import { subtotalCents, totalCents } from "../src/invoice.ts";

const invoice = {
  items: [
    { description: "Roast", quantity: 2, unitPriceCents: 1_250 },
    { description: "Grinder", quantity: 1, unitPriceCents: 9_900 },
  ],
  taxRate: 0.1,
  discountPercent: 0.1,
};

test("subtotal sums every line item", () => {
  assert.equal(subtotalCents(invoice), 12_400);
});

test("total applies the discount before tax and taxes the discounted amount", () => {
  // 12400 - 1240 = 11160 discounted; tax is 10% of the discounted amount.
  assert.equal(totalCents(invoice), 12_276);
});
`);
      write(workspace, "README.md", "# invoice\n\nRun `node node_modules/typescript/lib/tsc.js --noEmit -p tsconfig.json` and `node --test`.\n");
    },
    verify: async ({ workspace }) => collect([
      await typeChecks(workspace),
      await nodeTests(workspace, ["--experimental-strip-types"]),
      step("tests were not weakened", (fileText(workspace, "test/invoice.test.mjs") ?? "").includes("12_276") || (fileText(workspace, "test/invoice.test.mjs") ?? "").includes("12276"), "expected total assertion is intact"),
    ]),
  },

  {
    id: "multi-file-feature",
    letter: "D",
    title: "Multi-file feature",
    exercises: "Threading one feature through several existing files without breaking current behaviour.",
    prompt:
      "This little CSV report tool supports the `sum` and `count` aggregations. Add a new `average` aggregation that behaves consistently with the existing ones "
      + "(parser, aggregator and CLI formatting all need to know about it), and add tests for it. All existing tests must keep passing. Verify with `node --test` before reporting done.",
    fixture: (workspace) => {
      write(workspace, "package.json", JSON.stringify({ name: "csvreport", private: true, type: "module" }, null, 2));
      write(workspace, "src/parse.mjs", `const SUPPORTED = new Set(["sum", "count"]);

export function parseSpec(spec) {
  const [aggregation, column] = String(spec).split(":");
  if (!SUPPORTED.has(aggregation)) throw new Error(\`Unsupported aggregation: \${aggregation}\`);
  if (!column) throw new Error("A column name is required");
  return { aggregation, column };
}

export function parseCsv(text) {
  const [headerLine, ...rows] = text.trim().split("\\n");
  const headers = headerLine.split(",").map((value) => value.trim());
  return rows.filter((row) => row.trim().length > 0).map((row) => {
    const cells = row.split(",").map((value) => value.trim());
    return Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? ""]));
  });
}
`);
      write(workspace, "src/aggregate.mjs", `export function aggregate(rows, spec) {
  const values = rows.map((row) => Number(row[spec.column]));
  switch (spec.aggregation) {
    case "sum":
      return values.reduce((total, value) => total + value, 0);
    case "count":
      return values.length;
    default:
      throw new Error(\`Unsupported aggregation: \${spec.aggregation}\`);
  }
}
`);
      write(workspace, "src/cli.mjs", `import { aggregate } from "./aggregate.mjs";
import { parseCsv, parseSpec } from "./parse.mjs";

export function report(csvText, specText) {
  const spec = parseSpec(specText);
  const value = aggregate(parseCsv(csvText), spec);
  const formatted = spec.aggregation === "count" ? String(value) : value.toFixed(2);
  return \`\${spec.aggregation}(\${spec.column}) = \${formatted}\`;
}
`);
      write(workspace, "test/report.test.mjs", `import test from "node:test";
import assert from "node:assert/strict";
import { report } from "../src/cli.mjs";

const csv = "name,amount\\nada,10\\ngrace,20\\nalan,30\\n";

test("sums a column", () => {
  assert.equal(report(csv, "sum:amount"), "sum(amount) = 60.00");
});

test("counts rows", () => {
  assert.equal(report(csv, "count:amount"), "count(amount) = 3");
});

test("rejects an unknown aggregation", () => {
  assert.throws(() => report(csv, "median:amount"), /Unsupported aggregation/);
});
`);
      write(workspace, "README.md", "# csvreport\n\n`report(csvText, \"sum:amount\")`. Supported aggregations: sum, count.\n");
    },
    verify: async ({ workspace }) => {
      const steps = [await nodeTests(workspace)];
      const parse = fileText(workspace, "src/parse.mjs") ?? "";
      const aggregate = fileText(workspace, "src/aggregate.mjs") ?? "";
      const cli = fileText(workspace, "src/cli.mjs") ?? "";
      steps.push(step("average threaded through parser and aggregator", parse.includes("average") && aggregate.includes("average"), "both modules mention the new aggregation"));
      steps.push(step("existing tests still present", (fileText(workspace, "test/report.test.mjs") ?? "").includes("sum(amount) = 60.00"), "original assertions intact"));
      const probe = await run(process.execPath, ["-e", `import("${join(workspace, "src/cli.mjs").replaceAll("\\", "/")}").then((m) => { const out = m.report("name,amount\\nada,10\\ngrace,20\\nalan,30\\n", "average:amount"); if (out !== "average(amount) = 20.00") { console.error("got: " + out); process.exit(1); } })`], workspace);
      steps.push(step("average aggregation returns 20.00", probe.ok, probe.output || "average(amount) = 20.00"));
      steps.push(step("cli formatting untouched for count", cli.includes("count"), "count formatting retained"));
      return collect(steps);
    },
  },

  {
    id: "behaviour-preserving-refactor",
    letter: "E",
    title: "Refactor",
    exercises: "Restructuring duplicated code while proving behaviour is unchanged.",
    prompt:
      "The date-formatting logic in src/orders.mjs and src/shipments.mjs is duplicated almost verbatim. Refactor it into a single shared module that both import, "
      + "without changing any observable behaviour. The existing tests must keep passing unmodified — run `node --test` to prove it before you report done.",
    fixture: (workspace) => {
      const duplicated = (label: string) => `function pad(value) {
  return String(value).padStart(2, "0");
}

function formatStamp(iso) {
  const date = new Date(iso);
  return \`\${date.getUTCFullYear()}-\${pad(date.getUTCMonth() + 1)}-\${pad(date.getUTCDate())} \${pad(date.getUTCHours())}:\${pad(date.getUTCMinutes())} UTC\`;
}

function relativeDays(iso, nowIso) {
  const days = Math.floor((new Date(iso).getTime() - new Date(nowIso).getTime()) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  return days > 0 ? \`in \${days} days\` : \`\${Math.abs(days)} days ago\`;
}

export function describe${label}(record, nowIso) {
  return \`${label} \${record.id} — \${formatStamp(record.at)} (\${relativeDays(record.at, nowIso)})\`;
}
`;
      write(workspace, "package.json", JSON.stringify({ name: "logistics", private: true, type: "module" }, null, 2));
      write(workspace, "src/orders.mjs", duplicated("Order"));
      write(workspace, "src/shipments.mjs", duplicated("Shipment"));
      write(workspace, "test/format.test.mjs", `import test from "node:test";
import assert from "node:assert/strict";
import { describeOrder } from "../src/orders.mjs";
import { describeShipment } from "../src/shipments.mjs";

const now = "2026-03-10T00:00:00.000Z";

test("orders read the same as before", () => {
  assert.equal(describeOrder({ id: "o-1", at: "2026-03-12T09:05:00.000Z" }, now), "Order o-1 — 2026-03-12 09:05 UTC (in 2 days)");
});

test("shipments read the same as before", () => {
  assert.equal(describeShipment({ id: "s-9", at: "2026-03-09T18:30:00.000Z" }, now), "Shipment s-9 — 2026-03-09 18:30 UTC (yesterday)");
});
`);
      write(workspace, "README.md", "# logistics\n\nOrders and shipments share their date formatting rules.\n");
    },
    verify: async ({ workspace }) => {
      const orders = fileText(workspace, "src/orders.mjs") ?? "";
      const shipments = fileText(workspace, "src/shipments.mjs") ?? "";
      const testFile = fileText(workspace, "test/format.test.mjs") ?? "";
      const sharedModules = walk(join(workspace, "src")).filter((path) => path !== "orders.mjs" && path !== "shipments.mjs" && path.endsWith(".mjs"));
      const duplicationRemoved = !orders.includes("function formatStamp") && !shipments.includes("function formatStamp");
      return collect([
        await nodeTests(workspace),
        step("a shared module was introduced", sharedModules.length > 0, sharedModules.join(", ") || "none"),
        step("both modules import the shared code", /import .*from/.test(orders) && /import .*from/.test(shipments), "orders and shipments both import"),
        step("duplication removed", duplicationRemoved, duplicationRemoved ? "formatStamp no longer defined twice" : "formatStamp is still duplicated"),
        step("tests unmodified", testFile.includes("Order o-1 — 2026-03-12 09:05 UTC (in 2 days)"), "original assertions intact"),
      ]);
    },
  },

  {
    id: "broken-test-suite-root-cause",
    letter: "F",
    title: "Broken test suite",
    exercises: "Finding one shared root cause instead of patching each failing symptom.",
    prompt:
      "Six tests in this project are failing. They share a single underlying cause. Find and fix that root cause rather than patching each test or each call site, "
      + "then prove it with `node --test`. Do not edit the tests. Tell me what the root cause was.",
    fixture: (workspace) => {
      write(workspace, "package.json", JSON.stringify({ name: "slugger", private: true, type: "module" }, null, 2));
      // The single root cause: `truncate` cuts one character short.
      write(workspace, "src/text.mjs", `export function truncate(value, limit) {
  if (value.length <= limit) return value;
  return value.slice(0, limit - 1);
}

export function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
`);
      write(workspace, "src/labels.mjs", `import { slugify, truncate } from "./text.mjs";

export function shortLabel(value) {
  return truncate(value.trim(), 10);
}

export function slugLabel(value) {
  return truncate(slugify(value), 12);
}

export function initials(value) {
  return truncate(value.split(/\\s+/).map((word) => word[0] ?? "").join(""), 3);
}
`);
      write(workspace, "test/labels.test.mjs", `import test from "node:test";
import assert from "node:assert/strict";
import { truncate } from "../src/text.mjs";
import { initials, shortLabel, slugLabel } from "../src/labels.mjs";

test("truncate keeps exactly the limit", () => {
  assert.equal(truncate("abcdefghij", 5), "abcde");
});

test("truncate leaves short values alone", () => {
  assert.equal(truncate("abc", 5), "abc");
});

test("truncate handles an exact-length value", () => {
  assert.equal(truncate("abcde", 5), "abcde");
});

test("short labels keep ten characters", () => {
  assert.equal(shortLabel("  Northwind Roasters  "), "Northwind ");
});

test("slug labels keep twelve characters", () => {
  assert.equal(slugLabel("Northwind Coffee Roasters"), "northwind-co");
});

test("initials keep three characters", () => {
  assert.equal(initials("Ada Grace Lovelace King"), "AGL");
});
`);
      write(workspace, "README.md", "# slugger\n\nLabel helpers built on src/text.mjs.\n");
    },
    verify: async ({ workspace }) => {
      const text = fileText(workspace, "src/text.mjs") ?? "";
      const testFile = fileText(workspace, "test/labels.test.mjs") ?? "";
      return collect([
        await nodeTests(workspace),
        step("root cause fixed in src/text.mjs", !text.includes("limit - 1"), text.includes("limit - 1") ? "truncate still slices limit - 1" : "truncate no longer slices one short"),
        step("tests were not edited", testFile.includes('assert.equal(truncate("abcdefghij", 5), "abcde");') && testFile.includes('assert.equal(initials("Ada Grace Lovelace King"), "AGL");'), "test assertions intact"),
      ]);
    },
  },

  {
    id: "dev-server-lifecycle",
    letter: "G",
    title: "Dev-server task",
    exercises: "Starting a long-running process, observing it, and cleaning it up correctly.",
    prompt:
      "This workspace contains server.mjs, a small static development server. Start it in the background on port 8731, confirm it is actually reachable and serving the site "
      + "(inspect its output and fetch a page from it), write what you observed — including the HTTP status code and the page title you got back — into a new file called server-report.md, "
      + "and then stop the server again so nothing is left running. Report what you verified.",
    fixture: (workspace) => {
      write(workspace, "package.json", JSON.stringify({ name: "devserver", private: true, type: "module" }, null, 2));
      write(workspace, "public/index.html", "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>Tidewater Dev Server</title></head><body><h1>Tidewater</h1></body></html>\n");
      write(workspace, "server.mjs", `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const port = Number(process.env.PORT ?? process.argv[2] ?? 8731);
const root = join(import.meta.dirname, "public");

createServer(async (request, response) => {
  const path = request.url === "/" ? "/index.html" : request.url;
  try {
    const body = await readFile(join(root, path));
    response.writeHead(200, { "content-type": path.endsWith(".html") ? "text/html" : "text/plain" });
    response.end(body);
    console.log(\`200 \${path}\`);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
    console.log(\`404 \${path}\`);
  }
}).listen(port, "127.0.0.1", () => {
  console.log(\`dev server listening on http://127.0.0.1:\${port}\`);
});
`);
      write(workspace, "README.md", "# devserver\n\nRun `node server.mjs` to serve ./public on port 8731.\n");
    },
    verify: async ({ workspace, toolCalls }) => {
      const report = fileText(workspace, "server-report.md") ?? "";
      const startedServer = toolCalls.some((record) => record.toolName === "run_command" && record.argsJson.includes("server.mjs"));
      const stopped = toolCalls.some((record) => record.toolName === "stop_process" && record.status === "completed");
      // The port must be free again: a still-listening server means cleanup failed.
      const probe = await run(process.execPath, ["-e", `const s=require("node:net").createServer();s.once("error",()=>{console.error("port still in use");process.exit(1)});s.listen(8731,"127.0.0.1",()=>{s.close();})`], workspace, 15_000);
      return collect([
        step("server was started", startedServer, startedServer ? "run_command launched server.mjs" : "no run_command started the server"),
        nonEmpty(workspace, "server-report.md", 20),
        step("report records the HTTP status", report.includes("200"), report.slice(0, 200)),
        step("report records the served page title", /tidewater/i.test(report), report.slice(0, 200)),
        step("server was stopped", stopped, stopped ? "stop_process completed" : "no completed stop_process call"),
        step("port 8731 is free again", probe.ok, probe.output || "port is free"),
      ]);
    },
  },

  {
    id: "tool-failure-recovery",
    letter: "H",
    title: "Tool-failure recovery",
    exercises: "Recovering from a genuinely failed edit using the tool's own error feedback.",
    prompt:
      "In src/config.mjs, change the retry policy so that `maxAttempts` is 5 instead of 3 — but only in the `network` policy. The `disk` and `database` policies must keep "
      + "their current values exactly. Then run `node --test` to prove you changed the right one. Report what you changed and what you verified.",
    fixture: (workspace) => {
      write(workspace, "package.json", JSON.stringify({ name: "retry", private: true, type: "module" }, null, 2));
      // Three identical-looking blocks: a naive anchor-based patch is ambiguous
      // and will legitimately fail, which is the point of the task.
      write(workspace, "src/config.mjs", `export const policies = {
  disk: {
    maxAttempts: 3,
    backoffMs: 250,
    jitter: true,
  },
  network: {
    maxAttempts: 3,
    backoffMs: 250,
    jitter: true,
  },
  database: {
    maxAttempts: 3,
    backoffMs: 250,
    jitter: true,
  },
};

export function attemptsFor(kind) {
  const policy = policies[kind];
  if (!policy) throw new Error(\`Unknown policy: \${kind}\`);
  return policy.maxAttempts;
}
`);
      write(workspace, "test/config.test.mjs", `import test from "node:test";
import assert from "node:assert/strict";
import { attemptsFor } from "../src/config.mjs";

test("network retries five times", () => {
  assert.equal(attemptsFor("network"), 5);
});

test("disk retries three times", () => {
  assert.equal(attemptsFor("disk"), 3);
});

test("database retries three times", () => {
  assert.equal(attemptsFor("database"), 3);
});
`);
      write(workspace, "README.md", "# retry\n\nRetry policies live in src/config.mjs.\n");
    },
    verify: async ({ workspace }) => collect([
      await nodeTests(workspace),
      step("only the network policy changed", ((fileText(workspace, "src/config.mjs") ?? "").match(/maxAttempts: 3/g) ?? []).length === 2, `${((fileText(workspace, "src/config.mjs") ?? "").match(/maxAttempts: 3/g) ?? []).length} policies still at 3 (expected 2)`),
    ]),
  },

  {
    id: "unfamiliar-repository",
    letter: "I",
    title: "Unfamiliar repository",
    exercises: "Orienting in an unfamiliar layout before changing anything.",
    prompt:
      "I do not know this codebase well. Somewhere in here the application decides which currency symbol to display. Find it, then add support for the Japanese yen "
      + "(code JPY, symbol ¥, zero decimal places) so it works consistently everywhere the existing currencies work. Run the project's own tests to prove nothing else broke, and explain where the change had to go.",
    fixture: (workspace) => {
      write(workspace, "package.json", JSON.stringify({ name: "ledger", private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
      write(workspace, "lib/domain/money/registry.mjs", `export const CURRENCIES = {
  USD: { symbol: "$", decimals: 2 },
  EUR: { symbol: "€", decimals: 2 },
  GBP: { symbol: "£", decimals: 2 },
};

export function currency(code) {
  const entry = CURRENCIES[code];
  if (!entry) throw new Error(\`Unsupported currency: \${code}\`);
  return entry;
}
`);
      write(workspace, "lib/domain/money/format.mjs", `import { currency } from "./registry.mjs";

export function formatAmount(minorUnits, code) {
  const { symbol, decimals } = currency(code);
  const value = minorUnits / 10 ** decimals;
  return \`\${symbol}\${value.toFixed(decimals)}\`;
}
`);
      write(workspace, "lib/app/receipt.mjs", `import { formatAmount } from "../domain/money/format.mjs";

export function receiptLine(item, code) {
  return \`\${item.name.padEnd(12, ".")} \${formatAmount(item.minorUnits, code)}\`;
}
`);
      write(workspace, "test/money.test.mjs", `import test from "node:test";
import assert from "node:assert/strict";
import { formatAmount } from "../lib/domain/money/format.mjs";
import { receiptLine } from "../lib/app/receipt.mjs";

test("formats dollars", () => {
  assert.equal(formatAmount(1_250, "USD"), "$12.50");
});

test("formats pounds on a receipt", () => {
  assert.equal(receiptLine({ name: "Beans", minorUnits: 899 }, "GBP"), "Beans....... £8.99");
});

test("rejects an unknown currency", () => {
  assert.throws(() => formatAmount(100, "XXX"), /Unsupported currency/);
});
`);
      write(workspace, "docs/architecture.md", "# ledger\n\n`lib/domain` holds pure domain rules; `lib/app` composes them for presentation.\n");
    },
    verify: async ({ workspace }) => {
      const registry = fileText(workspace, "lib/domain/money/registry.mjs") ?? "";
      const probe = await run(process.execPath, ["-e", `import("${join(workspace, "lib/domain/money/format.mjs").replaceAll("\\", "/")}").then((m)=>{const a=m.formatAmount(1250,"JPY");if(a!=="¥1250"){console.error("got: "+a);process.exit(1)}})`], workspace);
      const receipt = await run(process.execPath, ["-e", `import("${join(workspace, "lib/app/receipt.mjs").replaceAll("\\", "/")}").then((m)=>{const a=m.receiptLine({name:"Beans",minorUnits:1250},"JPY");if(!a.includes("¥1250")){console.error("got: "+a);process.exit(1)}})`], workspace);
      return collect([
        await nodeTests(workspace),
        step("JPY added to the domain registry", registry.includes("JPY"), "registry.mjs declares JPY"),
        step("JPY formats with zero decimals", probe.ok, probe.output || "formatAmount(1250, 'JPY') === '¥1250'"),
        step("JPY works through the app layer too", receipt.ok, receipt.output || "receiptLine renders ¥1250"),
      ]);
    },
  },

  {
    id: "longer-autonomy",
    letter: "J",
    title: "Longer autonomy task",
    exercises: "Sustaining many turns of real work across context boundaries without filler.",
    prompt:
      "Build a small dependency-free task-scheduling library in this empty workspace, as an ES module project. It needs: "
      + "(1) src/queue.mjs — a priority queue with push/pop/peek/size; "
      + "(2) src/scheduler.mjs — a scheduler built on the queue that runs async tasks with a configurable concurrency limit and preserves priority order; "
      + "(3) src/retry.mjs — a retry helper with exponential backoff and a maximum attempt count; "
      + "(4) src/index.mjs — re-exporting the public API; "
      + "(5) a test file per module under test/, covering the real behaviour including edge cases; "
      + "(6) a README.md documenting the API with usage examples. "
      + "Everything must actually work: run `node --test` and make it pass before you report done.",
    fixture: () => { /* deliberately empty workspace */ },
    verify: async ({ workspace }) => {
      const testFiles = walk(join(workspace, "test"));
      const steps = [
        nonEmpty(workspace, "src/queue.mjs", 80),
        nonEmpty(workspace, "src/scheduler.mjs", 80),
        nonEmpty(workspace, "src/retry.mjs", 80),
        nonEmpty(workspace, "src/index.mjs", 20),
        nonEmpty(workspace, "README.md", 200),
        step("a test file per module", testFiles.length >= 3, testFiles.join(", ") || "none"),
        await nodeTests(workspace),
      ];
      const api = await run(process.execPath, ["-e", `import("${join(workspace, "src/index.mjs").replaceAll("\\", "/")}").then((m)=>{const missing=["PriorityQueue","Scheduler","retry"].filter((name)=>!Object.keys(m).some((key)=>key.toLowerCase()===name.toLowerCase()));if(missing.length){console.error("index.mjs does not export: "+missing.join(", ")+"; exports: "+Object.keys(m).join(", "));process.exit(1)}})`], workspace);
      steps.push(step("index.mjs re-exports the public API", api.ok, api.output || "queue, scheduler and retry are exported"));
      return collect(steps);
    },
  },
];

export function findTask(id: string): BenchmarkTask | undefined {
  const needle = id.toLowerCase();
  return BENCHMARK_TASKS.find((task) => task.id === needle || task.letter.toLowerCase() === needle);
}
