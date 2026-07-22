export interface ChatDraftScope {
  projectId: string;
  conversationId?: string | undefined;
}

const DRAFT_PREFIX = "morrow.chat-draft.v1";

function draftKey(scope: ChatDraftScope): string {
  const conversation = scope.conversationId ?? "new";
  return `${DRAFT_PREFIX}.${encodeURIComponent(scope.projectId)}.${encodeURIComponent(conversation)}`;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function loadChatDraft(scope: ChatDraftScope): string {
  try {
    const raw = browserStorage()?.getItem(draftKey(scope));
    if (!raw) return "";
    const stored: unknown = JSON.parse(raw);
    if (
      typeof stored !== "object" ||
      stored === null ||
      !("version" in stored) ||
      stored.version !== 1 ||
      !("text" in stored) ||
      typeof stored.text !== "string"
    ) {
      return "";
    }
    return stored.text;
  } catch {
    return "";
  }
}

export function saveChatDraft(scope: ChatDraftScope, text: string): void {
  try {
    const storage = browserStorage();
    if (!storage) return;
    const key = draftKey(scope);
    if (!text) {
      storage.removeItem(key);
      return;
    }
    // Product requirement: user-authored draft text is retained locally.
    // Provider credentials and routing metadata must never enter this record.
    storage.setItem(key, JSON.stringify({ version: 1, text }));
  } catch {
    // Draft persistence is best-effort. Storage denial/corruption must not make
    // the composer unusable or discard the live textarea value.
  }
}

export function clearChatDraft(scope: ChatDraftScope): void {
  try {
    browserStorage()?.removeItem(draftKey(scope));
  } catch {
    // See saveChatDraft: the live editor remains authoritative if storage fails.
  }
}
