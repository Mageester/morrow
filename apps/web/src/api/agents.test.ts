import { afterEach, describe, expect, it, vi } from "vitest";
import type { Query } from "@tanstack/react-query";
import type { Roster, RosterStatus } from "@morrow/contracts";
import { agentQueries } from "./agents.js";

afterEach(() => vi.unstubAllGlobals());

/**
 * The rail is the only surface that shows a teammate working in another
 * thread, so it polls rather than waiting for a navigation. What it must not do
 * is keep spending a request every three seconds in a hidden tab where nothing
 * can change: with every teammate idle, the next change needs an action the
 * user has to return to the tab to take.
 *
 * The visible case stays unconditional on purpose. Sending a message does not
 * invalidate the roster, so an interval that waited for a teammate to already
 * look busy would leave the rail reading "idle" through the first seconds of
 * the run the user just started.
 */
describe("teammate roster polling", () => {
  function intervalFor(visibility: "visible" | "hidden", statuses: RosterStatus[]): number | false {
    vi.stubGlobal("document", { visibilityState: visibility });
    const { refetchInterval } = agentQueries.roster("p1");
    const data: Roster = {
      version: 1,
      projectId: "p1",
      entries: statuses.map((status, index) => ({
        version: 1, agentId: `a${index}`, name: `Teammate ${index}`, role: "assistant",
        instructions: null, modelLabel: null, enabled: true, status,
        lastLine: null, lastActivityAt: null, conversationId: null,
        conversationCount: 0, runningTaskCount: 0, pendingApprovalCount: 0,
      })),
    };
    const query = { state: { data } } as Query<Roster, Error, Roster, readonly unknown[]>;
    // An interval callback may return undefined for "no opinion"; the query
    // client treats that the same as not polling, so normalize it here.
    return (typeof refetchInterval === "function" ? refetchInterval(query) : refetchInterval) ?? false;
  }

  it("polls at full rate while the tab is visible, whatever the teammates are doing", () => {
    expect(intervalFor("visible", ["idle", "idle"])).toBe(3_000);
    expect(intervalFor("visible", ["working"])).toBe(3_000);
    expect(intervalFor("visible", [])).toBe(3_000);
  });

  it("keeps polling a hidden tab only while a run could still finish", () => {
    expect(intervalFor("hidden", ["idle", "working"])).toBe(3_000);
    // Blocked on an approval is still a run in flight the user came back for.
    expect(intervalFor("hidden", ["idle", "waiting"])).toBe(3_000);
  });

  it("stops polling a hidden tab once nothing is running", () => {
    expect(intervalFor("hidden", ["idle", "idle", "disabled"])).toBe(false);
    expect(intervalFor("hidden", [])).toBe(false);
  });
});
