import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { E2EState } from "./global-setup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Load the seeded mission state written by global-setup. */
export function loadState(): E2EState {
  return JSON.parse(readFileSync(join(__dirname, ".state.json"), "utf8")) as E2EState;
}
