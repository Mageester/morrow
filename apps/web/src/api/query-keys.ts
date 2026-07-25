import {
  WebMissionSnapshotSchema,
  WebMissionSummarySchema,
} from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

export const missionKeys = {
  all: ["missions"] as const,
  list(projectId: string) {
    return [...this.all, "list", projectId] as const;
  },
  detail(missionId: string) {
    return [...this.all, "detail", missionId] as const;
  },
};

export const missionQueries = {
  list(projectId: string) {
    return queryOptions({
      queryKey: missionKeys.list(projectId),
      queryFn: () =>
        api.get(
          `/api/web/missions?projectId=${encodeURIComponent(projectId)}`,
          WebMissionSummarySchema.array(),
        ),
    });
  },
  detail(missionId: string) {
    return queryOptions({
      queryKey: missionKeys.detail(missionId),
      queryFn: () =>
        api.get(
          `/api/web/missions/${encodeURIComponent(missionId)}`,
          WebMissionSnapshotSchema,
        ),
    });
  },
};
