import { describe, expect, it } from "vitest";
import { translateReasoning } from "../src/provider/reasoning.js";

describe("opaque provider reasoning capabilities", () => {
  const capability = {
    mode: "selectable" as const,
    efforts: [{ id: "thinking:maximum", label: "Maximum", wireValue: "max" }],
    supportsOff: true,
  };

  it("translates the provider-owned opaque id using its wire value", () => {
    expect(translateReasoning({ mode: "effort", effort: "thinking:maximum" }, "openai-chat", capability)).toEqual({
      ok: true,
      params: { reasoning_effort: "max" },
    });
  });

  it("rejects an effort that the exact route did not report", () => {
    expect(translateReasoning({ mode: "effort", effort: "high" }, "openai-chat", capability)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Unsupported reasoning effort "high"'),
    });
  });

  it("rejects active reasoning controls when the exact route is unknown", () => {
    expect(translateReasoning({ mode: "effort", effort: "thinking:maximum" }, "openai-chat", {
      mode: "unknown",
      efforts: [],
    })).toMatchObject({ ok: false });
  });
});
