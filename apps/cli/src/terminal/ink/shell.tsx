import { render } from "ink";
import { App } from "./app.js";
import { ApprovalStore } from "./approval-store.js";
import { approvalDecisionLabel, type ApprovalDecision } from "../approvals.js";
import { TerminalStore } from "./store.js";
import { mapTaskEvent } from "../task-event-adapter.js";
import type { SendOptions, SessionBackend } from "../session.js";
import type { SlashCommand } from "../commands.js";

/**
 * The interactive shell driver.
 *
 * Owns the loop the old `InteractiveSession` owned — send, subscribe, adapt,
 * reduce — but not a single line of drawing. Ink owns the screen; this owns the
 * runtime. That separation is the whole reason the previous renderer was
 * replaceable at all, and it is preserved deliberately.
 *
 * Raw task events are translated by the existing `mapTaskEvent` adapter, so the
 * shell consumes the same normalized `TerminalEvent`s every other surface does
 * and cannot invent a state the reducer doesn't know about.
 */
export interface ShellOptions {
  backend: SessionBackend;
  sendOptions: SendOptions;
  commands: readonly SlashCommand[];
  cwdLabel: string;
  unicode: boolean;
  onCompleteFile?: (prefix: string) => string[];
}

export interface ShellHandle {
  /** Resolves when the user exits the shell. */
  done: Promise<void>;
  stop: () => void;
}

export function startShell(options: ShellOptions): ShellHandle {
  const store = new TerminalStore();
  const approvals = new ApprovalStore();
  let activeTask: { id: string; abort: AbortController } | null = null;

  const runTask = async (taskId: string) => {
    const abort = new AbortController();
    activeTask = { id: taskId, abort };
    try {
      for await (const raw of options.backend.subscribe(taskId, abort.signal)) {
        // `approval.requested` is an input, not an observation — the adapter
        // deliberately does not map it. Without handling it here the turn waits
        // forever with nothing on screen, which is the worst thing this surface
        // can do.
        if (raw.type === "approval.requested") {
          const id = typeof raw.payload?.id === "string" ? raw.payload.id : null;
          if (id) {
            try {
              approvals.set(await options.backend.getApproval(id));
            } catch (error) {
              store.apply({
                type: "notice",
                level: "error",
                text: error instanceof Error ? error.message : "An approval could not be loaded.",
              });
            }
          }
          continue;
        }
        for (const event of mapTaskEvent(raw)) store.apply(event);
      }
    } catch (error) {
      // A dropped stream is reported as a notice rather than thrown away: the
      // reducer already models this, and silently ending a turn is the failure
      // mode that made the old shell feel broken.
      store.apply({
        type: "notice",
        level: "error",
        text: error instanceof Error ? error.message : "The response stream ended unexpectedly.",
      });
    } finally {
      if (activeTask?.id === taskId) activeTask = null;
    }
  };

  const submit = (text: string) => {
    // Echo immediately. The user's own words must never wait on the network —
    // that latency is what made the previous shell feel unresponsive.
    store.apply({ type: "user.message", text });
    void options.backend
      .send(text, options.sendOptions)
      .then((result) => runTask(result.taskId))
      .catch((error: unknown) => {
        store.apply({
          type: "notice",
          level: "error",
          text: error instanceof Error ? error.message : "Morrow could not accept that message.",
        });
      });
  };

  const decideApproval = (decision: ApprovalDecision) => {
    const pending = approvals.pending;
    if (!pending) return;
    approvals.set(null);
    // A command trust decision carries the pattern it applies to; anything else
    // is a bare decision. Mirrors the legacy path exactly.
    const details = pending.details as { pattern?: unknown };
    const trust =
      (decision === "trust_session" || decision === "trust_project") && pending.kind === "command"
        ? String(details.pattern ?? "")
        : undefined;
    store.apply({
      type: "notice",
      level: decision === "deny" ? "warn" : "info",
      text: `${pending.kind === "command" ? "Command" : "Patch"} ${approvalDecisionLabel(decision)}.`,
    });
    void options.backend.resolveApproval(pending.id, decision, trust).catch((error: unknown) => {
      store.apply({
        type: "notice",
        level: "error",
        text: `Approval failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
  };

  const interrupt = () => {
    const current = activeTask;
    if (!current) return;
    current.abort.abort();
    void options.backend.cancel(current.id).catch(() => {
      // Cancellation is best-effort from the client's side; the abort above
      // has already detached this shell from the stream.
    });
  };

  const instance = render(
    <App
      approvals={approvals}
      commands={options.commands}
      onApprovalDecision={decideApproval}
      cwdLabel={options.cwdLabel}
      onCompleteFile={options.onCompleteFile}
      onInterrupt={interrupt}
      onSubmit={submit}
      store={store}
      unicode={options.unicode}
    />,
    { exitOnCtrlC: false },
  );

  return {
    done: instance.waitUntilExit().then(() => undefined),
    stop: () => {
      activeTask?.abort.abort();
      instance.unmount();
    },
  };
}
