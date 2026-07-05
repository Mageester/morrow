import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Scenario } from "./harness.js";

/**
 * Deterministic scenarios. Each plants defects, exposes measurable criteria, an
 * "implementer" (correct or deliberately incomplete), and an independent hidden
 * ground-truth check. Add scenarios by implementing the `Scenario` interface.
 *
 * Verification commands use `node` on PATH (portable across shells) and small
 * check scripts written into the fixture, avoiding brittle shell quoting.
 */

function nodeCheck(dir: string, file: string): boolean {
  return spawnSync("node", ["--check", file], { cwd: dir }).status === 0;
}
function nodeRun(dir: string, file: string): { ok: boolean; stdout: string } {
  const r = spawnSync("node", [file], { cwd: dir, encoding: "utf8" });
  return { ok: r.status === 0, stdout: (r.stdout ?? "").trim() };
}

// 1. Browser game with two planted runtime/resource bugs. A correct fix repairs
//    both (script path + undefined variable).
const browserGame: Scenario = {
  name: "browser-game",
  description: "Repair the Star Dodger browser game; preserve intended behaviour.",
  setup(dir) {
    mkdirSync(join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "public", "index.html"), `<!doctype html><html><body>\n<canvas id="game"></canvas>\n<script src="src/game.js"></script>\n</body></html>\n`);
    writeFileSync(join(dir, "public", "game.js"), `const el = document.getElementById("score");\nlet score = 0;\nfunction tick(){ score += 1; el.textContent = "Score: " + points; }\n`);
    // Independent content check used as a criterion (exit 0 = correct script path).
    writeFileSync(join(dir, "check-html.js"), `const h=require("fs").readFileSync("public/index.html","utf8");process.exit(!h.includes("src/game.js")&&h.includes("game.js")?0:1);\n`);
  },
  criteria() {
    return [
      { description: "public/game.js parses without a reference to an undefined variable", verification: { kind: "command", command: "node --check public/game.js", expectExitCode: 0 } },
      { description: "index.html references the real script path game.js (not src/game.js)", verification: { kind: "command", command: "node check-html.js", expectExitCode: 0 } },
    ];
  },
  implement(dir) {
    writeFileSync(join(dir, "public", "game.js"), `const el = document.getElementById("score");\nlet score = 0;\nfunction tick(){ score += 1; el.textContent = "Score: " + score; }\n`);
    writeFileSync(join(dir, "public", "index.html"), `<!doctype html><html><body>\n<canvas id="game"></canvas>\n<script src="game.js"></script>\n</body></html>\n`);
  },
  hiddenTest(dir) {
    if (!nodeCheck(dir, "public/game.js")) return false;
    const html = readFileSync(join(dir, "public", "index.html"), "utf8");
    const js = readFileSync(join(dir, "public", "game.js"), "utf8");
    return !html.includes("src/game.js") && html.includes("game.js") && !js.includes("points");
  },
};

// 2. ESM/CommonJS latent runtime failure: type:module but uses require().
const esmCjs: Scenario = {
  name: "esm-cjs",
  description: "Fix the module system mismatch so the entry runs under Node ESM.",
  setup(dir) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "esm-cjs", type: "module", version: "1.0.0" }, null, 2));
    writeFileSync(join(dir, "index.js"), `const path = require("node:path");\nconsole.log(path.basename("/a/b.txt"));\n`);
  },
  criteria() {
    return [
      { description: "node index.js runs without a module error", verification: { kind: "command", command: "node index.js", expectExitCode: 0 } },
    ];
  },
  implement(dir) {
    writeFileSync(join(dir, "index.js"), `import path from "node:path";\nconsole.log(path.basename("/a/b.txt"));\n`);
  },
  hiddenTest(dir) {
    const r = nodeRun(dir, "index.js");
    return r.ok && r.stdout === "b.txt";
  },
};

// 3. Hidden authorization bug (|| instead of &&). Implementer applies an
//    INCOMPLETE fix (cosmetic rename), so Morrow must NOT claim success.
const authzCheck: Scenario = {
  name: "authz-check",
  description: "Fix the broken authorization check so only admins with an active session pass.",
  setup(dir) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "authz", type: "module", version: "1.0.0" }, null, 2));
    writeFileSync(join(dir, "auth.js"), `export function canAccess(user){ return user.isAdmin || user.hasSession; }\n`);
    writeFileSync(join(dir, "auth.test.js"), [
      `import assert from "node:assert";`,
      `import { canAccess } from "./auth.js";`,
      `assert.equal(canAccess({ isAdmin: true, hasSession: true }), true);`,
      `assert.equal(canAccess({ isAdmin: false, hasSession: true }), false);`,
      `console.log("ok");`,
    ].join("\n") + "\n");
  },
  criteria() {
    return [
      { description: "the authorization test passes", verification: { kind: "command", command: "node auth.test.js", expectExitCode: 0 } },
    ];
  },
  implement(dir) {
    // INCOMPLETE: cosmetic rename only; the || bug remains. Morrow must catch this.
    writeFileSync(join(dir, "auth.js"), `export function canAccess(u){ return u.isAdmin || u.hasSession; }\n`);
  },
  hiddenTest(dir) {
    return nodeRun(dir, "auth.test.js").ok;
  },
};

// 4. Refactor with hidden regression tests; a correct refactor preserves behaviour.
const refactorRegression: Scenario = {
  name: "refactor-regression",
  description: "Refactor sum() for clarity without changing behaviour.",
  setup(dir) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "refactor", type: "module", version: "1.0.0" }, null, 2));
    writeFileSync(join(dir, "sum.js"), `export function sum(a, b){ return a + b; }\n`);
    writeFileSync(join(dir, "sum.test.js"), [
      `import assert from "node:assert";`,
      `import { sum } from "./sum.js";`,
      `assert.equal(sum(2, 3), 5);`,
      `assert.equal(sum(-1, 1), 0);`,
      `console.log("ok");`,
    ].join("\n") + "\n");
  },
  criteria() {
    return [
      { description: "the regression test suite passes", verification: { kind: "command", command: "node sum.test.js", expectExitCode: 0 } },
      { description: "changes stay within the intended source files", verification: { kind: "diff", pathScope: "sum.js" } },
    ];
  },
  implement(dir) {
    writeFileSync(join(dir, "sum.js"), `export const sum = (a, b) => a + b;\n`);
  },
  hiddenTest(dir) {
    return nodeRun(dir, "sum.test.js").ok;
  },
};

// 5. Restart-resume: the mission survives a "restart" and still grades honestly.
const restartResume: Scenario = {
  name: "restart-resume",
  restart: true,
  description: "Repair a syntax error; the mission must survive a service restart.",
  setup(dir) {
    writeFileSync(join(dir, "app.js"), `const value = ;\nconsole.log(value);\n`);
  },
  criteria() {
    return [
      { description: "app.js parses", verification: { kind: "command", command: "node --check app.js", expectExitCode: 0 } },
    ];
  },
  implement(dir) {
    writeFileSync(join(dir, "app.js"), `const value = 42;\nconsole.log(value);\n`);
  },
  hiddenTest(dir) {
    return nodeCheck(dir, "app.js");
  },
};

export const SCENARIOS: Scenario[] = [browserGame, esmCjs, authzCheck, refactorRegression, restartResume];
