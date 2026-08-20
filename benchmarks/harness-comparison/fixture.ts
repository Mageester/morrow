import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Write a task's fixture files into an empty workspace. */
export function writeFixture(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}
