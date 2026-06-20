import type { Project, Task, TaskEvent, TaskEvidence, PlanStep, ExecutionDisclosure, VerificationResult, CreateProjectSchema } from "@morrow/contracts";
import { z } from "zod";

const BASE_URL = "http://127.0.0.1:4317";

export const apiClient = {
  async listProjects(): Promise<Project[]> {
    const res = await fetch(`${BASE_URL}/api/projects`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async createProject(name: string, workspacePath: string): Promise<Project> {
    const res = await fetch(`${BASE_URL}/api/projects`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, workspacePath }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || "Failed to create project");
    }
    return res.json();
  },

  async listProjectTasks(projectId: string): Promise<Task[]> {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/tasks`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async startInspectWorkspace(projectId: string): Promise<{ taskId: string }> {
    const res = await fetch(`${BASE_URL}/api/projects/${projectId}/tasks/inspect-workspace`, {
      method: "POST",
    });
    if (!res.ok) {
      const err = await res.json().catch(() => null);
      throw new Error(err?.error?.message || "Failed to start inspection");
    }
    return res.json();
  },

  async getTaskAggregate(taskId: string): Promise<{ task: Task; plan: PlanStep[]; events: TaskEvent[]; evidence: TaskEvidence[]; disclosure?: ExecutionDisclosure; verification?: VerificationResult }> {
    const res = await fetch(`${BASE_URL}/api/tasks/${taskId}`);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async getEventHistory(taskId: string, after?: number): Promise<TaskEvent[]> {
    const url = new URL(`${BASE_URL}/api/tasks/${taskId}/events`);
    if (after !== undefined) url.searchParams.set("after", after.toString());
    const res = await fetch(url);
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  subscribeToTaskEvents(taskId: string, lastEventId: number, onEvent: (event: TaskEvent) => void, onComplete: () => void): () => void {
    const url = `${BASE_URL}/api/tasks/${taskId}/events/stream?after=${lastEventId}`;
    const eventSource = new EventSource(url);
    
    const handler = (e: MessageEvent) => {
      const event: TaskEvent = JSON.parse(e.data);
      onEvent(event);
      if (["task.verified", "task.failed", "task.interrupted"].includes(event.type)) {
        eventSource.close();
        onComplete();
      }
    };

    eventSource.onmessage = handler;
    eventSource.onerror = () => {
      eventSource.close();
      onComplete(); // fallback/retry handled outside
    };

    return () => eventSource.close();
  }
};
