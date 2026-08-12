import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { api } from "./client.js";

export const OnboardingStateSchema = z.object({
  onboarded: z.boolean(),
  onboardingStep: z.string().nullable(),
  useCase: z.string().nullable(),
  name: z.string().nullable(),
}).strict();

const OnboardingUpdateResultSchema = z.object({ success: z.literal(true) }).strict();

export type OnboardingState = z.infer<typeof OnboardingStateSchema>;

export interface OnboardingUpdate {
  onboarded?: boolean;
  onboardingStep?: string | null;
  useCase?: string | null;
  name?: string | null;
}

export const onboardingKeys = {
  state: ["onboarding"] as const,
};

export const onboardingQueries = {
  state(enabled = true) {
    return queryOptions({
      queryKey: onboardingKeys.state,
      queryFn: () => api.get("/api/onboarding", OnboardingStateSchema),
      enabled,
      staleTime: Number.POSITIVE_INFINITY,
    });
  },
};

export const onboardingApi = {
  update(input: OnboardingUpdate) {
    return api.post("/api/onboarding", input, OnboardingUpdateResultSchema);
  },
};
