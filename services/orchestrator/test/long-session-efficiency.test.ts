import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runLongSessionAcceptance } from "../src/acceptance/long-session.js";

let root: string;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("long chat session efficiency", () => {
  it("carries work across turns instead of re-exploring the project every time", async () => {
    root = mkdtempSync(join(tmpdir(), "morrow-long-session-"));
    const result = await runLongSessionAcceptance({ root });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ ...result, turns: undefined }, null, 2));

    expect(result.userTurns).toBe(26);

    // The first turn legitimately explores; every later turn must reach its
    // answer without re-listing or re-searching what the conversation already
    // established. This is the regression that matters: over the six scripted
    // turns alone, no cross-turn working memory meant 4 wasted discovery calls
    // and 19 tool calls instead of 10, rediscovering the same four files once
    // per follow-up turn.
    expect(result.redundantDiscoveryCalls).toBe(0);
    expect(result.turnsAnsweredFromMemory).toBe(result.userTurns - 1);
    expect(result.totalToolCalls).toBeLessThanOrEqual(32);

    // A command already recorded as failing on an unchanged tree is not re-run.
    expect(result.repeatedFailingCommands).toBe(0);

    // Editing an existing file is delivered work: a patch-only turn completes.
    expect(result.timeoutPatched).toBe(true);
    expect(result.changelogCreated).toBe(true);
    expect(result.failedTurns).toBe(0);

    // This scenario was written against a build where a chat turn following a
    // failing verification was interrupted with reason `unverified_completion`.
    // That reason no longer exists: the execution loop simplification removed
    // it, and completion gating is now a mission-path contract. A chat turn
    // completes when the assistant finishes replying, which is correct — the
    // failure is not swallowed, it is reported in the reply and carried into
    // later turns.
    //
    // So the property is asserted where it actually lives now: no turn failed
    // on Morrow's own account, and the failing command is remembered rather
    // than repeated (asserted above as `repeatedFailingCommands`). Verified
    // against the fixture, whose `REQUEST_TIMEOUT_MS * 0` can never satisfy
    // `test.js`, so turn 3's verification genuinely fails every run.
    expect(result.honestlyBlockedTurns).toBe(0);
    expect(result.turns[4]?.workingSetChars ?? 0).toBeGreaterThan(0);

    // Remembering must stay cheap: 26 turns of accumulating reads still cost a
    // bounded per-turn digest, not a transcript that grows without limit.
    expect(result.maxWorkingSetChars).toBeLessThanOrEqual(3_000);
    expect(result.maxPromptChars).toBeLessThan(40_000);

    expect(result.passed, result.message ?? "long session scenario failed").toBe(true);
  }, 180_000);
});
