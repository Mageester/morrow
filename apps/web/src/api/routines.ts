import {
  RoutineRecordingStateSchema,
  RoutineSchema,
  type Routine,
  type RoutineRecordingState,
  type RoutineStep,
  type UpdateRoutineInput,
} from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

const recordingPath = (projectId: string, conversationId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/recording`;

const routinesPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/routines`;

export const routineKeys = {
  all: ["routines"] as const,
  list(projectId: string) {
    return [...this.all, "list", projectId] as const;
  },
  recording(projectId: string, conversationId: string) {
    return [...this.all, "recording", projectId, conversationId] as const;
  },
};

export const routineQueries = {
  list(projectId: string) {
    return queryOptions<Routine[]>({
      queryKey: routineKeys.list(projectId),
      queryFn: () => api.get(routinesPath(projectId), RoutineSchema.array()),
      enabled: Boolean(projectId),
    });
  },
  recording(projectId: string, conversationId: string) {
    return queryOptions<RoutineRecordingState>({
      queryKey: routineKeys.recording(projectId, conversationId),
      queryFn: () => api.get(recordingPath(projectId, conversationId), RoutineRecordingStateSchema),
      enabled: Boolean(projectId) && Boolean(conversationId),
    });
  },
};

const RoutineRunSchema = z.object({
  version: z.literal(1),
  routineId: z.string(),
  conversationId: z.string(),
  taskId: z.string(),
  projectId: z.string(),
});

export const routineApi = {
  startRecording(projectId: string, conversationId: string) {
    return api.post(recordingPath(projectId, conversationId), {}, RoutineRecordingStateSchema);
  },
  stopRecording(projectId: string, conversationId: string) {
    return api.deleteWithBody(recordingPath(projectId, conversationId), {}, RoutineRecordingStateSchema);
  },
  save(
    projectId: string,
    input: { name: string; objective: string; steps: RoutineStep[]; agentId: string | null; sourceConversationId?: string },
  ) {
    return api.post(routinesPath(projectId), input, RoutineSchema);
  },
  update(projectId: string, routineId: string, input: UpdateRoutineInput) {
    return api.patch(
      `${routinesPath(projectId)}/${encodeURIComponent(routineId)}`,
      input,
      RoutineSchema,
    );
  },
  run(routineId: string) {
    return api.post(`/api/routines/${encodeURIComponent(routineId)}/run`, {}, RoutineRunSchema);
  },
  remove(routineId: string, projectId: string) {
    return api.deleteWithBody(`/api/routines/${encodeURIComponent(routineId)}`, { projectId }, z.unknown());
  },
};
