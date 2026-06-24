import { describe, it, expect } from "vitest";
import { parseHermesEnv, mapToMorrow, summarizeImport } from "../src/import-config.js";

const FIXTURE = `
# Hermes config
; a comment
export OPENAI_API_KEY="sk-supersecret-value"
ANTHROPIC_API_KEY=

PROVIDER: openai
MODEL = gpt-4o
TEMPERATURE=0.2
SOME_UNKNOWN_THING=whatever
`;

describe("parseHermesEnv", () => {
  it("ignores comments and blank lines and reads both = and : syntaxes", () => {
    const config = parseHermesEnv(FIXTURE);
    expect(config.OPENAI_API_KEY).toBe("sk-supersecret-value");
    expect(config.ANTHROPIC_API_KEY).toBe("");
    expect(config.PROVIDER).toBe("openai");
    expect(config.MODEL).toBe("gpt-4o");
    expect(config.TEMPERATURE).toBe("0.2");
    expect(Object.keys(config)).not.toContain("# Hermes config");
  });

  it("strips an export prefix and surrounding quotes", () => {
    expect(parseHermesEnv(`export KEY='quoted'`).KEY).toBe("quoted");
  });
});

describe("mapToMorrow", () => {
  it("maps known keys and collects unknown ones in unmapped", () => {
    const result = mapToMorrow(parseHermesEnv(FIXTURE));
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o");
    expect(result.settings.TEMPERATURE).toBe("0.2");
    expect(result.secrets.find((s) => s.envName === "OPENAI_API_KEY")).toMatchObject({ present: true });
    expect(result.secrets.find((s) => s.envName === "ANTHROPIC_API_KEY")).toMatchObject({ present: false });
    expect(result.unmapped).toContain("SOME_UNKNOWN_THING");
  });
});

describe("summarizeImport", () => {
  it("never leaks a secret value into the summary", () => {
    const summary = summarizeImport(mapToMorrow(parseHermesEnv(FIXTURE)));
    expect(summary).not.toContain("sk-supersecret-value");
    expect(summary).toContain("secret OPENAI_API_KEY: set (value not imported)");
    expect(summary).toContain("provider: openai");
    expect(summary).toContain("unmapped (1): SOME_UNKNOWN_THING");
  });
});
