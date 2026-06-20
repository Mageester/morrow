import type { Project, Task, TaskEvent, TaskEvidence, PlanStep, ExecutionDisclosure, VerificationResult } from "@morrow/contracts";

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "";

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
    let eventSource: EventSource | null = null;
    let highestSequence = lastEventId;
    let isClosed = false;

    const connect = () => {
      if (isClosed) return;
      const url = `${BASE_URL}/api/tasks/${taskId}/events/stream?after=${highestSequence}`;
      eventSource = new EventSource(url);
      
      const handler = (e: MessageEvent) => {
        const event: TaskEvent = JSON.parse(e.data);
        if (event.sequence <= highestSequence) return;
        highestSequence = event.sequence;
        onEvent(event);
        if (["task.verified", "task.failed", "task.interrupted"].includes(event.type)) {
          isClosed = true;
          eventSource?.close();
          onComplete();
        }
      };

      const eventTypes = ["task.created", "plan.created", "step.started", "step.completed", "workspace.inspected", "evidence.persisted", "verification.completed", "task.running", "task.verified", "task.failed", "task.interrupted"];
      eventTypes.forEach(type => {
        eventSource!.addEventListener(type, handler);
      });

      // Also listen to un-named messages just in case
      eventSource!.onmessage = handler;

      eventSource!.onerror = () => {
        eventSource?.close();
        if (!isClosed) {
          // Attempt native reconnect via timeout
          setTimeout(connect, 1000);
        }
      };
    };

    connect();

    return () => {
      isClosed = true;
      eventSource?.close();
    };
  }
};
