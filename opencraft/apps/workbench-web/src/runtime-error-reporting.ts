export interface RuntimeErrorReport {
  message: string;
  name?: string;
  stack?: string;
  componentStack?: string;
  resourceUrl?: string;
  source:
    | "error-boundary"
    | "window-error"
    | "unhandled-rejection"
    | "panel-runtime-bootstrap"
    | "application-bootstrap";
  url: string;
}

function describeUnknown(value: unknown): Pick<RuntimeErrorReport, "message" | "name" | "stack"> {
  if (value instanceof Error) {
    return {
      message: value.message,
      name: value.name,
      stack: value.stack,
    };
  }

  return {
    message: typeof value === "string" ? value : JSON.stringify(value),
  };
}

function isResizeObserverDeliveryWarning(message: string): boolean {
  return message === "ResizeObserver loop completed with undelivered notifications."
    || message === "ResizeObserver loop limit exceeded";
}

export function reportRuntimeError(
  error: unknown,
  source: RuntimeErrorReport["source"],
  componentStack?: string,
  resourceUrl?: string,
): void {
  const description = describeUnknown(error);
  if (isResizeObserverDeliveryWarning(description.message)) return;
  const report: RuntimeErrorReport = {
    ...description,
    componentStack,
    resourceUrl,
    source,
    url: window.location.href,
  };

  void fetch("/__opencraft_runtime_error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(report),
    keepalive: true,
  }).catch(() => undefined);
}
