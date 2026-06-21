import type { TaskEvent } from "@morrow/contracts";

const TERMINAL_TYPES = new Set([
  "task.verified",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "task.interrupted",
]);

export interface StreamOptions {
  /** Resume after this sequence number (inclusive-exclusive: events with seq > after). */
  after?: number;
  signal?: AbortSignal;
  /** Max reconnect attempts on transient network failure before giving up. */
  maxReconnects?: number;
}

/**
 * Stream task events over SSE, yielding each event exactly once (deduplicated by
 * sequence) and reconnecting transparently after a dropped connection — resuming
 * from the highest sequence seen so no text is duplicated. Completes when a
 * terminal event arrives or the signal aborts.
 */
export async function* streamTaskEvents(
  baseUrl: string,
  taskId: string,
  options: StreamOptions = {}
): AsyncGenerator<TaskEvent> {
  let highest = options.after ?? 0;
  let reconnects = 0;
  const maxReconnects = options.maxReconnects ?? 20;

  while (true) {
    if (options.signal?.aborted) return;
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/tasks/${taskId}/events/stream?after=${highest}`, {
        headers: { Accept: "text/event-stream" },
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch {
      if (options.signal?.aborted) return;
      if (reconnects++ >= maxReconnects) return;
      await delay(Math.min(1000 * reconnects, 5000), options.signal);
      continue;
    }
    if (!res.ok || !res.body) {
      if (reconnects++ >= maxReconnects) return;
      await delay(1000, options.signal);
      continue;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let terminated = false;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const event = parseBlock(block);
          if (!event) continue;
          if (event.sequence <= highest) continue;
          highest = event.sequence;
          yield event;
          if (TERMINAL_TYPES.has(event.type)) {
            terminated = true;
            break;
          }
        }
        if (terminated) break;
      }
    } catch {
      // fall through to reconnect logic
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }

    if (terminated || options.signal?.aborted) return;
    // Stream ended without a terminal event (server closed). Reconnect to resume.
    if (reconnects++ >= maxReconnects) return;
    await delay(300, options.signal);
  }
}

function parseBlock(block: string): TaskEvent | null {
  const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
  if (!dataLine) return null;
  try {
    return JSON.parse(dataLine.slice(5).trim()) as TaskEvent;
  } catch {
    return null;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
