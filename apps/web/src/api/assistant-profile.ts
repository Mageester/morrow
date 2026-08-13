import { AssistantProfileSchema } from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

export const assistantProfileQueries = {
  get() {
    return queryOptions({
      queryKey: ["assistant-profile"] as const,
      queryFn: () => api.get("/api/assistant-profile", AssistantProfileSchema),
    });
  },
};

export const assistantProfileApi = {
  update(input: {
    displayName?: string | null;
    assistantName?: string | null;
    commsVerbosity?: "concise" | "detailed";
    commsTone?: "technical" | "nontechnical";
    timezone?: string | null;
    locale?: string | null;
    defaultPrivacyMode?: "local_only" | "controlled_cloud" | "custom";
    defaultApprovalPosture?: "ask_always" | "trust_reads" | "trust_project";
  }) {
    return api.patch("/api/assistant-profile", input, AssistantProfileSchema);
  },
  addGoal(text: string) {
    return api.post("/api/assistant-profile/goals", { text }, AssistantProfileSchema);
  },
  setGoalEnabled(goalId: string, enabled: boolean) {
    return api.patch(`/api/assistant-profile/goals/${encodeURIComponent(goalId)}`, { enabled }, AssistantProfileSchema);
  },
};
