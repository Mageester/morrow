import {
  ConversationParticipantSchema,
  ConversationParticipantsSchema,
  type ConversationParticipant,
} from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

const participantPath = (projectId: string, conversationId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/participants`;

export const conversationParticipantKeys = {
  all: ["conversation-participants"] as const,
  detail(projectId: string, conversationId: string, includeRemoved = false) {
    return [...this.all, projectId, conversationId, includeRemoved] as const;
  },
};

export const conversationParticipantQueries = {
  detail(projectId: string, conversationId: string, includeRemoved = false) {
    return queryOptions({
      queryKey: conversationParticipantKeys.detail(projectId, conversationId, includeRemoved),
      queryFn: () => conversationParticipantApi.list(projectId, conversationId, includeRemoved),
      enabled: Boolean(projectId) && Boolean(conversationId),
    });
  },
};

export const conversationParticipantApi = {
  list(projectId: string, conversationId: string, includeRemoved = false) {
    const query = includeRemoved ? "?includeRemoved=true" : "";
    return api.get(`${participantPath(projectId, conversationId)}${query}`, ConversationParticipantsSchema);
  },

  invite(projectId: string, conversationId: string, agentId: string) {
    return api.post(
      participantPath(projectId, conversationId),
      { agentId },
      ConversationParticipantSchema,
    );
  },

  reorder(projectId: string, conversationId: string, agentId: string, position: number) {
    return api.patch(
      `${participantPath(projectId, conversationId)}/${encodeURIComponent(agentId)}`,
      { position },
      ConversationParticipantSchema,
    );
  },

  remove(projectId: string, conversationId: string, agentId: string): Promise<ConversationParticipant> {
    return api.delete(
      `${participantPath(projectId, conversationId)}/${encodeURIComponent(agentId)}`,
      ConversationParticipantSchema,
    );
  },
};
