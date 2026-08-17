import type { RawTransport } from "./client.js";

export interface SseTransportOptions {
  headers?: Record<string, string> | undefined;
  connectTimeoutMs?: number | undefined;
}

/**
 * SSE Transport for MCP (Model Context Protocol).
 *
 * Establishes a GET connection to an SSE endpoint, negotiates the client-to-server
 * message POST URL via the initial `endpoint` event, and bridges JSON-RPC messages.
 */
export async function createSseTransport(
  sseUrl: string,
  opts: SseTransportOptions = {}
): Promise<RawTransport> {
  const headers = {
    Accept: "text/event-stream",
    ...(opts.headers ?? {}),
  };

  const abortController = new AbortController();
  let endpointUrl: string | null = null;
  let dataHandler: ((chunk: string) => void) | null = null;
  let closed = false;

  const response = await fetch(sseUrl, {
    method: "GET",
    headers,
    signal: abortController.signal,
  });

  if (!response.ok || !response.body) {
    throw new Error(`Failed to connect to SSE endpoint (${response.status} ${response.statusText})`);
  }

  let closeHandler: ((err?: Error) => void) | null = null;
  let hasClosed = false;

  const notifyClosed = (err?: Error) => {
    if (hasClosed) return;
    hasClosed = true;
    if (closeHandler) closeHandler(err);
  };

  const endpointPromise = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for SSE endpoint negotiation (${opts.connectTimeoutMs ?? 15000}ms)`));
    }, opts.connectTimeoutMs ?? 15000);
    if (typeof timer.unref === "function") timer.unref();

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    async function pump() {
      try {
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) {
            notifyClosed(new Error("SSE connection stream ended"));
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          // Parse SSE lines
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const eventBlock = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);

            let eventType = "message";
            let dataLines: string[] = [];

            for (const line of eventBlock.split("\n")) {
              const trimmed = line.trim();
              if (trimmed.startsWith("event:")) {
                eventType = trimmed.slice(6).trim();
              } else if (trimmed.startsWith("data:")) {
                dataLines.push(trimmed.slice(5).trim());
              }
            }

            const data = dataLines.join("\n");

            if (eventType === "endpoint" && data) {
              clearTimeout(timer);
              const resolved = new URL(data, sseUrl).toString();
              endpointUrl = resolved;
              resolve(resolved);
            } else if (data) {
              if (dataHandler) {
                // Ensure newline termination for line-delimited message decoder
                dataHandler(data.endsWith("\n") ? data : data + "\n");
              }
            }
          }
        }
      } catch (err: any) {
        if (!closed && abortController.signal.aborted) {
          /* normal abort */
        } else if (!endpointUrl) {
          clearTimeout(timer);
          reject(err);
        }
        notifyClosed(err);
      }
    }

    pump();
  });

  await endpointPromise;

  const transport: RawTransport = {
    write(data: string) {
      if (closed || !endpointUrl) return;
      // Send POST message asynchronously
      fetch(endpointUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(opts.headers ?? {}),
        },
        body: data,
      }).catch((err) => {
        // Output transport error if necessary
      });
    },
    onData(handler) {
      dataHandler = handler;
    },
    onClose(handler) {
      closeHandler = handler;
      if (hasClosed) handler(new Error("SSE connection already closed"));
    },
    close() {
      closed = true;
      try {
        abortController.abort();
      } catch {}
      notifyClosed();
    },
  };

  return transport;
}
