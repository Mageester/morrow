import { describe, expect, it } from "vitest";
import { CreateProjectSchema, CreateTaskSchema, TaskEventSchema } from "../src/index.js";

describe("contracts", () => {
  it("rejects a project without a workspace path", () => expect(() => CreateProjectSchema.parse({ name: "x" })).toThrow());
  it("allows only inspect_workspace tasks", () => expect(() => CreateTaskSchema.parse({ projectId: "p", kind: "shell" })).toThrow());
  it("requires a numeric ordered event sequence", () => expect(() => TaskEventSchema.parse({ id:"e", taskId:"t", sequence:"1", type:"task.created", createdAt:"x", payload:{} })).toThrow());
});
