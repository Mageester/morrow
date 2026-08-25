import type { WebProcess } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Loader2, Square, Terminal } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { processApi, processKeys, processQueries } from "../../api/processes.js";

/**
 * The background jobs this project has running, above the composer.
 *
 * Morrow could already start a dev server — `run_command background:true`,
 * supervised durably, output captured, terminable. What it could not do was
 * tell you. The process was real and running on your machine and there was no
 * surface in the browser that admitted it existed, so "the agent started your
 * dev server" and "you can open your dev server" were different claims.
 *
 * This is the smaller of the two things that fixes: the moment a job matters
 * is the moment it starts, and that happens here, in the conversation. It
 * shows only what is genuinely live — a finished job is history and belongs in
 * the record, not in a dock above the thing you are typing into.
 */

export interface ProcessDockProps {
  projectId: string;
}

/** "2m 14s" — how long this job has been up. */
function uptime(startedAt: string, now: number): string {
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "";
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 === 0 ? `${minutes}m` : `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * ANSI colour, removed for display.
 *
 * Dev servers colour their output, and a browser renders those escape codes as
 * literal garbage — a Vite banner arrives as `\u001b[32m➜\u001b[39m` and reads
 * as corruption rather than as a startup line. Stripping is the honest fix
 * here: nothing is being interpreted or reformatted, only the terminal control
 * bytes a browser cannot act on are dropped.
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[ -/]*[@-~]`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/** `pnpm dev` — what was actually run, short enough to sit on one line. */
function commandLabel(entry: WebProcess): string {
  const full = [entry.command, ...entry.args].join(" ");
  return full.length > 64 ? `${full.slice(0, 63)}…` : full;
}

export const ProcessDock = memo(function ProcessDock({ projectId }: ProcessDockProps) {
  const processes = useQuery(processQueries.list(projectId));
  const running = (processes.data ?? []).filter((entry) => entry.status === "running");
  const [openLogs, setOpenLogs] = useState<string | null>(null);
  // One clock for the whole dock. A timer per row would re-render each of them
  // on its own schedule for a number that changes at the same rate anyway.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (running.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [running.length]);

  if (running.length === 0) return null;

  return (
    <section aria-label="Background jobs" className="morrow-process-dock" data-testid="process-dock">
      {running.map((entry) => (
        <ProcessRow
          entry={entry}
          key={entry.id}
          logsOpen={openLogs === entry.id}
          now={now}
          onToggleLogs={() => setOpenLogs((current) => (current === entry.id ? null : entry.id))}
          projectId={projectId}
        />
      ))}
    </section>
  );
});

const ProcessRow = memo(function ProcessRow({
  entry,
  projectId,
  now,
  logsOpen,
  onToggleLogs,
}: {
  entry: WebProcess;
  projectId: string;
  now: number;
  logsOpen: boolean;
  onToggleLogs: () => void;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const stop = useMutation({
    mutationFn: () => processApi.terminate(entry.id, false),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: processKeys.list(projectId) });
    },
    onError: () => setError("Morrow could not stop this job."),
  });

  // Loopback first: a server bound to every interface prints several addresses
  // for one server, and only this one is guaranteed to reach it from here.
  const endpoint =
    entry.endpoints.find((item) => item.host === "127.0.0.1" || item.host.toLowerCase() === "localhost")
    ?? entry.endpoints[0];

  return (
    <div className="morrow-process" data-testid="process-row">
      <div className="morrow-process__head">
        <span aria-hidden="true" className="morrow-process__pulse" />
        <span className="morrow-process__command" title={[entry.command, ...entry.args].join(" ")}>
          {commandLabel(entry)}
        </span>

        {endpoint ? (
          <a
            className="morrow-process__endpoint"
            href={endpoint.url}
            rel="noreferrer"
            target="_blank"
            // A wildcard bind was normalized so a browser can open it, which
            // means this link is not character-for-character what the server
            // printed. Say so on hover rather than quietly differing.
            title={endpoint.rewritten ? `${endpoint.url} — the server bound every interface; this is the address that reaches it from here` : endpoint.url}
          >
            <span>{endpoint.url.replace(/^https?:\/\//, "")}</span>
            <ExternalLink aria-hidden="true" size={11} />
          </a>
        ) : (
          // Absence is reported, not hidden: a server that has not announced an
          // address yet is the normal state during a first compile, and a row
          // with nothing where the link goes reads as a broken link.
          <span className="morrow-process__pending">no address announced yet</span>
        )}

        <span className="morrow-process__uptime">{uptime(entry.startedAt, now)}</span>

        <button
          aria-expanded={logsOpen}
          className="morrow-process__action"
          onClick={onToggleLogs}
          type="button"
        >
          <Terminal aria-hidden="true" size={12} />
          <span>Logs</span>
        </button>

        <button
          className="morrow-process__action morrow-process__action--stop"
          disabled={stop.isPending}
          onClick={() => stop.mutate()}
          type="button"
        >
          {stop.isPending
            ? <Loader2 aria-hidden="true" className="morrow-process__spinner" size={12} />
            : <Square aria-hidden="true" size={11} />}
          <span>{stop.isPending ? "Stopping…" : "Stop"}</span>
        </button>
      </div>

      {error ? <p className="morrow-process__error" role="alert">{error}</p> : null}
      {logsOpen ? <ProcessLogs processId={entry.id} /> : null}
    </div>
  );
});

/**
 * What the job has printed. Both streams are offered because tools disagree
 * about which one a startup banner belongs on, and a reader hunting for "why
 * did it not come up" should not have to know that.
 */
const ProcessLogs = memo(function ProcessLogs({ processId }: { processId: string }) {
  const [stream, setStream] = useState<"stdout" | "stderr">("stdout");
  const output = useQuery(processQueries.output(processId, stream, true));
  const text = stripAnsi(output.data?.data ?? "");

  return (
    <div className="morrow-process__logs">
      <div className="morrow-process__streams" role="tablist">
        {(["stdout", "stderr"] as const).map((name) => (
          <button
            aria-selected={stream === name}
            className="morrow-process__stream"
            key={name}
            onClick={() => setStream(name)}
            role="tab"
            type="button"
          >
            {name}
          </button>
        ))}
        {output.data?.truncated ? (
          <span className="morrow-process__truncated">capture limit reached — later output dropped</span>
        ) : null}
      </div>
      {output.isPending ? (
        <p className="morrow-process__log-empty">Reading…</p>
      ) : output.isError ? (
        <p className="morrow-process__log-empty" role="alert">Morrow could not read this job&apos;s output.</p>
      ) : text.trim() ? (
        <pre className="morrow-process__log" data-testid="process-log">{text}</pre>
      ) : (
        <p className="morrow-process__log-empty">Nothing on {stream} yet.</p>
      )}
    </div>
  );
});
