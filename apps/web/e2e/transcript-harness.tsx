/**
 * Renders one realistic assistant turn — narration interleaved with tool work —
 * outside the app, so the transcript's reading flow can be looked at directly.
 */
import type { WebConversationActivityEntry, WebConversationMessage } from "@morrow/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConversationMessageItem } from "../src/features/chat/conversation-page.js";
import "@morrow/ui/styles.css";
import "../src/styles/app.css";
import "../src/styles/premium/index.css";

const TASK = "task-harness";
let sequence = 0;
const base = Date.parse("2026-08-25T10:00:00.000Z");

function at(offsetSeconds: number): string {
  return new Date(base + offsetSeconds * 1000).toISOString();
}

function entry(partial: Partial<WebConversationActivityEntry> & { kind: WebConversationActivityEntry["kind"]; summary: string }): WebConversationActivityEntry {
  sequence += 1;
  return {
    version: 1,
    id: `${TASK}:${sequence}`,
    taskId: TASK,
    sequence,
    status: "completed",
    detail: null,
    target: null,
    text: null,
    toolName: null,
    durationMs: null,
    exitCode: null,
    resultCount: null,
    evidenceRef: null,
    createdAt: at(sequence * 3),
    updatedAt: at(sequence * 3 + 2),
    ...partial,
  };
}

const answer = `I traced the retry budget drift and fixed it.

**What was wrong:** \`policy.ts\` resolved \`retryBudget\` from config, but \`agent.ts\` recomputed its own ceiling from \`maxAttempts\` and never read the policy. Raising the configured budget therefore changed nothing at the only place it mattered.

**What changed:**
- \`src/execution/agent.ts\` now asks the policy for the ceiling instead of deriving one.
- \`test/retry-budget.test.ts\` gains a case that fails if the two ever diverge again.

Tests pass (\`pnpm test retry-budget\`, 8.4s).`;

const entries: WebConversationActivityEntry[] = [
  entry({
    kind: "narration",
    summary: "Assistant message",
    text: "I'll start by finding where the retry budget is actually enforced — the config value and the call site can drift apart, so I want both.",
  }),
  entry({ kind: "search", summary: "Searched for retryBudget", toolName: "search_text", target: "retryBudget", resultCount: 14, durationMs: 420, evidenceRef: "ev-1" }),
  entry({ kind: "tool", summary: "Read execution/policy.ts", toolName: "read_file", target: "src/execution/policy.ts", durationMs: 90, evidenceRef: "ev-2" }),
  entry({ kind: "tool", summary: "Read execution/agent.ts", toolName: "read_file", target: "src/execution/agent.ts", durationMs: 110, evidenceRef: "ev-3" }),
  entry({ kind: "tool", summary: "Read config/defaults.ts", toolName: "read_file", target: "src/config/defaults.ts", durationMs: 70, evidenceRef: "ev-4" }),
  entry({
    kind: "narration",
    summary: "Assistant message",
    text: "Found it. `policy.ts` reads `retryBudget` from the resolved config, but `agent.ts` re-derives its own ceiling from `maxAttempts` and never consults the policy. That's the drift.\n\nThe fix is to make `agent.ts` ask the policy rather than recompute. Let me check the tests that cover this first.",
  }),
  entry({ kind: "search", summary: "Searched for maxAttempts", toolName: "search_text", target: "maxAttempts", resultCount: 6, durationMs: 380, evidenceRef: "ev-5" }),
  entry({ kind: "tool", summary: "Read test/retry-budget.test.ts", toolName: "read_file", target: "test/retry-budget.test.ts", durationMs: 85, evidenceRef: "ev-6" }),
  entry({ kind: "provider", summary: "Route fallback used", detail: "Primary provider returned 429; the request completed on the fallback route." }),
  entry({
    kind: "narration",
    summary: "Assistant message",
    text: "The test asserts the ceiling through `agent.ts`, so it passes today and would keep passing after the fix. I'll change the call site and add a case that pins the two together.",
  }),
  entry({ kind: "diff", summary: "Edited execution/agent.ts", toolName: "propose_patch", target: "src/execution/agent.ts", durationMs: 210, evidenceRef: "ev-7" }),
  entry({ kind: "diff", summary: "Edited test/retry-budget.test.ts", toolName: "propose_patch", target: "test/retry-budget.test.ts", durationMs: 180, evidenceRef: "ev-8" }),
  entry({ kind: "command", summary: "Ran pnpm test retry-budget", toolName: "run_command", target: "pnpm test retry-budget", durationMs: 8400, exitCode: 0, evidenceRef: "ev-9" }),
  // The final turn. In the real runtime this is the same text the message body
  // settles to, which is why the body is not rendered alongside the timeline.
  entry({ kind: "narration", summary: "Assistant message", text: answer }),
];

const userMessage: WebConversationMessage = {
  version: 1,
  id: "m-user",
  conversationId: "c-harness",
  role: "user",
  content: "The retry budget setting doesn't seem to do anything — can you find out why?",
  taskId: null,
  streamingState: "completed",
  taskStatus: null,
  routing: null,
  toolActivity: [],
  provider: null,
  model: null,
  createdAt: at(0),
  updatedAt: at(0),
};

const assistantMessage: WebConversationMessage = {
  version: 1,
  id: "m-assistant",
  conversationId: "c-harness",
  role: "assistant",
  content: answer,
  taskId: TASK,
  streamingState: "completed",
  taskStatus: "completed",
  routing: {
    version: 1,
    presetId: "balanced",
    providerId: "anthropic",
    model: "claude-opus-5",
    fallbackUsed: true,
    overridden: false,
    mode: "agent",
    autoApprove: false,
    privacyMode: "controlled_cloud",
  },
  toolActivity: [],
  provider: "anthropic",
  model: "claude-opus-5",
  createdAt: at(4),
  updatedAt: at(60),
};

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function Harness() {
  return (
    <QueryClientProvider client={client}>
      <div className="morrow-conversation" style={{ padding: "2rem 1rem", maxWidth: "56rem", margin: "0 auto" }}>
        <div className="morrow-conversation__messages">
          <ConversationMessageItem
            actionBusy={false}
            conversationId="c-harness"
            entries={[]}
            message={userMessage}
            onOpenActivity={() => {}}
            onRetry={() => {}}
            projectId="p-harness"
            showReasoning={false}
          />
          <ConversationMessageItem
            actionBusy={false}
            conversationId="c-harness"
            entries={entries}
            message={assistantMessage}
            onOpenActivity={() => {}}
            onRetry={() => {}}
            projectId="p-harness"
            showReasoning={false}
          />
        </div>
      </div>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
