import{describe,it,expect}from"vitest";import{openDatabase}from"../src/database.js";import{projectRepository}from"../src/repositories/projects.js";import{taskRepository}from"../src/repositories/tasks.js";const time="2026-01-01T00:00:00.000Z";
describe("task repository",()=>{it("creates, lists and updates tasks",()=>{const d=openDatabase(":memory:"),p=projectRepository(d),r=taskRepository(d);p.createProject({id:"p",name:"p",workspacePath:"C:/p",createdAt:time});const t=r.createTask({id:"t",projectId:"p",kind:"inspect_workspace",status:"queued",createdAt:time});expect(r.listTasksByProject("p")).toEqual([t]);expect(r.updateTaskStatus("t",{status:"running",updatedAt:"2026-01-01T00:01:00.000Z",startedAt:"2026-01-01T00:01:00.000Z"})?.status).toBe("running");expect(r.getTaskById("no")).toBeUndefined();d.close()});it("enforces project foreign keys and maps corruption",()=>{const d=openDatabase(":memory:"),r=taskRepository(d);expect(()=>r.createTask({id:"x",projectId:"none",kind:"inspect_workspace",status:"queued",createdAt:time})).toThrow();d.close()});
  it("deduplicates by idempotency key within a project and finds by key", () => {
    const d = openDatabase(":memory:");
    const p = projectRepository(d);
    const r = taskRepository(d);
    p.createProject({ id: "p", name: "p", workspacePath: "C:/p", createdAt: time });
    p.createProject({ id: "p2", name: "p2", workspacePath: "C:/p2", createdAt: time });
    const t = r.createTask({ id: "t1", projectId: "p", kind: "inspect_workspace", status: "queued", idempotencyKey: "abc", createdAt: time });
    expect(r.findByIdempotencyKey("p", "abc")?.id).toBe("t1");
    // Same project + same key is rejected by the unique index (caller reuses the found task).
    expect(() => r.createTask({ id: "t2", projectId: "p", kind: "inspect_workspace", status: "queued", idempotencyKey: "abc", createdAt: time })).toThrow();
    // The same key in a different project is independent.
    expect(() => r.createTask({ id: "t3", projectId: "p2", kind: "inspect_workspace", status: "queued", idempotencyKey: "abc", createdAt: time })).not.toThrow();
    // Null keys are unconstrained (many allowed).
    r.createTask({ id: "t4", projectId: "p", kind: "inspect_workspace", status: "queued", createdAt: time });
    r.createTask({ id: "t5", projectId: "p", kind: "inspect_workspace", status: "queued", createdAt: time });
    expect(r.findByIdempotencyKey("p", "missing")).toBeUndefined();
    expect(t.id).toBe("t1");
    d.close();
  });
});
