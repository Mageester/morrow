import type { ChatComposerSubmission } from "../src/features/chat/chat-composer.js";
import { ChatComposer } from "../src/features/chat/chat-composer.js";
import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@morrow/ui/styles.css";
import "../src/styles/app.css";

type Outcome = "accept" | "reject" | "throw" | "delay-accept" | "delay-reject";

function ComposerHarness() {
  const [activeTaskId, setActiveTaskId] = useState<string | undefined>();
  const [conversationId, setConversationId] = useState("alpha");
  const [outcome, setOutcome] = useState<Outcome>("reject");
  const [payload, setPayload] = useState<ChatComposerSubmission | null>(null);
  const [pending, setPending] = useState(false);
  const [projectId, setProjectId] = useState("project-1");
  const resolvePending = useRef<((result: { accepted: boolean; error?: string }) => void) | null>(null);

  async function submit(submission: ChatComposerSubmission) {
    setPayload(submission);
    if (outcome === "throw") throw new Error("test rejection");
    if (outcome === "reject") return { accepted: false, error: "Harness rejected the message." };
    if (outcome === "accept") return { accepted: true };

    setPending(true);
    return new Promise<{ accepted: boolean; error?: string }>((resolve) => {
      resolvePending.current = resolve;
    });
  }

  function finishPending() {
    resolvePending.current?.(
      outcome === "delay-accept"
        ? { accepted: true }
        : { accepted: false, error: "Harness delayed rejection." },
    );
    resolvePending.current = null;
    setPending(false);
  }

  return (
    <main style={{ margin: "0 auto", maxWidth: 820, padding: "24px 16px" }}>
      <h1>Production chat composer harness</h1>
      <div aria-label="Harness controls" role="group">
        <button onClick={() => setConversationId("alpha")} type="button">Use alpha scope</button>
        <button onClick={() => setConversationId("beta")} type="button">Use beta scope</button>
        <button onClick={() => setActiveTaskId((value) => value ? undefined : "task-1")} type="button">
          Toggle active task
        </button>
        <label>
          Harness outcome
          <select onChange={(event) => setOutcome(event.target.value as Outcome)} value={outcome}>
            <option value="accept">Accept</option>
            <option value="reject">Reject</option>
            <option value="throw">Throw</option>
            <option value="delay-accept">Delay accept</option>
            <option value="delay-reject">Delay reject</option>
          </select>
        </label>
        <button disabled={!pending} onClick={finishPending} type="button">Resolve pending</button>
      </div>
      <p data-testid="scope">{projectId}:{conversationId}</p>
      <pre data-testid="payload">{payload ? JSON.stringify(payload) : "none"}</pre>
      <ChatComposer
        activeTaskId={activeTaskId}
        autoFocus
        draftScope={{ projectId, conversationId }}
        modelRoutes={[
          { id: "balanced", label: "Balanced route", preset: "balanced" },
          { id: "direct", label: "Direct model", providerId: "openrouter", model: "vendor/model-a" },
        ]}
        onProjectChange={setProjectId}
        onStop={async () => { setActiveTaskId(undefined); }}
        onSubmit={submit}
        projectId={projectId}
        projects={[
          { id: "project-1", name: "First project" },
          { id: "project-2", name: "Second project" },
        ]}
      />
    </main>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Composer harness root was not found.");
createRoot(root).render(<StrictMode><ComposerHarness /></StrictMode>);
