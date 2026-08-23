#!/usr/bin/env node
// Morrow CLI launcher. Runs the TypeScript entry directly via tsx (the same
// runtime the orchestrator uses), so a fresh `pnpm install` links a working
// `morrow` command with no separate build step.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));

// The most common diagnostic must not boot the TypeScript compiler and the
// entire terminal command registry just to print one immutable value. The
// packaged launcher already has the same fast path; keep source installs fast
// too while reading the canonical root version instead of duplicating it.
if (process.argv.length === 3 && (process.argv[2] === "--version" || process.argv[2] === "-v")) {
  const product = JSON.parse(readFileSync(resolve(here, "../../../package.json"), "utf8"));
  process.stdout.write(`${product.version}\n`);
  process.exit(0);
}

// Point tsx at this package's own tsconfig rather than letting it search from
// the current working directory. `morrow` is launched from wherever the user
// happens to be standing, and the repo has no root tsconfig.json, so the search
// found nothing and esbuild fell back to the classic JSX transform — which
// compiles the shell's components into `React.createElement` calls with no
// React import, and the CLI died with "React is not defined" on startup.
const { register } = await import("tsx/esm/api");
register({ tsconfig: resolve(here, "../tsconfig.json") });
const entry = resolve(here, "../src/main.ts");

const { run } = await import(pathToFileURL(entry).href);
const code = await run(process.argv.slice(2));
if (typeof code === "number" && code !== 0) process.exitCode = code;
