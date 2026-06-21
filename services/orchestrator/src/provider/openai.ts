import { AiProvider, ChatMessage, ProviderChunk, StreamOptions } from "./base.js";

export class OpenAiProvider implements AiProvider {
  async *streamChat(messages: ChatMessage[], options: StreamOptions): AsyncIterable<ProviderChunk> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      yield {
        type: "error",
        error: { type: "no_provider_configured", message: "No AI provider configured" }
      };
      return;
    }

    const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
    
    // Safety check on scheme
    if (!baseUrl.startsWith("http://") && !baseUrl.startsWith("https://")) {
      yield {
        type: "error",
        error: { type: "security_error", message: "Invalid endpoint protocol" }
      };
      return;
    }

    const model = options.model || "gpt-4o-mini";
    const body: Record<string, any> = {
      model,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content || "",
        ...(m.toolCalls ? { tool_calls: m.toolCalls.map(tc => ({
          id: tc.id,
          type: tc.type,
          function: tc.function
        })) } : {}),
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {})
      })),
      stream: true,
      stream_options: { include_usage: true }
    };

    if (options.tools && options.tools.length > 0) {
      body.tools = options.tools.map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters
        }
      }));
    }

    const controller = new AbortController();
    const signal = controller.signal;

    if (options.abortSignal) {
      options.abortSignal.addEventListener("abort", () => {
        controller.abort();
      });
    }

    let timeoutId: any;
    if (options.timeoutMs) {
      timeoutId = setTimeout(() => {
        controller.abort();
      }, options.timeoutMs);
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal
      });
    } catch (e: any) {
      if (timeoutId) clearTimeout(timeoutId);
      if (options.abortSignal?.aborted || e.name === "AbortError") {
        yield { type: "error", error: { type: "cancelled", message: "Task execution cancelled" } };
        return;
      }
      yield { type: "error", error: { type: "network_error", message: e.message || "Network request failed" } };
      return;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errText = await response.text().catch(() => "Unknown error");
      let errJson: any;
      try {
        errJson = JSON.parse(errText);
      } catch {}
      const errMsg = errJson?.error?.message || errText;
      yield {
        type: "error",
        error: { type: "provider_error", message: errMsg }
      };
      return;
    }

    if (!response.body) {
      yield {
        type: "error",
        error: { type: "provider_error", message: "Empty stream response body" }
      };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed === "data: [DONE]") continue;

          if (trimmed.startsWith("data: ")) {
            const dataStr = trimmed.slice(6);
            let parsed: any;
            try {
              parsed = JSON.parse(dataStr);
            } catch {
              continue;
            }

            const choice = parsed.choices?.[0];
            const delta = choice?.delta;

            if (parsed.usage) {
              yield {
                type: "done",
                usage: {
                  promptTokens: parsed.usage.prompt_tokens,
                  completionTokens: parsed.usage.completion_tokens
                }
              };
            }

            if (delta) {
              if (delta.content) {
                yield {
                  type: "text",
                  text: delta.content
                };
              }
              if (delta.tool_calls) {
                yield {
                  type: "tool_call",
                  toolCalls: delta.tool_calls.map((tc: any) => ({
                    id: tc.id,
                    index: tc.index,
                    type: "function",
                    function: {
                      name: tc.function?.name || "",
                      arguments: tc.function?.arguments || ""
                    }
                  }))
                };
              }
            }
          }
        }
      }
    } catch (e: any) {
      if (options.abortSignal?.aborted || e.name === "AbortError") {
        yield { type: "error", error: { type: "cancelled", message: "Task execution cancelled" } };
        return;
      }
      yield { type: "error", error: { type: "stream_error", message: e.message || "Error reading stream" } };
      return;
    }
  }
}
