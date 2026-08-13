import { readFileSync } from "node:fs";

/** Read scenario ids from the append-only evidence log for coverage tests. */
export function readFlagshipEvidenceScenarioIds(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((raw, index) => ({ line: raw.trim(), lineNumber: index + 1 }))
    .filter(({ line }) => line.length > 0 && !line.startsWith("#"))
    .map(({ line, lineNumber }) => {
      const scenarioId = (JSON.parse(line) as { scenarioId?: unknown }).scenarioId;
      if (typeof scenarioId !== "string" || scenarioId.trim().length === 0) {
        throw new Error(`${path}:${lineNumber} has an invalid scenarioId; expected a non-empty string.`);
      }
      return scenarioId;
    });
}
