import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isLiveProviderOptedIn } from "../../src/acceptance/flagship-gate.js";

/**
 * §8+§9 live acceptance: GLM-5.2 completes a real request through Morrow's
 * OpenCode Go provider path. Set MORROW_LIVE_OPENCODE_GO=1 for an explicit
 * live canary; configured credentials alone never authorize this suite. The
 * test reads the user's already-authenticated
 * OpenCode Desktop key from the on-disk auth store (NEVER printing the value),
 * sends a small chat/completions request to https://opencode.ai/zen/go/v1
 * (verified endpoint), and asserts the model returned text.
 *
 * Skipped (with PASS) when the on-disk key is missing or
 * MORROW_SKIP_LIVE_OPENCODE_GO=1 is set — the test does not fabricate
 * success. The user can opt-in by removing the env var and ensuring
 * ~/.local/share/opencode/auth.json contains the opencode-go entry
 * (`{ "type": "api", "key": "..." }`).
 */

const SKIP_ENV = "MORROW_SKIP_LIVE_OPENCODE_GO";
const OPT_IN_ENV = "MORROW_LIVE_OPENCODE_GO";
const ENDPOINT = "https://opencode.ai/zen/go/v1";
const MODEL = "glm-5.2";

interface AuthEntry {
  type?: string;
  key?: string;
}

function readOpencodeGoKey(): { ok: true; key: string; type: string } | { ok: false; reason: string } {
  if (!isLiveProviderOptedIn(process.env, OPT_IN_ENV)) return { ok: false, reason: `${OPT_IN_ENV}=1 is required; skipping live test.` };
  if (process.env[SKIP_ENV] === "1") return { ok: false, reason: `${SKIP_ENV}=1 set; skipping live test.` };
  const candidates = [
    join(homedir(), ".local", "share", "opencode", "auth.json"),
    join(process.env.USERPROFILE ?? "", ".local", "share", "opencode", "auth.json"),
  ];
  for (const path of candidates) {
    if (!path) continue;
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, AuthEntry>;
      const entry = parsed["opencode-go"];
      if (!entry || typeof entry.key !== "string" || entry.key.length === 0) {
        return { ok: false, reason: `${path} has no opencode-go entry with a key` };
      }
      // The key is captured in a closure-local variable for the duration of
      // this test run; we never log, print, or commit it. The variable is
      // overwritten with an empty string at afterAll to limit its lifetime.
      return { ok: true, key: entry.key, type: entry.type ?? "api" };
    } catch (e) {
      return { ok: false, reason: `Could not parse ${path}: ${(e as Error).message}` };
    }
  }
  return { ok: false, reason: "No on-disk OpenCode Desktop auth.json found." };
}

interface ChatResponse {
  id: string;
  choices: Array<{ message: { content: string }; finish_reason: string }>;
  model: string;
}

let keyClosure: { value: string } | null = null;

beforeAll(() => {
  const found = readOpencodeGoKey();
  if (found.ok) {
    keyClosure = { value: found.key };
  } else {
    // The describe will skip individual tests via the `skipIf` pattern.
    keyClosure = null;
    // eslint-disable-next-line no-console
    console.warn(`[live] GLM-5.2 through OpenCode Go: ${found.reason}`);
  }
});

afterAll(() => {
  // Overwrite the closure-local secret so it doesn't linger in memory.
  if (keyClosure) keyClosure.value = "";
  keyClosure = null;
});

describe("live: OpenCode Go provider — GLM-5.2 completes a real request", () => {
  it("returns a non-empty assistant message via /v1/chat/completions", async () => {
    if (!keyClosure || !keyClosure.value) {
      // Honest skip — no fabrication, no key printed.
      return;
    }
    const apiKey = keyClosure.value;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      // A shared live endpoint can transiently return an empty completion
      // under load (observed: HTTP 200, finish=stop, contentLength=0 during
      // a full-suite run while isolated runs succeed). Allow exactly one
      // retry for that specific transient shape; HTTP errors and schema
      // violations remain hard failures.
      let json: ChatResponse | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(`${ENDPOINT}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: MODEL,
            messages: [
              { role: "system", content: "You are a terse assistant. Reply with one short sentence." },
              { role: "user", content: "What is 2+2? Reply with the number only." },
            ],
            max_tokens: 32,
            temperature: 0,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text();
          // Honest reporting — do not pass on a failure to fetch.
          throw new Error(`OpenCode Go /v1/chat/completions HTTP ${response.status}: ${body.slice(0, 200)}`);
        }
        const candidate = (await response.json()) as ChatResponse | null;
        json = candidate;
        const content = candidate?.choices?.[0]?.message?.content;
        if (typeof content === "string" && content.length > 0) break;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      if (!json) throw new Error("OpenCode Go /v1/chat/completions returned a null JSON response");
      const payload = json;
      // The model must come back as glm-5.2 (or be a model the provider
      // routes the call to). The body must be a non-empty string.
      expect(typeof payload.model).toBe("string");
      // Log the wire-level evidence (model id, finish_reason, content
      // length) so the live test produces a paper trail in the test log
      // without ever printing the key. NEVER log the Authorization header
      // or the body verbatim — it could be echoed back by the provider.
      // eslint-disable-next-line no-console
      console.log(`[live] opencode-go glm-5.2 response: model=${payload.model} finish=${payload.choices[0]?.finish_reason} contentLength=${payload.choices[0]?.message?.content.length ?? 0}`);
      expect(payload.choices.length).toBeGreaterThan(0);
      const content = payload.choices[0]!.message.content;
      expect(typeof content).toBe("string");
      expect(content.length).toBeGreaterThan(0);
      // §9 acceptance: the model the user requested (glm-5.2) is what
      // answered. Some providers echo the requested id verbatim; others
      // echo a routing alias. We accept either, but the model field must
      // include "glm-5.2" OR the request must have been routed to a
      // OpenCode Go model (which we've already confirmed by reaching the
      // /v1/chat/completions endpoint behind the opencode-go auth).
      expect(payload.model.toLowerCase()).toMatch(/glm[-_.]?5[._-]?2/);
      // §9 acceptance: a real completion was returned through the OpenCode
      // Go path. We do NOT assert the literal "4" because the model may
      // respond with "4" or "4." or "The answer is 4." — all are real
      // model output, all prove the wire is live.
    } finally {
      clearTimeout(timer);
    }
  }, 30_000);

  it("honors the skip env var without fabricating success", () => {
    // The other test in this file is gated on a live key. This test asserts
    // that the gate itself behaves correctly when MORROW_SKIP_LIVE_OPENCODE_GO=1.
    if (process.env[OPT_IN_ENV] !== "1" && process.env[SKIP_ENV] !== "1") {
      expect(keyClosure).toBeNull();
      return;
    }
    if (process.env[SKIP_ENV] !== "1") {
      // This test is a no-op when live credentials are available; the other
      // test is the real assertion.
      return;
    }
    expect(keyClosure).toBeNull();
  });
});
