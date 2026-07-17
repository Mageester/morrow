import { basename, relative, resolve } from "node:path";
import { dirname } from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { lookup } from "node:dns/promises";
import type { Browser, BrowserContext, Locator, Page } from "playwright";
import { sanitizeForModel } from "./injection-guard.js";
import type { BrowserActionOptions, BrowserAuditSink, BrowserController, BrowserDialogResponse, BrowserDownload, BrowserEvidence, BrowserViewport, DomRef, PageSnapshot } from "./types.js";

const MAX_PAGE_TEXT_BYTES = 32 * 1024;
const MAX_EVIDENCE = 200;
const MAX_EVIDENCE_MESSAGE = 512;
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const INTERACTIVE_SELECTOR = "a[href],button,input:not([type=password]),textarea,select,[role],[contenteditable=true]";

export interface PlaywrightControllerOptions {
  allowedDomains?: string[];
  allowPrivateNetwork?: boolean;
  allowedSchemes?: string[];
  uploadRoot?: string;
  downloadRoot?: string;
  cdpEndpoint?: string;
  session?: "isolated" | "persistent";
  profileDir?: string;
  browser?: "chromium" | "chrome" | "msedge";
  /** Defaults to visible browsing; callers must opt into headless mode. */
  headless?: boolean;
  timeoutMs?: number;
  audit?: BrowserAuditSink;
}

export function resolvePlaywrightChannel(
  browser: PlaywrightControllerOptions["browser"],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): "chrome" | "msedge" | undefined {
  if (browser === "chromium") return undefined;
  if (browser) return browser;
  const packaged = env.MORROW_PACKAGED === "1" || env.MORROW_PACKAGED === "true";
  return platform === "win32" && packaged ? "msedge" : undefined;
}

export function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Retained for callers that only need the configured domain policy. */
export function assertDomainAllowed(url: string, allowedDomains?: string[]): void {
  if (!allowedDomains || allowedDomains.length === 0) return;
  const host = hostnameOf(url);
  if (!host) throw new Error(`Invalid URL: ${url}`);
  const allowed = allowedDomains.some((domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`));
  if (!allowed) throw new Error(`Domain not allowed: ${host}`);
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
}

function privateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe80:") || normalized.startsWith("::ffff:127.") || normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

function sensitiveHostname(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "metadata.google.internal" || host === "metadata" || host.endsWith(".internal");
}

function safeUrlForEvidence(url: string): string {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
}

export function assertBrowserContainedPath(root: string, candidate: string, purpose: string): string {
  const absoluteRoot = resolve(root);
  const absoluteCandidate = resolve(candidate);
  const outside = relative(absoluteRoot, absoluteCandidate);
  if (!(outside === "" || (!outside.startsWith("..") && !outside.includes(":\\")))) {
    throw new Error(`${purpose} path must stay inside the configured directory`);
  }
  const realRoot = realpathSync(absoluteRoot);
  const realCandidate = existsSync(absoluteCandidate)
    ? realpathSync(absoluteCandidate)
    : resolve(realpathSync(dirname(absoluteCandidate)), basename(absoluteCandidate));
  const realOutside = relative(realRoot, realCandidate);
  if (realOutside === "" || (!realOutside.startsWith("..") && !realOutside.includes(":\\"))) return realCandidate;
  throw new Error(`${purpose} path must stay inside the configured directory (symlink escape rejected)`);
}

/**
 * Applies the SSRF policy before navigation and for every intercepted request.
 * Only HTTP(S) is accepted. Private addresses need an explicit opt-in plus an
 * explicit domain allow-list, which keeps local test/dev browsing deliberate.
 */
export async function assertBrowserUrlAllowed(url: string, options: Pick<PlaywrightControllerOptions, "allowedDomains" | "allowPrivateNetwork" | "allowedSchemes"> = {}): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid browser URL: ${url}`);
  }
  const schemes = options.allowedSchemes ?? ["http:", "https:"];
  if (!schemes.includes(parsed.protocol)) throw new Error(`Browser URL scheme is not allowed: ${parsed.protocol}`);
  assertDomainAllowed(url, options.allowedDomains);
  const host = parsed.hostname.toLowerCase();
  let sensitive = sensitiveHostname(host) || privateIpv4(host) || privateIpv6(host);
  if (!sensitive) {
    try {
      const addresses = await lookup(host, { all: true, verbatim: true });
      sensitive = addresses.some(({ address }) => privateIpv4(address) || privateIpv6(address));
    } catch {
      // DNS failures are handled by the browser; do not silently broaden access.
    }
  }
  if (sensitive) {
    const explicitlyAllowed = Boolean(options.allowPrivateNetwork && options.allowedDomains && options.allowedDomains.length > 0);
    if (!explicitlyAllowed) throw new Error(`Browser URL resolves to a private or metadata network target: ${host}`);
  }
}

class BrowserCancelledError extends Error {
  constructor() {
    super("Browser action cancelled");
  }
}

class PlaywrightBrowserController implements BrowserController {
  readonly id = "playwright";
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private ownsBrowser = false;
  private closed = false;
  private paused = false;
  private refs = new Map<string, Locator>();
  private events: BrowserEvidence[] = [];
  private dialogResponse: BrowserDialogResponse = { action: "dismiss" };
  private readonly timeoutMs: number;

  constructor(private readonly options: PlaywrightControllerOptions) {
    this.timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 100), 120_000);
  }

  private record(kind: BrowserEvidence["kind"], message: string, detail: Record<string, unknown> = {}): void {
    const event = { kind, message: message.slice(0, MAX_EVIDENCE_MESSAGE), detail, createdAt: new Date().toISOString() } satisfies BrowserEvidence;
    this.events.push(event);
    if (this.events.length > MAX_EVIDENCE) this.events.shift();
    void this.options.audit?.({ action: `browser.${kind}`, detail: { message: event.message, ...detail } });
  }

  private async abortable<T>(work: () => Promise<T>, options?: BrowserActionOptions): Promise<T> {
    if (options?.signal?.aborted) throw new BrowserCancelledError();
    if (this.paused) throw new Error("Browser session is paused");
    return new Promise<T>((resolvePromise, reject) => {
      const cancel = () => {
        this.record("cancelled", "Browser action cancelled");
        void this.page?.evaluate(() => window.stop()).catch(() => undefined);
        reject(new BrowserCancelledError());
      };
      options?.signal?.addEventListener("abort", cancel, { once: true });
      void work().then(resolvePromise, reject).finally(() => options?.signal?.removeEventListener("abort", cancel));
    });
  }

  private requirePage(): Page {
    if (this.closed) throw new Error("Browser controller is closed");
    if (!this.page) throw new Error("Browser session has not been started");
    return this.page;
  }

  private requireRef(ref: string): Locator {
    const locator = this.refs.get(ref);
    if (!locator) throw new Error(`Unknown or stale browser element reference: ${ref}`);
    return locator;
  }

  private async configurePage(page: Page): Promise<void> {
    page.setDefaultTimeout(this.timeoutMs);
    await page.route("**/*", async (route) => {
      try {
        await assertBrowserUrlAllowed(route.request().url(), this.options);
        await route.continue();
      } catch (error) {
        this.record("page-error", "Blocked browser request", { reason: error instanceof Error ? error.message : "blocked" });
        await route.abort("blockedbyclient");
      }
    });
    page.on("console", (message) => this.record("console", sanitizeForModel(message.text()).text, { level: message.type() }));
    page.on("pageerror", (error) => this.record("page-error", sanitizeForModel(error.message).text));
    page.on("dialog", (dialog) => {
      const response = this.dialogResponse;
      this.record("dialog", "Browser dialog", { type: dialog.type(), message: sanitizeForModel(dialog.message()).text });
      void (response.action === "accept" ? dialog.accept(response.promptText) : dialog.dismiss()).catch(() => undefined);
    });
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("Browser controller is closed");
    if (this.page) return;
    const { chromium } = await import("playwright");
    // Release packages intentionally omit Playwright's large browser download.
    // Windows includes Edge, so packaged consumers use its supported Playwright
    // channel unless the caller explicitly selects another browser.
    const channel = resolvePlaywrightChannel(this.options.browser);
    if (this.options.cdpEndpoint) {
      this.browser = await chromium.connectOverCDP(this.options.cdpEndpoint, { timeout: this.timeoutMs });
      this.context = this.browser.contexts()[0] ?? await this.browser.newContext({ acceptDownloads: true });
    } else if (this.options.session === "persistent") {
      if (!this.options.profileDir) throw new Error("Persistent browser sessions require profileDir");
      this.context = await chromium.launchPersistentContext(this.options.profileDir, { ...(channel ? { channel } : {}), headless: this.options.headless ?? false, acceptDownloads: true });
      this.browser = this.context.browser() ?? undefined;
      this.ownsBrowser = true;
    } else {
      this.browser = await chromium.launch({ ...(channel ? { channel } : {}), headless: this.options.headless ?? false });
      this.context = await this.browser.newContext({ acceptDownloads: true, serviceWorkers: "block" });
      this.ownsBrowser = true;
    }
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    await this.configurePage(this.page);
    this.record("lifecycle", "Browser session started", { session: this.options.session ?? "isolated", cdp: Boolean(this.options.cdpEndpoint), headless: this.options.headless ?? false });
  }

  async open(url: string, options?: BrowserActionOptions): Promise<PageSnapshot> {
    await assertBrowserUrlAllowed(url, this.options);
    await this.start();
    const page = this.requirePage();
    await this.abortable(() => page.goto(url, { waitUntil: "domcontentloaded", timeout: this.timeoutMs }), options);
    this.refs.clear();
    this.record("navigation", "Browser navigated", { url: safeUrlForEvidence(url) });
    return this.snapshot(options);
  }

  async snapshot(options?: BrowserActionOptions): Promise<PageSnapshot> {
    const page = this.requirePage();
    return this.abortable(async () => {
      const [url, title, viewport, text, elements] = await Promise.all([
        Promise.resolve(page.url()),
        page.title(),
        Promise.resolve(page.viewportSize()).then((size) => size ?? page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))),
        page.locator("body").innerText().then((value) => value.slice(0, MAX_PAGE_TEXT_BYTES)),
        page.locator(INTERACTIVE_SELECTOR).evaluateAll((nodes) => nodes.slice(0, 100).map((node) => {
          const element = node as HTMLElement;
          const tag = element.tagName.toLowerCase();
          const input = element as HTMLInputElement;
          const role = element.getAttribute("role") ?? (tag === "a" ? "link" : tag === "button" ? "button" : tag === "select" ? "combobox" : tag === "textarea" || tag === "input" ? "textbox" : "generic");
          const name = element.getAttribute("aria-label") ?? element.getAttribute("title") ?? (tag === "input" ? input.value : element.innerText).trim().slice(0, 200);
          return { role, name };
        })),
      ]);
      this.refs.clear();
      const refs: DomRef[] = elements.map((element, index) => {
        const ref = `e${index + 1}`;
        this.refs.set(ref, page.locator(INTERACTIVE_SELECTOR).nth(index));
        return { ref, ...element };
      });
      const sanitized = sanitizeForModel(text);
      this.record("snapshot", "Captured browser snapshot", { url: safeUrlForEvidence(url), refs: refs.length, injectionFindings: sanitized.findings.length });
      return { url, title, viewport, refs, text: sanitized.text, injectionFindings: sanitized.findings.length };
    }, options);
  }

  async setViewport(viewport: BrowserViewport, options?: BrowserActionOptions): Promise<void> {
    const width = Math.trunc(viewport.width);
    const height = Math.trunc(viewport.height);
    if (width < 320 || width > 2560 || height < 320 || height > 2560) {
      throw new Error("Browser viewport must be between 320 and 2560 pixels in each dimension");
    }
    if (viewport.label !== undefined && (viewport.label.length === 0 || viewport.label.length > 40)) {
      throw new Error("Browser viewport label must be between 1 and 40 characters");
    }
    await this.start();
    await this.abortable(() => this.requirePage().setViewportSize({ width, height }), options);
    this.refs.clear();
    this.record("viewport", "Changed browser viewport", { width, height, ...(viewport.label ? { label: viewport.label } : {}) });
  }

  async click(ref: string, options?: BrowserActionOptions): Promise<void> {
    await this.abortable(() => this.requireRef(ref).click({ timeout: this.timeoutMs }), options);
    this.record("click", "Clicked browser element", { ref });
  }

  async type(ref: string, text: string, options?: BrowserActionOptions): Promise<void> {
    await this.abortable(() => this.requireRef(ref).fill(text, { timeout: this.timeoutMs }), options);
    this.record("type", "Filled browser element", { ref, characters: text.length });
  }

  async key(key: string, options?: BrowserActionOptions): Promise<void> {
    if (key.length === 0 || key.length > 100) throw new Error("Browser keyboard action must be a non-empty key name");
    await this.abortable(() => this.requirePage().keyboard.press(key), options);
    this.record("key", "Sent browser keyboard action", { key });
  }

  async select(ref: string, value: string, options?: BrowserActionOptions): Promise<void> {
    await this.abortable(() => this.requireRef(ref).selectOption(value, { timeout: this.timeoutMs }), options);
    this.record("select", "Selected browser option", { ref, value: value.slice(0, 200) });
  }

  async upload(ref: string, sourcePath: string, options?: BrowserActionOptions): Promise<void> {
    if (!this.options.uploadRoot) throw new Error("Browser uploads require an explicit uploadRoot");
    const path = assertBrowserContainedPath(this.options.uploadRoot, sourcePath, "Upload");
    await this.abortable(() => this.requireRef(ref).setInputFiles(path, { timeout: this.timeoutMs }), options);
    this.record("upload", "Uploaded approved file", { ref, filename: basename(path) });
  }

  async download(ref: string, options?: BrowserActionOptions): Promise<BrowserDownload> {
    if (!this.options.downloadRoot) throw new Error("Browser downloads require an explicit downloadRoot");
    const page = this.requirePage();
    const download = await this.abortable(async () => {
      const pending = page.waitForEvent("download", { timeout: this.timeoutMs });
      await this.requireRef(ref).click({ timeout: this.timeoutMs });
      return pending;
    }, options);
    const filename = basename(download.suggestedFilename()).replace(/[^a-zA-Z0-9._-]/g, "_") || "download";
    const path = assertBrowserContainedPath(this.options.downloadRoot, resolve(this.options.downloadRoot, filename), "Download");
    await this.abortable(() => download.saveAs(path), options);
    this.record("download", "Saved browser download", { ref, filename });
    return { path, filename };
  }

  async setDialogHandler(response: BrowserDialogResponse): Promise<void> {
    this.dialogResponse = response;
    this.record("dialog", "Configured browser dialog handler", { action: response.action });
  }

  async screenshot(options?: BrowserActionOptions): Promise<Buffer> {
    const screenshot = await this.abortable(() => this.requirePage().screenshot({ type: "png", timeout: this.timeoutMs }), options);
    if (screenshot.length > MAX_SCREENSHOT_BYTES) throw new Error("Browser screenshot exceeds the 5 MB safety limit");
    this.record("screenshot", "Captured browser screenshot", { bytes: screenshot.length });
    return screenshot;
  }

  evidence(): BrowserEvidence[] {
    return [...this.events];
  }

  async pause(): Promise<void> {
    if (this.closed) throw new Error("Browser controller is closed");
    this.paused = true;
    this.record("lifecycle", "Browser session paused");
  }

  async resume(): Promise<void> {
    if (this.closed) throw new Error("Browser controller is closed");
    this.paused = false;
    this.record("lifecycle", "Browser session resumed");
  }

  async panic(): Promise<void> {
    if (this.closed) return;
    this.record("cancelled", "Browser session panic-stopped");
    await this.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.refs.clear();
    try {
      if (this.ownsBrowser) await this.browser?.close();
      else await this.page?.close();
    } finally {
      this.record("lifecycle", "Browser session closed");
      this.page = undefined;
      this.context = undefined;
      this.browser = undefined;
    }
  }
}

/** Creates a real Playwright browser controller; Playwright is a production dependency. */
export function playwrightController(options: PlaywrightControllerOptions = {}): BrowserController {
  return new PlaywrightBrowserController(options);
}
