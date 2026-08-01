import type { Approval, ApprovalDecision } from "@morrow/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";
import { approvalApi, approvalKeys, approvalQueries } from "../../api/approvals.js";
import { conversationKeys } from "../../api/conversations.js";

function approvalTarget(approval: Approval): string | null {
  const details = approval.details as { files?: unknown; executable?: unknown; args?: unknown; cwd?: unknown };
  if (Array.isArray(details.files)) {
    const files = details.files.filter((file): file is string => typeof file === "string");
    if (files.length > 0) return files.join(", ");
  }
  if (typeof details.executable === "string") {
    const args = Array.isArray(details.args)
      ? details.args.filter((arg): arg is string => typeof arg === "string")
      : [];
    return [details.executable, ...args].join(" ");
  }
  return null;
}

export interface PendingApprovalsProps {
  /** True while a task in this conversation is still running — keeps the
   * approval check live so a blocking request surfaces within seconds. */
  active: boolean;
  conversationId: string;
  /** Task ids referenced by this conversation's messages; approvals for any
   * other conversation's tasks stay out of this view. */
  conversationTaskIds: ReadonlySet<string>;
  projectId: string;
}

/**
 * Blocking approval requests raised by this conversation's tasks. Without
 * this card a chat task that asks for approval had no in-conversation way to
 * resolve it — the run simply stalled until the user gave up. Allow/Deny here
 * resolves the server-side approval and wakes the waiting task.
 */
export function PendingApprovals({ active, conversationId, conversationTaskIds, projectId }: PendingApprovalsProps) {
  const queryClient = useQueryClient();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const approvals = useQuery({
    ...approvalQueries.pending(projectId),
    refetchInterval: active ? 2000 : false,
  });
  const resolve = useMutation({
    mutationFn: ({ approvalId, decision }: { approvalId: string; decision: ApprovalDecision }) =>
      approvalApi.resolve(approvalId, { projectId, decision }),
    onSettled: () => {
      setBusyId(null);
      return Promise.all([
        queryClient.invalidateQueries({ queryKey: approvalKeys.pending(projectId) }),
        queryClient.invalidateQueries({ queryKey: conversationKeys.messages(projectId, conversationId) }),
        queryClient.invalidateQueries({ queryKey: conversationKeys.activity(projectId, conversationId) }),
      ]).then(() => undefined);
    },
  });

  const visible = (approvals.data ?? []).filter((approval) => conversationTaskIds.has(approval.taskId));
  if (visible.length === 0) return null;

  const decide = (approvalId: string, decision: ApprovalDecision) => {
    setBusyId(approvalId);
    setError(null);
    resolve.mutate(
      { approvalId, decision },
      { onError: (cause) => setError(cause instanceof Error ? cause.message : "The approval could not be resolved.") },
    );
  };

  return (
    <section aria-label="Approvals waiting for your decision" className="morrow-approvals">
      {visible.map((approval) => {
        const target = approvalTarget(approval);
        const busy = busyId === approval.id;
        return (
          <article className="morrow-approvals__card" key={approval.id}>
            <header>
              <ShieldAlert aria-hidden="true" size={18} />
              <div>
                <p className="morrow-approvals__eyebrow">
                  {approval.kind === "change_set" ? "File changes" : "Command"} · waiting for you
                </p>
                <h3>{approval.summary}</h3>
              </div>
            </header>
            {target ? <code className="morrow-approvals__target">{target}</code> : null}
            <p className="morrow-approvals__hint">
              Morrow paused this run until you decide. Allowing applies this {approval.kind === "change_set" ? "change" : "command"} once.
            </p>
            {error && busyId === null ? <p role="alert">{error}</p> : null}
            <div className="morrow-approvals__actions">
              <button
                className="morrow-approvals__allow"
                disabled={busy}
                onClick={() => decide(approval.id, "allow_once")}
                type="button"
              >
                {busy ? "Resolving…" : "Allow once"}
              </button>
              <button
                className="morrow-approvals__deny"
                disabled={busy}
                onClick={() => decide(approval.id, "deny")}
                type="button"
              >
                Deny
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}
