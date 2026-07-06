import { describe, it, expect } from "vitest";
import { Output } from "../src/cli/output.js";
import { resumeDigestLines, resumeNoticeText, resumeHasWarnings, type ResumeDigest } from "../src/terminal/resume.js";

const plain = new Output({ json: false, quiet: false, color: false });

function digest(over: Partial<ResumeDigest> = {}): ResumeDigest {
  return {
    priorMessages: 8,
    git: { branch: "main", dirty: 0, ahead: 0, behind: 0 },
    staleness: { changedScopes: [], itemsMarked: 0, architectureStale: false },
    ...over,
  };
}

describe("resume freshness digest", () => {
  it("reports a clean, current session with no warnings", () => {
    const d = digest();
    expect(resumeHasWarnings(d)).toBe(false);
    const text = resumeDigestLines(d, plain, false).join("\n");
    expect(text).toContain("Resuming this session");
    expect(text).toContain("8 earlier messages restored");
    expect(text).toContain("clean");
    expect(text).toContain("current");
    expect(resumeNoticeText(d)).toContain("look current");
  });

  it("flags uncommitted changes as external repository drift", () => {
    const d = digest({ git: { branch: "main", dirty: 3, ahead: 0, behind: 0 } });
    expect(resumeHasWarnings(d)).toBe(true);
    expect(resumeDigestLines(d, plain, false).join("\n")).toContain("3 uncommitted changes");
    expect(resumeNoticeText(d)).toContain("3 uncommitted changes");
  });

  it("warns when the upstream moved (behind)", () => {
    const d = digest({ git: { branch: "main", dirty: 0, ahead: 1, behind: 2 } });
    expect(resumeHasWarnings(d)).toBe(true);
    const text = resumeDigestLines(d, plain, false).join("\n");
    expect(text).toContain("Upstream moved");
    expect(text).toContain("1 ahead · 2 behind");
  });

  it("flags stale Cortex knowledge with changed scopes and architecture", () => {
    const d = digest({ staleness: { changedScopes: ["src/auth", "src/api"], itemsMarked: 5, architectureStale: true } });
    expect(resumeHasWarnings(d)).toBe(true);
    const text = resumeDigestLines(d, plain, false).join("\n");
    expect(text).toContain("2 scopes changed");
    expect(text).toContain("architecture flagged");
    expect(text).toContain("src/auth");
    expect(text).toContain("morrow cortex refresh");
    expect(resumeNoticeText(d)).toContain("Cortex may be stale");
  });

  it("handles a non-Git directory and an unmapped project honestly", () => {
    const d = digest({ git: { branch: null, dirty: 0, ahead: 0, behind: 0 }, staleness: null });
    const text = resumeDigestLines(d, plain, false).join("\n");
    expect(text).toContain("not a Git repository");
    expect(text).toContain("no Cortex map");
  });
});
