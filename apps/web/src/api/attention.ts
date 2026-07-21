import {
  ResolveWebAttentionSchema,
  WebMissionSnapshotSchema,
  type ResolveWebAttentionInput,
  type WebMissionSnapshot,
} from "@morrow/contracts";
import { ApiClientError, api } from "./client.js";

function belongsToMission(
  snapshot: WebMissionSnapshot,
  missionId: string,
): boolean {
  return (
    snapshot.summary.id === missionId &&
    snapshot.attention.every((item) => item.missionId === missionId) &&
    snapshot.artifacts.every((item) => item.missionId === missionId) &&
    snapshot.recentActivity.every((item) => item.missionId === missionId)
  );
}

export async function resolveMissionAttention(
  missionId: string,
  attentionId: string,
  input: ResolveWebAttentionInput,
): Promise<WebMissionSnapshot> {
  const body = ResolveWebAttentionSchema.parse(input);
  const snapshot = await api.post(
    `/api/web/missions/${encodeURIComponent(missionId)}/attention/${encodeURIComponent(attentionId)}/resolve`,
    body,
    WebMissionSnapshotSchema,
  );

  if (!belongsToMission(snapshot, missionId)) {
    throw new ApiClientError(
      409,
      "MISSION_RESPONSE_MISMATCH",
      "The response did not match the mission being updated.",
      null,
    );
  }

  return snapshot;
}
