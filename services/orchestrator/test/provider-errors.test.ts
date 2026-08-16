import { describe, expect, it } from "vitest";
import { classifyHttpStatus, ProviderError } from "../src/provider/base.js";
import { isRetryableProviderError } from "../src/provider/fallback.js";

describe("provider error taxonomy", () => {
  it("normalizes context-limit responses without treating them as generic validation", () => {
    expect(classifyHttpStatus(400, "maximum context length is 128000 tokens")).toMatchObject({
      type: "context_overflow",
      kind: "context_overflow",
      retryable: false,
      status: 400,
    });
    expect(classifyHttpStatus(413, "request entity too large for the prompt")).toMatchObject({
      type: "context_overflow",
      kind: "context_overflow",
      retryable: false,
      status: 413,
    });
    expect(classifyHttpStatus(422, "input token limit exceeded")).toMatchObject({
      type: "context_overflow",
      kind: "context_overflow",
      retryable: false,
      status: 422,
    });
  });

  it("keeps ordinary request validation errors separate", () => {
    expect(classifyHttpStatus(400, "tool_choice must be auto or none")).toMatchObject({
      type: "invalid_request",
      kind: "invalid_request",
      retryable: false,
    });
    expect(classifyHttpStatus(422, "response format is not supported")).toMatchObject({
      type: "invalid_request",
      kind: "invalid_request",
      retryable: false,
    });
  });

  it("does not send context overflow through provider fallback", () => {
    expect(isRetryableProviderError(new ProviderError("context_overflow", "maximum context length exceeded", {
      kind: "context_overflow",
      status: 400,
      retryable: false,
    }))).toBe(false);
  });
});
