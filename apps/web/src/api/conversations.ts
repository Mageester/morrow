import {
  ConversationSchema,
  ConversationTaskActionResultSchema,
  DeleteConversationResultSchema,
  WebSendMessageResultSchema,
  WebConversationMessageSchema,
  type SendMessageInput,
  type WebConversationRouting,
  type WebSendMessageResult,
  type WebConversationMessage,
} from "@morrow/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "./client.js";

const projectPath = (projectId: string) =>
  `/api/projects/${encodeURIComponent(projectId)}/conversations`;

const conversationPath = (projectId: string, conversationId: string) =>
  `${projectPath(projectId)}/${encodeURIComponent(conversationId)}`;

export const conversationKeys = {
  all: ["conversations"] as const,
  list(projectId: string, includeArchived = false) {
    return [...this.all, "list", projectId, includeArchived] as const;
  },
  detail(projectId: string, conversationId: string) {
    return [...this.all, "detail", projectId, conversationId] as const;
  },
  messages(projectId: string, conversationId: string) {
    return [...this.all, "messages", projectId, conversationId] as const;
  },
};

export const conversationQueries = {
  list(projectId: string, includeArchived = false) {
    return queryOptions({
      queryKey: conversationKeys.list(projectId, includeArchived),
      queryFn: () => conversationApi.list(projectId, includeArchived),
    });
  },
  detail(projectId: string, conversationId: string) {
    return queryOptions({
      queryKey: conversationKeys.detail(projectId, conversationId),
      queryFn: () => conversationApi.get(projectId, conversationId),
    });
  },
  messages(projectId: string, conversationId: string) {
    return queryOptions({
      queryKey: conversationKeys.messages(projectId, conversationId),
      queryFn: () => conversationApi.messages(projectId, conversationId),
    });
  },
};

async function retryTransport<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return operation();
  }
}

export function pendingWebMessage(
  message: WebSendMessageResult["userMessage"] | WebSendMessageResult["assistantMessage"],
  taskStatus: WebConversationMessage["taskStatus"],
  routing: WebConversationRouting | null,
): WebConversationMessage {
  return WebConversationMessageSchema.parse({
    ...message,
    taskStatus,
    routing,
    toolActivity: [],
  });
}

export const conversationApi = {
  create(projectId: string, title?: string) {
    return api.post(projectPath(projectId), title ? { title } : {}, ConversationSchema);
  },

  list(projectId: string, includeArchived = false) {
    const suffix = includeArchived ? "?includeArchived=true" : "";
    return api.get(`${projectPath(projectId)}${suffix}`, ConversationSchema.array());
  },

  get(projectId: string, conversationId: string) {
    return api.get(conversationPath(projectId, conversationId), ConversationSchema);
  },

  messages(projectId: string, conversationId: string) {
    return api.get(
      `${conversationPath(projectId, conversationId)}/messages`,
      WebConversationMessageSchema.array(),
    );
  },

  update(projectId: string, conversationId: string, patch: { title?: string; archived?: boolean }) {
    return api.patch(conversationPath(projectId, conversationId), patch, ConversationSchema);
  },

  delete(projectId: string, conversationId: string) {
    return api.deleteWithBody(
      conversationPath(projectId, conversationId),
      { confirmation: "delete" as const },
      DeleteConversationResultSchema,
    );
  },

  sendMessage(
    projectId: string,
    conversationId: string,
    input: Omit<SendMessageInput, "idempotencyKey">,
  ) {
    const idempotencyKey = crypto.randomUUID();
    const payload = { ...input, idempotencyKey };
    return retryTransport(() => api.post(
      `${conversationPath(projectId, conversationId)}/messages`,
      payload,
      WebSendMessageResultSchema,
    ));
  },

  cancel(projectId: string, conversationId: string, taskId: string) {
    return api.post(
      `${conversationPath(projectId, conversationId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
      {},
      ConversationTaskActionResultSchema,
    );
  },

  retry(projectId: string, conversationId: string, taskId: string) {
    return api.post(
      `${conversationPath(projectId, conversationId)}/tasks/${encodeURIComponent(taskId)}/retry`,
      {},
      ConversationTaskActionResultSchema,
    );
  },
};
