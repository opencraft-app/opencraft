export interface TelemetrySpan {
  enabled: boolean;
  handle: string;
  traceparent: string;
}

export interface HostTelemetryPort {
  enabled?: boolean;
  startSpan?(
    name: string,
    attributes: Record<string, unknown>,
    parentTraceparent: string,
  ): TelemetrySpan;
  addEvent?(handle: string, name: string, attributes: Record<string, unknown>): void;
  endSpan?(handle: string, status: string): void;
}

function bridge(): HostTelemetryPort | null {
  return globalThis.hostTelemetry !== undefined &&
      typeof globalThis.hostTelemetry === "object"
    ? globalThis.hostTelemetry
    : null;
}

export function telemetryEnabled(): boolean {
  return bridge()?.enabled === true;
}

export function startSpan(
  name: string,
  attributes: Record<string, unknown> = {},
  parentTraceparent = "",
): TelemetrySpan {
  const host = bridge();
  if (host?.startSpan === undefined) {
    return { enabled: false, handle: "", traceparent: "" };
  }
  try {
    return host.startSpan(name, attributes, parentTraceparent);
  }
  catch {
    return { enabled: false, handle: "", traceparent: "" };
  }
}

export function addSpanEvent(
  span: TelemetrySpan | null | undefined,
  name: string,
  attributes: Record<string, unknown> = {},
): void {
  const host = bridge();
  if (!span?.handle || host?.addEvent === undefined) return;
  try {
    host.addEvent(span.handle, name, attributes);
  }
  catch {
    // Telemetry is deliberately best effort.
  }
}

export function endSpan(span: TelemetrySpan | null | undefined, status = "ok"): void {
  const host = bridge();
  if (!span?.handle || host?.endSpan === undefined) return;
  try {
    host.endSpan(span.handle, status);
  }
  catch {
    // Telemetry is deliberately best effort.
  }
  span.handle = "";
}
