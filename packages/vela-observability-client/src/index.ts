import { SpanStatusCode, type Attributes, type Span, type SpanStatus } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";

type FetchLike = typeof fetch;
type ExportCallback = Parameters<SpanExporter["export"]>[1];

export interface VeladOtlpJsonSpanExporterOptions {
  fetchImpl?: FetchLike;
  endpoint?: string;
  timeoutMs?: number;
  serviceName?: string;
  maxPendingPayloads?: number;
}

export interface VelaLocalTracerOptions extends VeladOtlpJsonSpanExporterOptions {
  tracerName?: string;
  loggerName?: string;
}

export interface VelaLocalSpanOptions {
  attributes?: Attributes;
}

export type VelaLocalSpan = Span;

export interface VelaLogSpanContext {
  traceId: string;
  spanId: string;
}

export interface VelaLogSpan {
  spanContext?: () => VelaLogSpanContext;
}

export interface VelaLocalLogRecord {
  body: string;
  severityText?: "TRACE" | "DEBUG" | "INFO" | "WARN" | "ERROR" | "FATAL" | string;
  attributes?: Record<string, unknown>;
  span?: VelaLogSpan | null;
  traceId?: string;
  spanId?: string;
}

export class VeladOtlpJsonSpanExporter implements SpanExporter {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly serviceName: string;
  private readonly maxPendingPayloads: number;
  private endpoint: string | null;
  private pendingPayloads: unknown[] = [];
  private isShutdown = false;

  constructor(options: VeladOtlpJsonSpanExporterOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? null;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.serviceName = options.serviceName ?? "vela";
    this.maxPendingPayloads = options.maxPendingPayloads ?? 100;
  }

  setEndpoint(endpoint: string | null) {
    this.endpoint = endpoint;
    if (endpoint) {
      void this.flushPending();
    }
  }

  export(spans: ReadableSpan[], resultCallback: ExportCallback): void {
    if (this.isShutdown || spans.length === 0) {
      resultCallback({ code: 0 });
      return;
    }

    const payload = spansToOtlpJson(spans, this.serviceName);
    if (!this.endpoint) {
      this.pendingPayloads.push(payload);
      if (this.pendingPayloads.length > this.maxPendingPayloads) {
        this.pendingPayloads.splice(0, this.pendingPayloads.length - this.maxPendingPayloads);
      }
      resultCallback({ code: 0 });
      return;
    }

    void this.postPayload(payload).then(
      () => resultCallback({ code: 0 }),
      (error) => resultCallback({ code: 1, error: error instanceof Error ? error : new Error(String(error)) }),
    );
  }

  async forceFlush(): Promise<void> {
    await this.flushPending();
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.isShutdown = true;
  }

  private async flushPending() {
    if (!this.endpoint || this.pendingPayloads.length === 0) return;
    const payloads = this.pendingPayloads;
    this.pendingPayloads = [];
    for (const payload of payloads) {
      await this.postPayload(payload);
    }
  }

  private async postPayload(payload: unknown) {
    if (!this.endpoint) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint.replace(/\/$/, "")}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`velad OTLP trace export returned ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class VeladOtlpJsonLogExporter {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly serviceName: string;
  private readonly loggerName: string;
  private readonly maxPendingPayloads: number;
  private endpoint: string | null;
  private pendingPayloads: unknown[] = [];
  private isShutdown = false;

  constructor(options: VelaLocalTracerOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? null;
    this.timeoutMs = options.timeoutMs ?? 2_000;
    this.serviceName = options.serviceName ?? "vela";
    this.loggerName = options.loggerName ?? options.tracerName ?? "vela.local";
    this.maxPendingPayloads = options.maxPendingPayloads ?? 100;
  }

  setEndpoint(endpoint: string | null) {
    this.endpoint = endpoint;
    if (endpoint) {
      void this.flushPending();
    }
  }

  async emit(record: VelaLocalLogRecord): Promise<void> {
    if (this.isShutdown) return;
    const payload = logRecordToOtlpJson(record, this.serviceName, this.loggerName);
    if (!this.endpoint) {
      this.pendingPayloads.push(payload);
      if (this.pendingPayloads.length > this.maxPendingPayloads) {
        this.pendingPayloads.splice(0, this.pendingPayloads.length - this.maxPendingPayloads);
      }
      return;
    }
    await this.postPayload(payload);
  }

  async forceFlush(): Promise<void> {
    await this.flushPending();
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
    this.isShutdown = true;
  }

  private async flushPending() {
    if (!this.endpoint || this.pendingPayloads.length === 0) return;
    const payloads = this.pendingPayloads;
    this.pendingPayloads = [];
    for (const payload of payloads) {
      await this.postPayload(payload);
    }
  }

  private async postPayload(payload: unknown) {
    if (!this.endpoint) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.endpoint.replace(/\/$/, "")}/v1/logs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`velad OTLP log export returned ${response.status}`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class VelaLocalTracer {
  readonly exporter: VeladOtlpJsonSpanExporter;
  readonly logExporter: VeladOtlpJsonLogExporter;
  private readonly provider: BasicTracerProvider;
  private readonly tracerName: string;

  constructor(options: VelaLocalTracerOptions = {}) {
    this.exporter = new VeladOtlpJsonSpanExporter(options);
    this.logExporter = new VeladOtlpJsonLogExporter(options);
    this.provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(this.exporter)],
      forceFlushTimeoutMillis: options.timeoutMs ?? 2_000,
    });
    this.tracerName = options.tracerName ?? "vela.local";
  }

  setEndpoint(endpoint: string | null) {
    this.exporter.setEndpoint(endpoint);
    this.logExporter.setEndpoint(endpoint);
  }

  startSpan(name: string, options: VelaLocalSpanOptions = {}) {
    return this.provider.getTracer(this.tracerName).startSpan(name, {
      attributes: options.attributes,
    });
  }

  traceparent(span: Span) {
    return traceparentFromSpan(span);
  }

  recordError(span: Span, error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message });
    span.setAttribute("error.message", message);
    span.recordException(error instanceof Error ? error : new Error(message));
  }

  emitLog(record: VelaLocalLogRecord) {
    return this.logExporter.emit(record);
  }

  endSpan(span: Span, status?: SpanStatus) {
    if (status) {
      span.setStatus(status);
    }
    span.end();
  }

  async forceFlush() {
    await this.provider.forceFlush();
    await this.logExporter.forceFlush();
  }

  async shutdown() {
    await this.provider.shutdown();
    await this.logExporter.shutdown();
  }
}

export function traceparentFromSpan(span: Span) {
  const context = span.spanContext();
  const flags = context.traceFlags.toString(16).padStart(2, "0");
  return `00-${context.traceId}-${context.spanId}-${flags}`;
}

export function spansToOtlpJson(spans: ReadableSpan[], serviceName = "vela") {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: [
            otlpAttribute("service.name", serviceName),
          ],
        },
        scopeSpans: groupSpansByScope(spans),
      },
    ],
  };
}

export function logRecordToOtlpJson(
  record: VelaLocalLogRecord,
  serviceName = "vela",
  loggerName = "vela.local",
) {
  const spanContext = record.span?.spanContext();
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            otlpAttribute("service.name", serviceName),
          ],
        },
        scopeLogs: [
          {
            scope: { name: loggerName },
            logRecords: [
              {
                timeUnixNano: unixNanoNowString(),
                severityText: record.severityText ?? "INFO",
                body: { stringValue: record.body },
                ...(record.traceId || spanContext?.traceId ? { traceId: record.traceId ?? spanContext?.traceId } : {}),
                ...(record.spanId || spanContext?.spanId ? { spanId: record.spanId ?? spanContext?.spanId } : {}),
                attributes: attributesToOtlp(record.attributes ?? {}),
              },
            ],
          },
        ],
      },
    ],
  };
}

function groupSpansByScope(spans: ReadableSpan[]) {
  const groups = new Map<string, ReadableSpan[]>();
  for (const span of spans) {
    const scope = span.instrumentationScope?.name ?? "vela.local";
    const version = span.instrumentationScope?.version ?? "";
    const key = `${scope}\u0000${version}`;
    const values = groups.get(key) ?? [];
    values.push(span);
    groups.set(key, values);
  }
  return [...groups.entries()].map(([key, spans]) => {
    const [name, version] = key.split("\u0000");
    return {
      scope: {
        name,
        ...(version ? { version } : {}),
      },
      spans: spans.map(readableSpanToOtlpJson),
    };
  });
}

function readableSpanToOtlpJson(span: ReadableSpan) {
  const context = span.spanContext();
  return {
    traceId: context.traceId,
    spanId: context.spanId,
    ...(span.parentSpanContext?.spanId ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    name: span.name,
    kind: span.kind,
    startTimeUnixNano: hrTimeToUnixNanoString(span.startTime),
    endTimeUnixNano: hrTimeToUnixNanoString(span.endTime),
    attributes: attributesToOtlp(span.attributes),
    status: {
      code: spanStatusCodeToOtlp(span.status.code),
      ...(span.status.message ? { message: span.status.message } : {}),
    },
    events: span.events.map((event) => ({
      name: event.name,
      timeUnixNano: hrTimeToUnixNanoString(event.time),
      attributes: attributesToOtlp(event.attributes ?? {}),
    })),
  };
}

function attributesToOtlp(attributes: Record<string, unknown>) {
  return Object.entries(attributes).flatMap(([key, value]) => {
    const otlpValue = primitiveToOtlpValue(value);
    return otlpValue ? [otlpAttribute(key, value)] : [];
  });
}

function otlpAttribute(key: string, value: unknown) {
  return {
    key,
    value: primitiveToOtlpValue(value),
  };
}

function primitiveToOtlpValue(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { intValue: String(value) };
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    const values = value.map(primitiveToOtlpValue).filter((entry): entry is Record<string, unknown> => Boolean(entry));
    return { arrayValue: { values } };
  }
  return null;
}

function spanStatusCodeToOtlp(code?: SpanStatusCode) {
  if (code === SpanStatusCode.OK) return "STATUS_CODE_OK";
  if (code === SpanStatusCode.ERROR) return "STATUS_CODE_ERROR";
  return "STATUS_CODE_UNSET";
}

function hrTimeToUnixNanoString(hrTime: readonly [number, number]) {
  return (BigInt(hrTime[0]) * 1_000_000_000n + BigInt(hrTime[1])).toString();
}

function unixNanoNowString() {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}
