import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { webhookAdapter, telegramAdapter, loadAdaptersFromEnv, notifyAll, type MessageAdapter } from "../src/messaging/adapter.js";
import { openDatabase } from "../src/database.js";
import { buildServer } from "../src/server.js";
import { TaskRunner } from "../src/runner.js";

function capturingFetch(response: { ok?: boolean; status?: number } | Error) {
  const calls: Array<{ url: string; init: any }> = [];
  const fn = (async (url: string, init: any) => {
    calls.push({ url, init });
    if (response instanceof Error) throw response;
    return { ok: response.ok ?? true, status: response.status ?? 200 } as Response;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("webhookAdapter", () => {
  it("POSTs the text (and subject) as JSON to the configured URL", async () => {
    const { fn, calls } = capturingFetch({ ok: true, status: 200 });
    const adapter = webhookAdapter({ url: "https://hooks.example/x", fetchImpl: fn });
    const result = await adapter.send({ text: "hello", subject: "subj" });
    expect(result).toEqual({ ok: true, detail: "HTTP 200" });
    expect(calls[0]!.url).toBe("https://hooks.example/x");
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ text: "hello", subject: "subj" });
  });

  it("reports failure without throwing when the transport errors", async () => {
    const { fn } = capturingFetch(new Error("ECONNREFUSED"));
    const result = await webhookAdapter({ url: "https://x", fetchImpl: fn }).send({ text: "hi" });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/ECONNREFUSED/);
  });
});

describe("telegramAdapter", () => {
  it("POSTs to the Bot API sendMessage URL with chat id and text", async () => {
    const { fn, calls } = capturingFetch({ ok: true, status: 200 });
    const adapter = telegramAdapter({ botToken: "SECRET123", chatId: "42", fetchImpl: fn });
    await adapter.send({ text: "ping", subject: "Morrow" });
    expect(calls[0]!.url).toBe("https://api.telegram.org/botSECRET123/sendMessage");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ chat_id: "42", text: "Morrow\nping" });
  });

  it("redacts the bot token from error detail", async () => {
    const fn = (async () => {
      throw new Error("failed calling https://api.telegram.org/botSECRET123/sendMessage");
    }) as unknown as typeof fetch;
    const result = await telegramAdapter({ botToken: "SECRET123", chatId: "42", fetchImpl: fn }).send({ text: "x" });
    expect(result.ok).toBe(false);
    expect(result.detail).not.toContain("SECRET123");
    expect(result.detail).toContain("***");
  });
});

describe("loadAdaptersFromEnv", () => {
  it("builds configured adapters and returns [] when nothing is set", () => {
    expect(loadAdaptersFromEnv({})).toEqual([]);
    const adapters = loadAdaptersFromEnv({ MORROW_WEBHOOK_URL: "https://x", MORROW_TELEGRAM_BOT_TOKEN: "t", MORROW_TELEGRAM_CHAT_ID: "1" });
    expect(adapters.map((a) => a.id).sort()).toEqual(["telegram", "webhook"]);
    // Telegram requires BOTH token and chat id.
    expect(loadAdaptersFromEnv({ MORROW_TELEGRAM_BOT_TOKEN: "t" })).toEqual([]);
  });
});

describe("notifyAll + POST /api/notify", () => {
  let db: any;
  let app: any;
  const fakeAdapter = (id: string, ok: boolean): MessageAdapter => ({
    id,
    channel: "webhook",
    send: async () => ({ ok, detail: ok ? "sent" : "rejected" }),
  });

  beforeEach(() => {
    db = openDatabase(":memory:");
    app = buildServer({ db, runner: new TaskRunner(db, async () => {}), messageAdapters: [fakeAdapter("a", true), fakeAdapter("b", false)] });
  });
  afterEach(() => {
    app.close();
    db.close();
  });

  it("fans out to every adapter and aggregates results", async () => {
    const outcomes = await notifyAll([fakeAdapter("a", true), fakeAdapter("b", false)], { text: "hi" });
    expect(outcomes).toEqual([
      { channel: "a", ok: true, detail: "sent" },
      { channel: "b", ok: false, detail: "rejected" },
    ]);
  });

  it("POST /api/notify returns the sent count and per-adapter results", async () => {
    const res = await app.inject({ method: "POST", url: "/api/notify", payload: { text: "build done" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().sent).toBe(1);
    expect(res.json().results.map((r: any) => r.channel)).toEqual(["a", "b"]);
  });

  it("rejects an empty notification body", async () => {
    expect((await app.inject({ method: "POST", url: "/api/notify", payload: { text: "  " } })).statusCode).toBe(400);
  });
});
