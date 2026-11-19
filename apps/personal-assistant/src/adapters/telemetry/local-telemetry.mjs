import {
  constants,
  mkdirSync,
  lstatSync,
  openSync,
  closeSync,
  fstatSync,
  ftruncateSync,
  writeSync,
  renameSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { LoggerProvider, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { JsonTraceSerializer, JsonLogsSerializer } from "@opentelemetry/otlp-transformer";

const fields = new Set([
  "app.phase",
  "app.outcome",
  "app.attempt",
  "app.mode",
  "app.harness",
  "app.model_role",
  "app.native_method",
  "app.native_error",
  "app.native_status",
  "http.response.status_code",
  "app.tool",
  "app.error_type",
  "app.schema_stage",
  "app.schema_issue",
  "app.schema_path",
  "app.duration_ms",
  "app.queue_wait_ms",
  "app.batch_attempts",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
]);
function safe(attributes = {}) {
  return Object.fromEntries(
    Object.entries(attributes).filter(
      ([k, v]) =>
        fields.has(k) &&
        (typeof v === "boolean" ||
          (typeof v === "number" && Number.isFinite(v)) ||
          (typeof v === "string" && v.length <= 160)),
    ),
  );
}
function failureType(error) {
  if (error?.code === "CODEX_TURN_FAILED") return "native_turn_failed";
  if (error?.code?.startsWith?.("RUN_LIMIT_")) return "deadline_exceeded";
  if (["AbortError", "TimeoutError"].includes(error?.name)) return error.name;
  return "operation_failed";
}
class LocalExporter {
  constructor(directory, name, serializer, owner) {
    Object.assign(this, { directory, name, serializer, owner });
  }
  export(records, callback) {
    let fd;
    try {
      const bytes = Buffer.concat([Buffer.from(this.serializer.serializeRequest(records)), Buffer.from("\n")]);
      if (bytes.length > this.owner.maxBytes) throw new Error("Telemetry record too large");
      const path = join(this.directory, this.name);
      fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077)
        throw new Error("Unsafe telemetry file");
      if (stat.size + bytes.length > this.owner.maxBytes) {
        closeSync(fd);
        fd = undefined;
        for (let i = this.owner.maxFiles - 1; i >= 1; i--) {
          const from = i === 1 ? path : path + "." + (i - 1);
          if (existsSync(from)) renameSync(from, path + "." + i);
        }
        fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      }
      const size = fstatSync(fd).size;
      try {
        let offset = 0;
        while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      } catch (error) {
        // A partial tail is not a valid OTLP envelope. Preserve prior complete lines.
        this.owner.partialWrite = true;
        try {
          ftruncateSync(fd, size);
        } catch {}
        throw error;
      }
      this.owner.exported += records.length;
      callback({ code: 0 });
    } catch {
      this.owner.exportErrors++;
      callback({ code: 1 });
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  shutdown() {
    return Promise.resolve();
  }
}
const noopSpan = { setAttribute() {}, setAttributes() {} };
const disabled = Object.freeze({
  run: (_n, _a, fn) => fn(noopSpan),
  event() {},
  health: () => ({ enabled: false }),
  close: async () => {},
});

/** Profile-scoped SDKs: never register globals or consume network exporter configuration. */
export function createLocalTelemetry(profile, options = {}) {
  if (profile.config.telemetry?.enabled === false) return disabled;
  const state = {
    enabled: true,
    exported: 0,
    exportErrors: 0,
    partialWrite: false,
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
    maxFiles: 4,
  };
  try {
    const directory = join(profile.path, "telemetry");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || stat.mode & 0o077)
      throw new Error("Unsafe telemetry directory");
    const resource = resourceFromAttributes({
      "service.name": "opencraft-superapp",
      "service.version": "0.16.0",
      "service.instance.id": profile.config.assistantId,
    });
    const context = new AsyncLocalStorageContextManager().enable();
    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [
        new SimpleSpanProcessor(new LocalExporter(directory, "traces.otlp.jsonl", JsonTraceSerializer, state)),
      ],
    });
    const loggerProvider = new LoggerProvider({
      resource,
      processors: [
        new SimpleLogRecordProcessor(new LocalExporter(directory, "logs.otlp.jsonl", JsonLogsSerializer, state)),
      ],
    });
    const tracer = tracerProvider.getTracer("superapp", "0.16.0"),
      logger = loggerProvider.getLogger("superapp", "0.16.0");
    let closed = false,
      closing;
    const event = (name, attributes = {}, level = SeverityNumber.INFO) => {
      if (closed) return;
      try {
        logger.emit({
          context: context.active(),
          severityNumber: level,
          severityText: level === SeverityNumber.ERROR ? "ERROR" : "INFO",
          body: name,
          attributes: safe(attributes),
        });
      } catch {
        state.exportErrors++;
      }
    };
    return {
      event,
      health: () => ({ ...state }),
      async run(name, attributes, fn) {
        if (closed) return fn(noopSpan);
        let span;
        try {
          span = tracer.startSpan(name, { attributes: safe(attributes) }, context.active());
        } catch {
          state.exportErrors++;
          return fn(noopSpan);
        }
        return context.with(trace.setSpan(context.active(), span), async () => {
          const started = performance.now();
          event(name + ".started", attributes);
          let outcome = "returned";
          try {
            return await fn(span);
          } catch (error) {
            outcome = "error";
            span.setStatus({ code: SpanStatusCode.ERROR });
            span.setAttribute("app.error_type", failureType(error));
            throw error;
          } finally {
            span.setAttribute("app.outcome", outcome);
            event(
              name + ".finished",
              {
                ...attributes,
                "app.outcome": outcome,
                "app.duration_ms": performance.now() - started,
              },
              outcome === "error" ? SeverityNumber.ERROR : SeverityNumber.INFO,
            );
            span.end();
          }
        });
      },
      close() {
        return (closing ??= (async () => {
          closed = true;
          await Promise.allSettled([tracerProvider.shutdown(), loggerProvider.shutdown()]);
          context.disable();
        })());
      },
    };
  } catch {
    return {
      ...disabled,
      health: () => ({
        ...state,
        enabled: false,
        exportErrors: state.exportErrors + 1,
      }),
    };
  }
}
