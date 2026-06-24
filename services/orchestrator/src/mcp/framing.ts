/**
 * Newline-delimited JSON-RPC framing for the MCP stdio transport. Each message
 * is a single JSON object on its own line. The decoder buffers partial chunks
 * and emits complete messages, skipping blank or malformed lines rather than
 * throwing (a misbehaving server must never crash the client).
 */

export function encodeMessage(message: unknown): string {
  return JSON.stringify(message) + "\n";
}

export interface MessageDecoder {
  push(chunk: string): unknown[];
}

export function createMessageDecoder(): MessageDecoder {
  let buffer = "";
  return {
    push(chunk: string): unknown[] {
      buffer += chunk;
      const messages: unknown[] = [];
      let newline: number;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          messages.push(JSON.parse(line));
        } catch {
          /* skip malformed line */
        }
      }
      return messages;
    },
  };
}
