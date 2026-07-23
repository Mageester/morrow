import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const webRoot = fileURLToPath(new URL("..", import.meta.url));
const playwrightCli = fileURLToPath(
  new URL("../node_modules/@playwright/test/cli.js", import.meta.url),
);
const suites = [
  ["test"],
  ["test", "--config=playwright.composer.config.ts"],
];

let failed = false;
for (const args of suites) {
  const result = spawnSync(process.execPath, [playwrightCli, ...args], {
    cwd: webRoot,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(result.error.message);
    failed = true;
  } else if (result.status !== 0) {
    failed = true;
  }
}

if (failed) process.exitCode = 1;
