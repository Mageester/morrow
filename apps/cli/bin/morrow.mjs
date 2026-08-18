#!/usr/bin/env node
// Morrow CLI launcher. Runs the TypeScript entry directly via tsx (the same
// runtime the orchestrator uses), so a fresh `pnpm install` links a working
// `morrow` command with no separate build step.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { register } from "tsx/esm/api";

const here = dirname(fileURLToPath(import.meta.url));

// Point tsx at this package's own tsconfig rather than letting it search from
// the current working directory. `morrow` is launched from wherever the user
// happens to be standing, and the repo has no root tsconfig.json, so the search
// found nothing and esbuild fell back to the classic JSX transform — which
// compiles the shell's components into `React.createElement` calls with no
// React import, and the CLI died with "React is not defined" on startup.
register({ tsconfig: resolve(here, "../tsconfig.json") });
const entry = resolve(here, "../src/main.ts");

const { run } = await import(pathToFileURL(entry).href);
const code = await run(process.argv.slice(2));
if (typeof code === "number" && code !== 0) process.exitCode = code;
