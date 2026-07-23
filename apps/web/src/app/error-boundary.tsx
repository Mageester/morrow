import { ErrorCard } from "@morrow/ui";
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
    "The request was rejected. Refresh mission state before trying different work."
  );
}

export function toErrorCard(error: unknown): ErrorCardModel {
  if (error instanceof ApiClientError) {
    const runtimeUnavailable = error.code === "RUNTIME_UNAVAILABLE";
    const retryable = error.status >= 500 || runtimeUnavailable;
    const outcomeUnknown = error.status >= 500;
    return {
      attempted: [],
      continuation: retryable
        ? "Reload authoritative state before choosing whether to try the action again."
        : "Refresh authoritative state and review the request. Morrow will not repeat this action automatically.",
      explanation: safeApiExplanation(error),
      preservedMessage: outcomeUnknown
        ? "Your synchronized work remains available, but the decision outcome is not confirmed."
        : "Your work is preserved and the rejected request did not apply a decision.",
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
      "Reload authoritative state before choosing whether to try the action again.",
    explanation:
      "Your mission state is still safe, but the action outcome could not be confirmed.",
    preservedMessage:
      "Your synchronized work remains available. No automatic retry was started.",
    retryable: true,
    title: "Morrow could not complete that action",
    traceId: null,
  };
}

interface ActionableErrorCardProps {
  cardRef?: Ref<HTMLElement>;
  error: unknown;
  onRefresh?: () => void;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ActionableErrorCard({
  cardRef,
  error,
  onRefresh,
  onRetry,
  retryLabel = "Retry request",
}: ActionableErrorCardProps) {
  const model = toErrorCard(error);
  const recommendedAction = onRefresh
    ? { label: "Refresh mission state", onClick: onRefresh }
    : { label: retryLabel, onClick: onRetry ?? (() => undefined) };

  return (
    <ErrorCard
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
  private errorGeneration = 0;
  private restorationFrame: number | null = null;

  static getDerivedStateFromError(): GlobalErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(_error: unknown, _errorInfo: ErrorInfo): void {
    // React owns developer diagnostics. The browser fallback intentionally
    // neither stores nor renders the raw exception, stack, or component trace.
    this.errorGeneration += 1;
    this.cancelRestorationFrame();
    const generation = this.errorGeneration;
    queueMicrotask(() => {
      if (this.state.failed && this.errorGeneration === generation) {
        this.fallbackRef.current?.focus();
      }
    });
  }

  override componentWillUnmount(): void {
    this.cancelRestorationFrame();
  }

  private readonly cancelRestorationFrame = () => {
    if (this.restorationFrame === null) return;
    window.cancelAnimationFrame(this.restorationFrame);
    this.restorationFrame = null;
  };

  private readonly retry = () => {
    this.cancelRestorationFrame();
    const retryGeneration = this.errorGeneration;
    this.setState({ failed: false }, () => {
      this.restorationFrame = window.requestAnimationFrame(() => {
        this.restorationFrame = null;
        if (this.state.failed || this.errorGeneration !== retryGeneration) {
          this.fallbackRef.current?.focus();
          return;
        }
        document
          .querySelector<HTMLElement>(
            '[data-error-boundary-focus-target="true"]',
          )
          ?.focus();
      });
      if (
        this.state.failed ||
        this.errorGeneration !== retryGeneration ||
        this.fallbackRef.current
      ) {
        this.cancelRestorationFrame();
        this.fallbackRef.current?.focus();
      }
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
