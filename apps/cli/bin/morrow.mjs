#!/usr/bin/env node
// Morrow CLI launcher. Runs the TypeScript entry directly via tsx (the same
// runtime the orchestrator uses), so a fresh `pnpm install` links a working
// `morrow` command with no separate build step.
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { register } from "tsx/esm/api";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write("0.1.0\n");
  process.exit(0);
}

register();

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../src/main.ts");

const { run } = await import(pathToFileURL(entry).href);
const code = await run(process.argv.slice(2));
if (typeof code === "number" && code !== 0) process.exitCode = code;
