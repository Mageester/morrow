import { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "./base.js";

export class MockProvider implements AiProvider {
  private turnIndex = 0;
  readonly requests: ChatMessage[][] = [];

  constructor(
    private scenario: {
      chunks: ProviderChunk[] | ProviderChunk[][];
      delayMs?: number;
      throwError?: Error;
    }
  ) {}

  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    this.requests.push(messages.map((message) => ({
      ...message,
      ...(message.images ? { images: message.images.map((image) => ({ ...image })) } : {}),
    })));
    if (this.scenario.throwError) {
      throw this.scenario.throwError;
    }

    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const chunksToUse = Array.isArray(this.scenario.chunks[0])
      ? (this.scenario.chunks as ProviderChunk[][])[this.turnIndex] || []
      : (this.scenario.chunks as ProviderChunk[]);

    this.turnIndex++;

    for (const chunk of chunksToUse) {
      if (options.abortSignal?.aborted) {
        yield {
          type: "error",
          error: { type: "cancelled", kind: "cancelled", message: "Task execution cancelled", retryable: false }
        };
        return;
      }
      if (this.scenario.delayMs) {
        await delay(this.scenario.delayMs);
      }
      if (options.abortSignal?.aborted) {
        yield {
          type: "error",
          error: { type: "cancelled", kind: "cancelled", message: "Task execution cancelled", retryable: false }
        };
        return;
      }
      yield chunk;
    }
  }
}
