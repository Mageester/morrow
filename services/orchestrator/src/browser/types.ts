/** Browser control contracts. Page content is data, never agent authority. */

export interface DomRef {
  ref: string;
  role: string;
  name: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  refs: DomRef[];
  /** Visible text with suspected prompt injections neutralized. */
  text: string;
  injectionFindings: number;
}

export interface BrowserEvidence {
  kind: "lifecycle" | "navigation" | "snapshot" | "viewport" | "click" | "type" | "key" | "select" | "upload" | "download" | "screenshot" | "dialog" | "console" | "page-error" | "cancelled";
  message: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface BrowserAuditEntry {
  action: string;
  detail: Record<string, unknown>;
}

export type BrowserAuditSink = (entry: BrowserAuditEntry) => void | Promise<void>;

export interface BrowserActionOptions {
  signal?: AbortSignal;
}

export interface BrowserDownload {
  path: string;
  filename: string;
}

export interface BrowserDialogResponse {
  action: "accept" | "dismiss";
  promptText?: string;
}

export interface BrowserViewport {
  width: number;
  height: number;
  label?: string;
}

export interface BrowserController {
  id: string;
  start(): Promise<void>;
  open(url: string, options?: BrowserActionOptions): Promise<PageSnapshot>;
  snapshot(options?: BrowserActionOptions): Promise<PageSnapshot>;
  setViewport(viewport: BrowserViewport, options?: BrowserActionOptions): Promise<void>;
  click(ref: string, options?: BrowserActionOptions): Promise<void>;
  type(ref: string, text: string, options?: BrowserActionOptions): Promise<void>;
  key(key: string, options?: BrowserActionOptions): Promise<void>;
  select(ref: string, value: string, options?: BrowserActionOptions): Promise<void>;
  upload(ref: string, sourcePath: string, options?: BrowserActionOptions): Promise<void>;
  download(ref: string, options?: BrowserActionOptions): Promise<BrowserDownload>;
  setDialogHandler(response: BrowserDialogResponse): Promise<void>;
  screenshot(options?: BrowserActionOptions): Promise<Buffer>;
  evidence(): BrowserEvidence[];
  pause(): Promise<void>;
  resume(): Promise<void>;
  panic(): Promise<void>;
  close(): Promise<void>;
}
