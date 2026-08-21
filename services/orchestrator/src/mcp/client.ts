import { encodeMessage, createMessageDecoder } from "./framing.js";

/**
 * A minimal MCP (Model Context Protocol) client over an injectable stdio-style
 * transport. The transport is just "write a string / receive string chunks /
 * close", so the real one wraps a child process and tests use an in-process
 * fake — the JSON-RPC logic is identical and fully deterministic either way.
 *
 * Tool exposure is filtered through an optional allow-list: a server can never
 * surface a tool Morrow did not opt into, and `callTool` refuses a disallowed
 * name even if the caller asks for it.
 */

export interface RawTransport {
  write(data: string): void;
  onData(handler: (chunk: string) => void): void;
  onClose?: ((handler: (err?: Error) => void) => void) | undefined;
  close(): void;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = createMessageDecoder();
  private readonly allowed: Set<string> | undefined;
  private readonly requestTimeoutMs: number;
  private closed = false;

  constructor(
    private readonly transport: RawTransport,
    opts: { allowedTools?: string[] | undefined; requestTimeoutMs?: number | undefined } = {}
  ) {
    this.allowed = opts.allowedTools ? new Set(opts.allowedTools) : undefined;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30000;
    transport.onData((chunk) => {
      for (const message of this.decoder.push(chunk)) this.handle(message as Record<string, unknown>);
    });
    if (typeof transport.onClose === "function") {
      transport.onClose((err) => {
        this.closeWithError(err ?? new Error("MCP transport closed unexpectedly"));
      });
    }
  }

  closeWithError(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.transport.close();
  }

  private handle(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "number" || !this.pending.has(id)) return;
    const pending = this.pending.get(id)!;
    this.pending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    if (message.error) {
      const err = message.error as { message?: string };
      pending.reject(new Error(err.message ?? "MCP server error"));
    } else {
      pending.resolve(message.result);
    }
  }

  private request<T = unknown>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(new Error("MCP client is closed"));
    if (signal?.aborted) return Promise.reject(new Error("AbortError"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        this.requestTimeoutMs > 0
          ? setTimeout(() => {
              if (this.pending.delete(id)) reject(new Error(`MCP request "${method}" timed out`));
            }, this.requestTimeoutMs)
          : null;
      if (timer && typeof timer.unref === "function") timer.unref();
      const onAbort = () => {
        if (this.pending.delete(id)) {
          if (timer) clearTimeout(timer);
          reject(new Error("AbortError"));
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const resolveOnce = (value: unknown) => { signal?.removeEventListener("abort", onAbort); resolve(value as T); };
      const rejectOnce = (error: Error) => { signal?.removeEventListener("abort", onAbort); reject(error); };
      this.pending.set(id, { resolve: resolveOnce, reject: rejectOnce, timer });
      this.transport.write(encodeMessage({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }));
    });
  }

  initialize(signal?: AbortSignal): Promise<unknown> {
    return this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "morrow", version: "0.1.0" },
    }, signal);
  }

  ping(signal?: AbortSignal): Promise<unknown> {
    return this.request("ping", undefined, signal);
  }

  async listTools(signal?: AbortSignal): Promise<McpTool[]> {
    const result = await this.request<{ tools?: McpTool[] }>("tools/list", undefined, signal);
    const tools = result?.tools ?? [];
    return this.allowed ? tools.filter((tool) => this.allowed!.has(tool.name)) : tools;
  }

  async listResources(signal?: AbortSignal): Promise<McpResource[]> {
    const result = await this.request<{ resources?: McpResource[] }>("resources/list", undefined, signal);
    return result?.resources ?? [];
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<{ contents: McpResourceContent[] }> {
    const result = await this.request<{ contents?: McpResourceContent[] }>("resources/read", { uri }, signal);
    return { contents: result?.contents ?? [] };
  }

  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    if (this.allowed && !this.allowed.has(name)) {
      return Promise.reject(new Error(`Tool not allowed: ${name}`));
    }
    return this.request("tools/call", { name, arguments: args }, signal);
  }

  close(): void {
    this.closed = true;
    for (const [, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error("MCP client closed"));
    }
    this.pending.clear();
    this.transport.close();
  }
}
