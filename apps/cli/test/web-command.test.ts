import { describe, expect, it } from "vitest";
import { webAppUrl } from "../src/commands/web.js";
import { COMMANDS } from "../src/main.js";

/**
 * Morrow serves a full web interface from the same local service as the CLI,
 * and for four releases nothing in the product mentioned it: `morrow --help`
 * listed forty commands and forty-five slash commands without naming the GUI,
 * and the URL appeared in no output. Reported by a user as "it's still very
 * unclear how to use the web gui in the app".
 */
describe("web interface discoverability", () => {
  it("derives the app URL from the service base URL", () => {
    expect(webAppUrl("http://127.0.0.1:4317")).toBe(
      "http://127.0.0.1:4317/app/",
    );
  });

  it("does not double the slash when the base URL already has one", () => {
    expect(webAppUrl("http://127.0.0.1:4317/")).toBe(
      "http://127.0.0.1:4317/app/",
    );
    expect(webAppUrl("http://127.0.0.1:4317///")).toBe(
      "http://127.0.0.1:4317/app/",
    );
  });

  it("honours a non-default host and port", () => {
    expect(webAppUrl("http://192.168.1.10:9999")).toBe(
      "http://192.168.1.10:9999/app/",
    );
  });

  it("is a real command, not treated as a prompt", () => {
    // Absent from COMMANDS, `morrow web` is sent to the agent as a question.
    expect(COMMANDS.has("web")).toBe(true);
    expect(COMMANDS.has("gui")).toBe(true);
    expect(COMMANDS.has("ui")).toBe(true);
  });
});
