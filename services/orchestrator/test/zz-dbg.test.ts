import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectEndpoints } from "../src/processes/endpoints.js";

const E = String.fromCharCode(27);
const OUT = "/tmp/claude-1000/-home-dread-Code-morrow/cb0023ea-c33f-4fbb-bed9-467f54a23785/scratchpad/dbg.txt";

describe("debug", () => {
  it("real captured bytes", () => {
    const captured = `  ${E}[32m➜${E}[39m  ${E}[1mLocal${E}[22m:   ${E}[36mhttp://localhost:${E}[1m4188${E}[22m/${E}[39m\nstarted server on 0.0.0.0:4188\n`;
    const stripped = captured.replace(new RegExp(`${E}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "");
    writeFileSync(OUT, [
      "STRIPPED: " + JSON.stringify(stripped),
      "RESULT:   " + JSON.stringify(detectEndpoints(captured)),
      "PLAINRES: " + JSON.stringify(detectEndpoints(stripped)),
    ].join("\n"));
    expect(true).toBe(true);
  });
});
