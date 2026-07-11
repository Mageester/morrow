import { describe, expect, it } from "vitest";
import { parseTaskReportArgs, resolveTaskReference } from "../src/terminal/task-reference.js";

const tasks = [
  { id: "abcd1111-full", status: "completed", createdAt: "2026-07-11T00:00:00.000Z" },
  { id: "abcd2222-full", status: "failed", createdAt: "2026-07-11T00:01:00.000Z" },
  { id: "unique-task", status: "running", createdAt: "2026-07-11T00:02:00.000Z" },
] as any;

describe("task report addressing", () => {
  it("parses report kind and optional task reference consistently", () => {
    expect(parseTaskReportArgs("")).toEqual({ kind: "summary" });
    expect(parseTaskReportArgs("unique")).toEqual({ kind: "summary", ref: "unique" });
    expect(parseTaskReportArgs("full unique")).toEqual({ kind: "full", ref: "unique" });
    expect(parseTaskReportArgs("failures abcd1111")).toEqual({ kind: "failures", ref: "abcd1111" });
  });

  it("resolves full ids and unique prefixes within the supplied project tasks", () => {
    expect(resolveTaskReference(tasks, "unique-task")).toEqual({ status: "resolved", id: "unique-task" });
    expect(resolveTaskReference(tasks, "unique")).toEqual({ status: "resolved", id: "unique-task" });
  });

  it("rejects ambiguous, unknown, and path-like references", () => {
    expect(resolveTaskReference(tasks, "abcd")).toMatchObject({ status: "ambiguous", count: 2 });
    expect(resolveTaskReference(tasks, "foreign")).toEqual({ status: "not-found", ref: "foreign" });
    expect(resolveTaskReference(tasks, "../providers")).toEqual({ status: "invalid", ref: "../providers" });
  });
});
