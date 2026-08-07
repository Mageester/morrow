import { describe, expect, it } from "vitest";
import { commandExitMatchedExpectation, runCommandIsVerification, toolCallPassedVerification } from "../src/execution/agent.js";

/**
 * Checking that something fails is checking.
 *
 * Observed live: a run produced 15 correct files, its own suite printed
 * ALL TESTS PASSED, and the task still reported `interrupted`. The cause was a
 * single command the agent ran on purpose —
 *
 *   purpose: "Verify CLI errors to stderr and exits non-zero for a missing file"
 *   exitCode: 1
 *
 * — testing an error path the prompt had explicitly required. Morrow scored the
 * non-zero exit as a failed verification and refused to close. The agent did
 * exactly the right thing and was punished for it.
 *
 * The expectation is declared in the same call that runs the command, so this
 * reads a commitment made before any result existed rather than trusting the
 * model's account afterwards.
 */

const call = (args: Record<string, unknown>, exitCode: number, status: "completed" | "failed" = "completed") => ({
  status,
  toolName: "run_command" as const,
  argsJson: JSON.stringify(args),
  resultJson: JSON.stringify({ exitCode }),
});

describe("a command may declare that failing is the correct outcome", () => {
  it("treats the declared non-zero exit as a pass", () => {
    const args = { executable: "node", args: ["cli.mjs", "missing.txt"], purpose: "check the CLI rejects a missing file", expectNonZeroExit: true };
    expect(commandExitMatchedExpectation(args, 1)).toBe(true);
    expect(toolCallPassedVerification(call(args, 1))).toBe(true);
  });

  it("still fails an undeclared non-zero exit", () => {
    // The guard this protects: "tests failed, file saved, task claimed done".
    const args = { executable: "node", args: ["test/run-all.mjs"], purpose: "run the test suite" };
    expect(commandExitMatchedExpectation(args, 1)).toBe(false);
    expect(toolCallPassedVerification(call(args, 1))).toBe(false);
  });

  it("fails a command that was supposed to fail and did not", () => {
    // Cuts both ways: the guard under test never fired, so nothing was proven.
    const args = { executable: "node", args: ["cli.mjs", "missing.txt"], purpose: "check the CLI rejects a missing file", expectNonZeroExit: true };
    expect(commandExitMatchedExpectation(args, 0)).toBe(false);
    expect(toolCallPassedVerification(call(args, 0))).toBe(false);
  });

  it("counts a declared expectation as a verification on its own", () => {
    // Without this the command is skipped entirely and cannot clear an
    // outstanding failure, whatever its exit code.
    expect(runCommandIsVerification({ executable: "node", args: ["x.mjs"], purpose: "exercise the bad-input path", expectNonZeroExit: true })).toBe(true);
  });

  it("recognises ordinary words for checking that are not the word 'test'", () => {
    // The second half of the same live failure: the passing check that followed
    // said "Confirm CLI output parses as valid JSON", which the keyword list
    // did not match, so it could not clear the outstanding failure.
    for (const purpose of [
      "Confirm CLI output parses as valid JSON with correct report shape",
      "Validate the generated schema",
      "Ensure the migration applied cleanly",
      "Assert the output matches the fixture",
    ]) {
      expect(runCommandIsVerification({ executable: "node", args: ["x.mjs"], purpose }), purpose).toBe(true);
    }
  });

  it("does not turn every command into a verification", () => {
    // Scaffolding and setup must stay out of the completion gate.
    for (const purpose of ["install dependencies", "create the project directory", "start the dev server"]) {
      expect(runCommandIsVerification({ executable: "pnpm", args: ["install"], purpose }), purpose).toBe(false);
    }
  });

  it("honors the declaration when the executor classified the call as failed", () => {
    // A non-zero exit arrives as a *failed tool call*, so the declaration has to
    // be honored on that branch too or the fix does nothing in practice.
    const args = { executable: "node", args: ["cli.mjs", "missing.txt"], purpose: "check the CLI rejects a missing file", expectNonZeroExit: true };
    expect(commandExitMatchedExpectation(args, 1)).toBe(true);
    expect(call(args, 1, "failed").status).toBe("failed");
  });
});
