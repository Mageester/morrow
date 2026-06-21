export interface ChatMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  index?: number;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface ProviderChunk {
  type: "text" | "tool_call" | "done" | "error";
  text?: string;
  toolCalls?: ToolCall[];
  error?: {
    type: string;
    message: string;
  };
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
}

export interface StreamOptions {
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  tools?: ToolDefinition[];
  model?: string;
}

export interface AiProvider {
  streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk>;
}

export class ProviderError extends Error {
  constructor(public type: string, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}
