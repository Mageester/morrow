import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("deterministic workspace execution boundary", () => {
  it("does not import shell, network, or model-provider modules", () => {
    const source = readFileSync(fileURLToPath(new URL("../src/execution/inspect-workspace.ts", import.meta.url)), "utf8");
    const imports = source.match(/^import .*$/gm)?.join("\n") ?? "";
    for (const forbidden of ["child_process", "node:http", "node:https", "axios", "openai", "shell", "terminal"]) expect(imports).not.toContain(forbidden);
  });
});
