import type { WebConversationActivityEntry } from "@morrow/contracts";
import { useQuery } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { memo, useState } from "react";
import { evidenceQueries } from "../../api/evidence.js";

/**
 * What a step actually produced, opened from the row that ran it.
 *
 * The transcript carries a handle, not the output, so this is the request that
 * turns a scannable line into the real recording. That split is what keeps the
 * reading column readable: a run with two hundred steps stays two hundred
 * lines, and only the ones a reader asks about cost anything.
 */

export interface EvidenceCardProps {
  entry: WebConversationActivityEntry;
  projectId: string;
  conversationId: string;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const EvidenceCard = memo(function EvidenceCard({ entry, projectId, conversationId }: EvidenceCardProps) {
  const [copied, setCopied] = useState(false);
  const evidence = useQuery({
    ...evidenceQueries.step(projectId, conversationId, entry.taskId, entry.evidenceRef ?? ""),
    enabled: Boolean(entry.evidenceRef),
  });

  // Facts the row already showed, repeated so the card stands on its own when
  // a reader has scrolled the row out of view.
  const facts: Array<{ label: string; value: string }> = [];
  if (entry.toolName) facts.push({ label: "Tool", value: entry.toolName.replaceAll("_", " ") });
  if (entry.durationMs !== null) {
    facts.push({ label: "Took", value: entry.durationMs >= 1000 ? `${(entry.durationMs / 1000).toFixed(1)}s` : `${entry.durationMs} ms` });
  }
  if (entry.exitCode !== null) facts.push({ label: "Exit", value: String(entry.exitCode) });
  if (entry.resultCount !== null) facts.push({ label: "Results", value: entry.resultCount.toLocaleString("en-US") });

  const body = evidence.data?.body ?? "";

  return (
    <div className="morrow-evidence" data-testid="evidence-card">
      {entry.target ? (
        <p className="morrow-evidence__target"><code>{entry.target}</code></p>
      ) : null}
      {entry.detail ? <p className="morrow-evidence__detail">{entry.detail}</p> : null}

      {facts.length > 0 ? (
        <dl className="morrow-evidence__facts">
          {facts.map((fact) => (
            <div key={fact.label}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {!entry.evidenceRef ? (
        <p className="morrow-evidence__note">This step recorded no output of its own.</p>
      ) : evidence.isPending ? (
        <p aria-live="polite" className="morrow-evidence__note" role="status">Reading what this step recorded…</p>
      ) : evidence.isError ? (
        <div className="morrow-evidence__note">
          <p role="alert">That recording could not be read.</p>
          <button onClick={() => void evidence.refetch()} type="button">Try again</button>
        </div>
      ) : evidence.data!.bodyKind === "none" ? (
        <p className="morrow-evidence__note">This step recorded no output of its own.</p>
      ) : (
        <div className="morrow-evidence__output">
          <div className="morrow-evidence__output-head">
            <span>{evidence.data!.bodyKind === "json" ? "Result" : "Output"}</span>
            <button
              aria-label="Copy output"
              className="morrow-evidence__copy"
              onClick={() => {
                void navigator.clipboard?.writeText(body);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              type="button"
            >
              {copied ? <Check aria-hidden="true" size={12} /> : <Copy aria-hidden="true" size={12} />}
              <span>{copied ? "Copied" : "Copy"}</span>
            </button>
          </div>
          <pre className="morrow-evidence__body" data-kind={evidence.data!.bodyKind}>{body}</pre>
          {evidence.data!.truncated ? (
            <p className="morrow-evidence__note">
              Showing the first part of {formatBytes(evidence.data!.bytes)}. The whole recording is kept.
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
});
