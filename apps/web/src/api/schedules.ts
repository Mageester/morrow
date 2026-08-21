import {
  CreateScheduleSchema,
  ScheduleRunSchema,
  ScheduleSchema,
  ScheduleNotificationOptionsSchema,
  UpdateScheduleSchema,
  type Schedule,
  type ScheduleRun,
} from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

const scheduleListSchema = ScheduleSchema.array();
const scheduleRunListSchema = ScheduleRunSchema.array();
const scheduleNotificationOptionsSchema = ScheduleNotificationOptionsSchema;
const scheduleActionSchema = z.object({
  version: z.literal(1),
  scheduleId: z.string(),
  runId: z.string().optional(),
  taskId: z.string(),
  conversationId: z.string().optional(),
  projectId: z.string(),
  aggregateUrl: z.string().optional(),
});

const schedulesPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/schedules`;

export const scheduleKeys = {
  all: ["schedules"] as const,
  list(projectId: string) { return [...this.all, "list", projectId] as const; },
  notificationOptions(projectId: string) { return [...this.all, "notification-options", projectId] as const; },
  runs(projectId: string, scheduleId: string) { return [...this.all, "runs", projectId, scheduleId] as const; },
};

export const scheduleQueries = {
  list(projectId: string) {
    return queryOptions<Schedule[]>({
      queryKey: scheduleKeys.list(projectId),
      queryFn: () => api.get(schedulesPath(projectId), scheduleListSchema),
      enabled: Boolean(projectId),
    });
  },
  notificationOptions(projectId: string) {
    return queryOptions({
      queryKey: scheduleKeys.notificationOptions(projectId),
      queryFn: () => api.get(`/api/projects/${encodeURIComponent(projectId)}/schedule-notification-options`, scheduleNotificationOptionsSchema),
      enabled: Boolean(projectId),
    });
  },
  runs(projectId: string, scheduleId: string) {
    return queryOptions<ScheduleRun[]>({
      queryKey: scheduleKeys.runs(projectId, scheduleId),
      queryFn: () => api.get(`${schedulesPath(projectId)}/${encodeURIComponent(scheduleId)}/runs`, scheduleRunListSchema),
      enabled: Boolean(projectId) && Boolean(scheduleId),
    });
  },
};

export const scheduleApi = {
  create(projectId: string, input: z.input<typeof CreateScheduleSchema>) {
    return api.post(schedulesPath(projectId), CreateScheduleSchema.parse(input), ScheduleSchema);
  },
  update(projectId: string, scheduleId: string, input: z.input<typeof UpdateScheduleSchema>) {
    return api.patch(`${schedulesPath(projectId)}/${encodeURIComponent(scheduleId)}`, input, ScheduleSchema);
  },
  pause(scheduleId: string, projectId: string) {
    return api.post(`/api/schedules/${encodeURIComponent(scheduleId)}/pause`, { projectId }, ScheduleSchema);
  },
  resume(scheduleId: string, projectId: string) {
    return api.post(`/api/schedules/${encodeURIComponent(scheduleId)}/resume`, { projectId }, ScheduleSchema);
  },
  run(scheduleId: string, projectId: string) {
    return api.post(`/api/schedules/${encodeURIComponent(scheduleId)}/run`, { projectId }, scheduleActionSchema);
  },
  remove(scheduleId: string, projectId: string) {
    return api.deleteWithBody(`/api/schedules/${encodeURIComponent(scheduleId)}`, { projectId }, z.unknown());
  },
};
