import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { redactAcceptanceText, redactAcceptanceValue } from "../src/acceptance/redaction.js";
import { AcceptanceStore, assertContainedPath } from "../src/acceptance/storage.js";
import type { AcceptanceDisposition, AcceptanceRunState } from "../src/acceptance/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "morrow-acceptance-storage-"));
  roots.push(root);
  return root;
}

function initialState(runId = "run-20260716-abcdef12"): AcceptanceRunState {
  return {
    schemaVersion: 1,
    runId,
    scenarioId: "foundation-smoke-v1",
    lifecycle: "created",
    disposition: "NOT RUN",
    startedAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    completedAt: null,
    activeStep: null,
    completedSteps: [],
    recoveryCount: 0,
    fixture: null,
    product: null,
    source: null,
    checks: {},
    artifacts: [],
    message: null,
  };
}

describe("acceptance dispositions", () => {
  it("represents only the five truthful report states", () => {
    const values: AcceptanceDisposition[] = ["PASS", "FAIL", "BLOCKED", "NOT RUN", "INCONCLUSIVE"];
    expect(values).toEqual(["PASS", "FAIL", "BLOCKED", "NOT RUN", "INCONCLUSIVE"]);
  });
});

describe("acceptance redaction", () => {
  it("redacts credential assignments, bearer tokens, private keys, and seeded canaries", () => {
    const canary = "morrow-canary-super-secret";
    const input = [
      "OPENAI_API_KEY=sk-live-abcdefghijklmnopqrstuvwxyz",
      "Authorization: Bearer abc.def.ghi",
      "password: hunter2-secret",
      "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----",
      `fixture=${canary}`,
    ].join("\n");
    const output = redactAcceptanceText(input, [canary]);
    expect(output).not.toContain("sk-live");
    expect(output).not.toContain("abc.def.ghi");
    expect(output).not.toContain("hunter2-secret");
    expect(output).not.toContain("abc123");
    expect(output).not.toContain(canary);
    expect(output.match(/\[REDACTED\]/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("redacts nested evidence values without changing booleans or numbers", () => {
    const output = redactAcceptanceValue({ token: "Bearer secret-token", nested: ["API_KEY=abcdef123456", 7, true] });
    expect(output).toEqual({ token: "[REDACTED]", nested: ["API_KEY=[REDACTED]", 7, true] });
  });
});

describe("acceptance storage", () => {
  it("rejects unsafe run ids and paths outside the run root", () => {
    const root = tempRoot();
    expect(() => new AcceptanceStore(root).runRoot("../escape")).toThrow(/run id/i);
    expect(() => assertContainedPath(root, root)).toThrow(/descendant/i);
    expect(() => assertContainedPath(root, join(root, "..", "escape"))).toThrow(/outside/i);
    expect(assertContainedPath(root, join(root, "run-1"))).toBe(join(root, "run-1"));
  });

  it("round-trips atomic state and leaves no temporary file", () => {
    const root = tempRoot();
    const store = new AcceptanceStore(root);
    const state = initialState();
    store.create(state);
    store.save({ ...state, lifecycle: "running", completedSteps: ["fixture"], updatedAt: "2026-07-16T12:01:00.000Z" });
    expect(store.load(state.runId)).toMatchObject({ lifecycle: "running", completedSteps: ["fixture"] });
    expect(() => readFileSync(join(store.runRoot(state.runId), "state.json.tmp"))).toThrow();
  });

  it("appends sequenced redacted evidence without rewriting earlier entries", () => {
    const root = tempRoot();
    const store = new AcceptanceStore(root, { secrets: ["fixture-canary"] });
    const state = initialState();
    store.create(state);
    const first = store.appendEvidence(state.runId, {
      step: "fixture",
      kind: "git",
      status: "passed",
      summary: "starting SHA recorded",
    });
    const second = store.appendEvidence(state.runId, {
      step: "product",
      kind: "command",
      status: "passed",
      summary: "Bearer raw-token and fixture-canary",
      artifact: "artifacts/product.stdout.txt",
    });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    const entries = store.readEvidence(state.runId);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.summary).toBe("starting SHA recorded");
    expect(entries[1]?.summary).toBe("[REDACTED] and [REDACTED]");
    expect(readFileSync(join(store.runRoot(state.runId), "evidence.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
  });
});
