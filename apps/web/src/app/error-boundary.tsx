import { ErrorCard, type ErrorCardProps } from "@morrow/ui";
import {
  Component,
  createRef,
  type ErrorInfo,
  type ReactNode,
  type Ref,
} from "react";
import { ApiClientError } from "../api/client.js";

export interface ErrorCardModel {
  attempted: readonly string[];
  continuation: string;
  explanation: string;
  preservedMessage: string;
  retryable: boolean;
  title: string;
  traceId: string | null;
}

const SAFE_TRACE_ID = /^[a-zA-Z0-9._:-]{1,120}$/;

function safeTraceId(traceId: string | null): string | null {
  return traceId && SAFE_TRACE_ID.test(traceId) ? traceId : null;
}

function safeApiExplanation(error: ApiClientError): string {
  if (error.code === "RUNTIME_UNAVAILABLE") {
    return "The local Morrow runtime could not be reached.";
  }
  if (error.status >= 500) {
    return "The service could not complete the request. No raw server details were added to this page.";
  }
  const knownClientMessages: Record<string, string> = {
    ATTENTION_ALREADY_RESOLVED:
      "That attention request no longer accepts a decision. Refresh authoritative mission state before acting again.",
    INVALID_CHOICE:
      "That choice is not supported by the current runtime. The attention request remains unchanged.",
    MISSION_RESPONSE_MISMATCH:
      "The service response did not match the mission being updated. No response data was applied.",
    NOT_FOUND:
      "The requested mission item is no longer available in this workspace.",
  };
  return (
    knownClientMessages[error.code] ??
    "The request was rejected. Review the action or open diagnostics before trying different work."
  );
}

export function toErrorCard(error: unknown): ErrorCardModel {
  if (error instanceof ApiClientError) {
    const runtimeUnavailable = error.code === "RUNTIME_UNAVAILABLE";
    const retryable = error.status >= 500 || runtimeUnavailable;
    return {
      attempted: [],
      continuation: retryable
        ? "Retry explicitly when the required service is available. Morrow will reload authoritative state before continuing."
        : "Review the request or open diagnostics. Morrow will not repeat this action automatically.",
      explanation: safeApiExplanation(error),
      preservedMessage: "Your work is preserved and no decision was applied by this failed request.",
      retryable,
      title: runtimeUnavailable
        ? "Morrow is not connected"
        : "Morrow could not complete that action",
      traceId: safeTraceId(error.traceId),
    };
  }

  return {
    attempted: [],
    continuation:
      "Retry explicitly or open diagnostics. Morrow will reload authoritative state before continuing.",
    explanation:
      "Your mission state is still safe. Retry the request or open diagnostics.",
    preservedMessage: "Your work is preserved.",
    retryable: true,
    title: "Morrow could not complete that action",
    traceId: null,
  };
}

interface ActionableErrorCardProps {
  cardRef?: Ref<HTMLElement>;
  error: unknown;
  onDiagnostics?: () => void;
  onRetry: () => void;
  retryLabel?: string;
}

export function ActionableErrorCard({
  cardRef,
  error,
  onDiagnostics,
  onRetry,
  retryLabel = "Retry request",
}: ActionableErrorCardProps) {
  const model = toErrorCard(error);
  const diagnostics = onDiagnostics ?? onRetry;
  const recommendedAction = model.retryable
    ? { label: retryLabel, onClick: onRetry }
    : { label: "Open diagnostics", onClick: diagnostics };
  const alternativeActions: ErrorCardProps["alternativeActions"] =
    model.retryable && onDiagnostics
      ? [{ label: "Open diagnostics", onClick: onDiagnostics }]
      : [];

  return (
    <ErrorCard
      alternativeActions={alternativeActions}
      attempted={model.attempted}
      continuation={
        <>
          <span>{model.continuation}</span>
          {model.traceId ? (
            <span className="morrow-error-reference">
              Reference: {model.traceId}
            </span>
          ) : null}
        </>
      }
      explanation={model.explanation}
      preservedMessage={model.preservedMessage}
      recommendedAction={recommendedAction}
      ref={cardRef}
      tabIndex={-1}
      title={model.title}
    />
  );
}

interface GlobalErrorBoundaryProps {
  children: ReactNode;
}

interface GlobalErrorBoundaryState {
  failed: boolean;
}

export class GlobalErrorBoundary extends Component<
  GlobalErrorBoundaryProps,
  GlobalErrorBoundaryState
> {
  override state: GlobalErrorBoundaryState = { failed: false };
  private readonly fallbackRef = createRef<HTMLElement>();

  static getDerivedStateFromError(): GlobalErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(_error: unknown, _errorInfo: ErrorInfo): void {
    // React owns developer diagnostics. The browser fallback intentionally
    // neither stores nor renders the raw exception, stack, or component trace.
    queueMicrotask(() => this.fallbackRef.current?.focus());
  }

  private readonly retry = () => {
    this.setState({ failed: false }, () => {
      window.requestAnimationFrame(() => {
        document.getElementById("main-content")?.focus();
      });
    });
  };

  override render() {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="morrow-global-error" id="main-content">
        <ActionableErrorCard
          cardRef={this.fallbackRef}
          error={null}
          onRetry={this.retry}
          retryLabel="Retry Morrow"
        />
      </main>
    );
  }
}
