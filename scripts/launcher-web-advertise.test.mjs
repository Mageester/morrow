import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = readFileSync(join(ROOT, "installer", "templates", "morrow.mjs"), "utf-8");

/**
 * The packaged launcher reported only the JSON API root. A new user installed
 * Morrow, read "Morrow is ready at http://127.0.0.1:4317", opened it, and got a
 * page of raw JSON — the web UI bundled into the same package was never
 * mentioned by start, status, or help, and `morrow open` (which already
 * existed) was undiscoverable.
 */
test("start and status advertise the bundled web app", () => {
  assert.match(launcher, /const appUrl =/, "launcher computes a web app URL");
  assert.match(launcher, /function readyMessage/, "launcher has one shared ready message");
  // Both entry points a user hits must use it.
  assert.match(launcher, /readyMessage\("Morrow is ready"\)/);
  assert.match(launcher, /readyMessage\("Morrow is running"\)/);
  assert.match(launcher, /readyMessage\("Morrow is already running"\)/);
  assert.match(launcher, /Web app:/);
});

test("the web app is only advertised when it is actually bundled", () => {
  // An older package without a web bundle must not claim a UI that cannot load.
  assert.match(
    launcher,
    /existsSync\(join\(webRoot, "index\.html"\)\) \? `\$\{url\}\/app` : null/,
    "appUrl is gated on the real bundle",
  );
});

test("launcher help lists the command that opens the web app", () => {
  assert.match(launcher, /morrow open\s+open the web app in your browser/);
});
