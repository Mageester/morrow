import { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "./base.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";

/**
 * Backward-compatible OpenAI provider that resolves credentials from the
 * environment. New code should construct providers through the registry, which
 * supports the full multi-provider matrix. This wrapper keeps the original
 * no-argument constructor working and preserves the "no provider configured"
 * failure contract used by the agent runtime and existing tests.
 */
export class OpenAiProvider implements AiProvider {
  readonly id = "openai";

  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      yield {
        type: "error",
        error: { type: "no_provider_configured", kind: "auth", message: "No AI provider configured", retryable: false },
      };
      return;
    }

    const delegate = new OpenAiCompatibleProvider({
      id: "openai",
      apiKey,
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      defaultModel: options.model || "gpt-5.4-mini",
      includeUsage: true,
    });

    yield* delegate.streamChat(messages, options);
  }
}
