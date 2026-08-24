import { render } from "ink";
import { App } from "./app.js";
import { ApprovalStore } from "./approval-store.js";
import { approvalDecisionLabel, type ApprovalDecision } from "../approvals.js";
import { createDispatcher } from "./command-dispatch.js";
import { OverlayStore } from "./overlay-store.js";
import { TerminalStore } from "./store.js";
import { mapTaskEvent } from "../task-event-adapter.js";
import {
  builtinRegistry,
  skillCommands,
  type CommandContext,
  type CommandRegistry,
  type SessionInfo,
} from "../commands/index.js";
import { errorText } from "../commands/format.js";
import { editExternally } from "../external-editor.js";
import type { SendOptions, SessionBackend } from "../session-types.js";
import type { TerminalEvent } from "../events.js";

/**
 * The interactive shell driver.
 *
 * Owns the runtime loop — send, subscribe, adapt, reduce — and not a single
 * line of drawing. Ink owns the screen; this owns the session. That separation
 * is why the renderer was replaceable at all, and it is preserved deliberately.
 *
 * Raw task events are translated by the existing `mapTaskEvent` adapter, so the
 * shell consumes the same normalized `TerminalEvent`s every other surface does
 * and cannot invent a state the reducer doesn't know about. There is exactly
 * one execution path here: `backend.send` into the orchestrator. Commands
 * change settings and read state; they never run an agent loop of their own.
 */
export interface ShellOptions {
  backend: SessionBackend;
  sendOptions: SendOptions;
  session: SessionInfo;
  cwdLabel: string;
  unicode: boolean;
  onCompleteFile?: (prefix: string) => string[];
  /** Locally discovered skills, registered as `/skill:<id>` commands. */
  skills?: readonly { id: string; description: string }[];
  history?: readonly string[];
  onHistoryAppend?: (line: string) => void;
  /** Resumes a task already in flight when the shell starts. */
  initialTaskId?: string | null;
  /** Streams for the renderer. Injected only by tests — the same seam the
   *  previous session exposed as `TermIO`, and the reason the runtime loop can
   *  be exercised without a terminal. */
  io?: {
    stdout?: NodeJS.WriteStream;
    stdin?: NodeJS.ReadStream;
    stderr?: NodeJS.WriteStream;
  };
}

export interface ShellHandle {
  /** Resolves when the user exits the shell. */
  done: Promise<void>;
  stop: () => void;
  /** The assembled command surface, for tests and for `morrow --help`. */
  registry: CommandRegistry;
}

/** Keep Morrow's full-screen UI separate from the invoking shell's scrollback.
 * The alternate buffer is restored on every ordinary exit and around an
 * external editor, so clearing Morrow never destroys the user's shell history. */
export const ENTER_APPLICATION_SCREEN = "\x1b[?1049h\x1b[2J\x1b[H";
export const LEAVE_APPLICATION_SCREEN = "\x1b[?1049l";

export function startShell(options: ShellOptions): ShellHandle {
  const terminalOutput = options.io?.stdout ?? process.stdout;
  let applicationScreenActive = false;
  const enterApplicationScreen = () => {
    if (terminalOutput.isTTY !== true || applicationScreenActive) return;
    terminalOutput.write(ENTER_APPLICATION_SCREEN);
    applicationScreenActive = true;
  };
  const leaveApplicationScreen = () => {
    if (!applicationScreenActive) return;
    terminalOutput.write(LEAVE_APPLICATION_SCREEN);
    applicationScreenActive = false;
  };

  /**
   * Restore the terminal even when this process does not exit cleanly.
   *
   * The alternate buffer used to be left behind by anything that was not an
   * ordinary stop -- a crash, an unhandled rejection, a signal. A terminal
   * stranded in the alternate buffer has no scrollback, and its wheel sends
   * arrow keys to the foreground program, so scrolling up walks the user's
   * shell history instead of scrolling. That outlives Morrow: the damage is to
   * the invoking shell, and only `reset` or a manual `ESC[?1049l` clears it.
   *
   * `exit` covers ordinary and error exits and must stay synchronous, which a
   * TTY write is. Signals do not fire `exit` on their own, so they restore the
   * screen and then re-raise with the default disposition so exit codes stay
   * truthful. Errors are re-thrown rather than swallowed -- restoring the
   * screen must not turn a crash into a silent success.
   */
  const restoreScreenOnAbnormalExit = () => {
    if (terminalOutput.isTTY !== true) return () => {};
    const onExit = () => leaveApplicationScreen();
    const onSignal = (signal: NodeJS.Signals) => {
      leaveApplicationScreen();
      process.removeListener(signal, onSignal);
      process.kill(process.pid, signal);
    };
    const onFatal = (error: unknown) => {
      leaveApplicationScreen();
      throw error;
    };
    process.on("exit", onExit);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    process.on("uncaughtException", onFatal);
    process.on("unhandledRejection", onFatal);
    return () => {
      process.removeListener("exit", onExit);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGHUP", onSignal);
      process.removeListener("uncaughtException", onFatal);
      process.removeListener("unhandledRejection", onFatal);
    };
  };

  enterApplicationScreen();
  const releaseScreenGuards = restoreScreenOnAbnormalExit();

  const store = new TerminalStore();
  const approvals = new ApprovalStore();
  const overlays = new OverlayStore();
  let activeTask: { id: string; abort: AbortController } | null = null;
  let lastTaskId: string | null = options.initialTaskId ?? null;
  let stopShell = () => {};
  let clearTerminal = () => {};

  const emit = (event: TerminalEvent) => store.apply(event);

  const runTask = async (taskId: string) => {
    const abort = new AbortController();
    activeTask = { id: taskId, abort };
    lastTaskId = taskId;
    try {
      for await (const raw of options.backend.subscribe(taskId, abort.signal)) {
        // `approval.requested` is an input, not an observation — the adapter
        // deliberately does not map it. Without handling it here the turn waits
        // forever with nothing on screen, which is the worst thing this surface
        // can do.
        if (raw.type === "approval.requested") {
          // The runtime names this field `approvalId`. Reading `id` — as this
          // did — meant every approval resolved to null and was dropped on the
          // floor: the prompt never appeared, the keystroke answering it went
          // into the composer, and the task waited for a decision nobody could
          // see. `id` stays as a fallback rather than an assumption.
          const payload = raw.payload as
            { approvalId?: unknown; id?: unknown } | undefined;
          const raw_id = payload?.approvalId ?? payload?.id;
          const id = typeof raw_id === "string" ? raw_id : null;
          if (id) {
            try {
              approvals.set(await options.backend.getApproval(id));
            } catch (error) {
              emit({
                type: "notice",
                level: "error",
                text: `An approval could not be loaded: ${errorText(error)}`,
              });
            }
          } else {
            // Better a visible complaint than a session that hangs in silence.
            emit({
              type: "notice",
              level: "error",
              text: "Morrow needs an approval but did not say which one. Run /panic to cancel.",
            });
          }
          continue;
        }
        for (const event of mapTaskEvent(raw)) {
          // What ends "thinking" for a reader is the turn producing something:
          // the first token of an answer, or the tool call it decided to make.
          // The runtime has no view on that — it only knows what it emitted —
          // so the boundary is drawn here, once, rather than by every surface.
          //
          // Tool calls count. A reasoning-heavy model can run a whole task
          // without emitting a single token of text between calls, and settling
          // only on text left all of it accumulating in one live block that
          // never collapsed and never attached to the turn that thought it.
          if (
            (event.type === "assistant.delta" || event.type === "tool.start") &&
            store.state.reasoning &&
            store.state.reasoningMs === undefined
          ) {
            store.apply({ type: "reasoning.settled" });
          }
          store.apply(event);
        }
      }
    } catch (error) {
      // A dropped stream is reported rather than thrown away: the reducer
      // already models this, and silently ending a turn is the failure mode
      // that made the old shell feel broken.
      emit({
        type: "notice",
        level: "error",
        text: `The response stream ended unexpectedly: ${errorText(error)}`,
      });
    } finally {
      if (activeTask?.id === taskId) activeTask = null;
      // A message typed while the task ran is sent now, in order. It is a
      // normal user message on the same single execution path — never a
      // side-channel into the running task.
      const queued = store.state.queuedMessages[0];
      if (queued) {
        emit({ type: "redirect.sent" });
        emit({ type: "user.message", text: queued });
        void send(queued);
      }
    }
  };

  const send = (text: string) =>
    options.backend
      .send(text, options.sendOptions)
      .then((result) => {
        // The route the orchestrator actually resolved, straight from the send
        // response — not a guess assembled from settings. Without this nothing
        // ever emitted a `routing` event, so the status line had no model to
        // show and a session could not tell you what it was talking to.
        if (result.routing) emit({ type: "routing", ...result.routing });
        return runTask(result.taskId);
      })
      .catch((error: unknown) => {
        emit({
          type: "notice",
          level: "error",
          text: `Morrow could not accept that message: ${errorText(error)}`,
        });
      });

  const interrupt = (): boolean => {
    const current = activeTask;
    if (!current) return false;
    current.abort.abort();
    activeTask = null;
    emit({ type: "task.interrupted" });
    void options.backend.cancel(current.id).catch(() => {
      // Cancellation is best-effort from the client's side; the abort above
      // has already detached this shell from the stream.
    });
    return true;
  };

  const sendPrompt = (text: string) => {
    emit({ type: "user.message", text });
    void send(text);
  };

  const context: CommandContext = {
    settings: options.sendOptions,
    backend: options.backend,
    overlays,
    emit,
    session: options.session,
    registry: builtinRegistry(),
    exit: () => stopShell(),
    // Two halves, both required. The event empties the reducer's transcript;
    // Ink's own clear wipes what is already on the terminal. Settled turns are
    // written through <Static> straight into native scrollback, so without the
    // second half `/clear` left every previous turn on screen and only stopped
    // Morrow from redrawing it.
    clearScreen: () => {
      emit({ type: "session.cleared" });
      clearTerminal();
    },
    interrupt,
    lastTaskId: () => lastTaskId,
    activeTaskId: () => activeTask?.id ?? null,
    contextUsage: () => store.state.contextUsage ?? null,
    usage: () => store.state.usage ?? null,
    conversation: () => store.state.conversation,
  };

  const registry = context.registry.extend(
    skillCommands(options.skills ?? [], sendPrompt, (skillId) => {
      void options.backend.recordSkillUse?.(skillId).catch(() => {});
    }),
  );
  // `/help` must list the skills too, so the context points at the full surface.
  context.registry = registry;

  const dispatch = createDispatcher({ registry, context, emit });

  const submit = (text: string) => {
    if (text.startsWith("/")) {
      // A command is answered locally and never reaches the provider. Not
      // `user.message`: that event means "a backend task is starting", so it
      // would flip the shell to working and clear the previous turn.
      emit({ type: "command.entered", text });
      void dispatch(text).then((result) => {
        // A bare "/" is not a command; fall through so the input is not
        // silently swallowed.
        if (!result.handled) void send(text);
      });
      return;
    }
    // Typing during a running task is held, not merged into it and not
    // dropped. It goes as the next message when this one ends.
    if (activeTask) {
      emit({ type: "redirect.queued", text });
      return;
    }
    // Echo immediately. The user's own words must never wait on the network.
    emit({ type: "user.message", text });
    void send(text);
  };

  const decideApproval = (decision: ApprovalDecision) => {
    const pending = approvals.pending;
    if (!pending) return;
    approvals.set(null);
    // A command trust decision carries the pattern it applies to; anything else
    // is a bare decision.
    const details = pending.details as { pattern?: unknown };
    const trust =
      (decision === "trust_session" || decision === "trust_project") &&
      pending.kind === "command"
        ? String(details.pattern ?? "")
        : undefined;
    emit({
      type: "notice",
      level: decision === "deny" ? "warn" : "info",
      text: `${pending.kind === "command" ? "Command" : "Patch"} ${approvalDecisionLabel(decision)}.`,
    });
    void options.backend
      .resolveApproval(pending.id, decision, trust)
      .catch((error: unknown) => {
        emit({
          type: "notice",
          level: "error",
          text: `Approval failed: ${errorText(error)}`,
        });
      });
  };

  /**
   * Hand the terminal to an editor, then take it back.
   *
   * Ink holds stdin in raw mode and repaints on its own schedule, so the order
   * here is the whole trick: stop reading, drop raw mode, let the child own
   * the real TTY, then restore. `editExternally` uses `spawnSync`, which
   * blocks this loop, so Ink cannot paint a frame over an editor that is on
   * screen. Anything that goes wrong comes back as a notice — a failed edit
   * must never take the session down or silently discard a draft.
   */
  const composeExternally = (text: string): string | null => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw === true;
    try {
      leaveApplicationScreen();
      if (wasRaw && typeof stdin.setRawMode === "function")
        stdin.setRawMode(false);
      stdin.pause();
      const result = editExternally(text);
      if (result.error) {
        emit({
          type: "notice",
          level: "warn",
          text: `Could not edit that here: ${result.error}.`,
        });
        return null;
      }
      return result.text;
    } finally {
      stdin.resume();
      if (wasRaw && typeof stdin.setRawMode === "function")
        stdin.setRawMode(true);
      enterApplicationScreen();
      // The editor drew over the frame Ink believes is on screen, so the next
      // render has to start from a clean one rather than patching a screen
      // that is no longer there.
      clearTerminal();
    }
  };

  const instance = render(
    <App
      approvals={approvals}
      commands={registry.browseOrder}
      cwdLabel={options.cwdLabel}
      history={options.history}
      onApprovalDecision={decideApproval}
      onCompleteFile={options.onCompleteFile}
      onExit={() => stopShell()}
      onExternalEdit={composeExternally}
      onHistoryAppend={options.onHistoryAppend}
      onInterrupt={interrupt}
      onSubmit={submit}
      overlays={overlays}
      settings={options.sendOptions}
      store={store}
      unicode={options.unicode}
    />,
    {
      exitOnCtrlC: false,
      // Console patching stays on for a real terminal — a stray console.log
      // from anywhere in the process would otherwise tear the frame — but it
      // cannot run against a test runner's console shim.
      ...(options.io ? { patchConsole: false } : {}),
      ...(options.io?.stdout ? { stdout: options.io.stdout } : {}),
      ...(options.io?.stdin ? { stdin: options.io.stdin } : {}),
      ...(options.io?.stderr ? { stderr: options.io.stderr } : {}),
    },
  );

  const stop = () => {
    activeTask?.abort.abort();
    instance.unmount();
    leaveApplicationScreen();
    releaseScreenGuards();
  };
  stopShell = stop;
  clearTerminal = () => instance.clear();

  // A task already in flight when the shell opened is adopted rather than
  // orphaned — this is what makes `morrow` reattach to work started elsewhere
  // instead of showing an idle prompt while the agent is still running.
  //
  // Only if it is genuinely still running. The id comes from the conversation's
  // last message, which is usually a task that finished days ago; re-subscribing
  // to that one replays its ending, flips a fresh shell into "working", and then
  // reports it as stalled. A new session must open idle.
  if (options.initialTaskId) {
    const candidate = options.initialTaskId;
    void options.backend
      .getTask(candidate)
      .then((aggregate) => {
        const status = aggregate.task.status;
        if (status === "running" || status === "queued")
          void runTask(candidate);
      })
      .catch(() => {
        // An unreadable task is not a reason to fail the session; it just means
        // there is nothing to reattach to.
      });
  }

  return {
    done: instance.waitUntilExit().then(() => undefined),
    stop,
    registry,
  };
}
