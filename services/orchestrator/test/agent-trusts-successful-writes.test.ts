import { describe, it, expect } from "vitest";
import { boundCompletedToolArguments, boundTerminalToolArguments, buildProviderProjection } from "../src/execution/provider-projection.js";

/**
 * Scenario B from the v0.8.1 gauntlet: write a file, read it back completely,
 * and continue. The observed failure was not in the tools — both succeeded —
 * but in what the *transcript* said about them on the following turn. A model
 * that looks back and sees its own successful write with the `content` field
 * gone, annotated in Morrow's persistence vocabulary, starts asking whether the
 * write really happened. These assertions pin the transcript, because the
 * transcript is what produced the doubt.
 */
describe("a successful oversized write reads as settled fact", () => {
  const body = "console.log('app');\n".repeat(600); // ~12 KB, over the 8 KB bound
  const args = JSON.stringify({ path: "public/app.js", content: body });

  it("states the outcome instead of describing Morrow's storage", () => {
    const projected = JSON.parse(boundCompletedToolArguments("create_file", args)) as Record<string, unknown>;

    expect(projected.path).toBe("public/app.js");
    expect(projected.content).toBeUndefined();
    expect(projected.write_succeeded).toBe(true);
    expect(projected.bytes_written).toBe(Buffer.byteLength(body, "utf8"));

    const note = String(projected.note);
    // What the model needs: it worked, the file holds these bytes, the body was
    // really sent, and checking by rewriting is wrong.
    expect(note).toContain("completed successfully");
    expect(note).toContain("public/app.js");
    expect(note).toContain("sent in full");
    expect(note).toContain("Do not rewrite the file to check");

    // What the model must never be handed: Morrow's persistence internals, or
    // an instruction that reads as "go and confirm this actually happened".
    for (const leak of ["durable_context", "durable execution history", "payloadSha256", "originalBytes", "recovery"]) {
      expect(note + JSON.stringify(projected)).not.toContain(leak);
    }
  });

  it("does not tell the model to go and verify the write it just made", () => {
    const note = String((JSON.parse(boundCompletedToolArguments("create_file", args)) as any).note);
    expect(note).not.toMatch(/inspect the workspace/i);
    expect(note).not.toMatch(/verify|confirm|make sure/i);
  });

  it("keeps a failed write honest and repairable in the same plain terms", () => {
    const failed = JSON.parse(boundTerminalToolArguments("create_file", args, "failed")) as Record<string, unknown>;
    expect(failed.path).toBe("public/app.js");
    expect(failed.write_succeeded).toBe(false);
    expect(String(failed.note)).toContain("send the call again with the body included");
    expect(JSON.stringify(failed)).not.toContain("durable_context");
  });

  it("leaves the whole projected transcript free of persistence vocabulary", () => {
    const messages = buildProviderProjection({
      prefixMessages: [{ role: "user", content: "Build the app." }],
      turns: [
        { turnKey: "t1", assistantText: "Writing the app.", toolCalls: [{ id: "w1", name: "create_file", arguments: args }] },
        { turnKey: "t2", assistantText: "Reading it back.", toolCalls: [{ id: "r1", name: "read_file", arguments: JSON.stringify({ path: "public/app.js" }) }] },
      ],
      toolResults: [
        { id: "w1", toolName: "create_file", result: JSON.stringify({ path: "public/app.js", bytes: body.length }), status: "completed" },
        { id: "r1", toolName: "read_file", result: JSON.stringify({ path: "public/app.js", truncated: false, size: body.length }), status: "completed" },
      ],
    });

    const transcript = JSON.stringify(messages);
    expect(transcript).not.toContain("durable_context");
    expect(transcript).not.toContain("durable execution history");
    // The body itself still must not be replayed — that bound is the reason
    // any of this exists.
    expect(transcript).not.toContain(body);
    // And the authoritative read stays intact and trustworthy.
    expect(messages.at(-1)?.content).toContain('"truncated":false');
  });
});
