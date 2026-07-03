import assert from "node:assert/strict";
import test from "node:test";

import { SpanStatusCode } from "@opentelemetry/api";
import { VelaLocalTracer } from "../src/index";

test("local tracer exports ended spans to velad OTLP HTTP JSON", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const tracer = new VelaLocalTracer({
    endpoint: "http://127.0.0.1:49321",
    serviceName: "vela-test",
    tracerName: "vela.test",
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ accepted: true, spans: 1, logs: 0 });
    }) as typeof fetch,
  });

  const span = tracer.startSpan("electron.velad.start", {
    attributes: {
      "velad.runtime.mode": "bundled",
      "velad.listen_addr": "127.0.0.1:49321",
    },
  });
  tracer.endSpan(span, { code: SpanStatusCode.OK });
  await tracer.forceFlush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:49321/v1/traces");
  const resourceSpan = requests[0].body.resourceSpans[0];
  assert.deepEqual(resourceSpan.resource.attributes[0], {
    key: "service.name",
    value: { stringValue: "vela-test" },
  });
  const otlpSpan = resourceSpan.scopeSpans[0].spans[0];
  assert.equal(otlpSpan.name, "electron.velad.start");
  assert.equal(otlpSpan.status.code, "STATUS_CODE_OK");
  assert.match(otlpSpan.traceId, /^[a-f0-9]{32}$/);
  assert.match(otlpSpan.spanId, /^[a-f0-9]{16}$/);
  assert.deepEqual(
    otlpSpan.attributes.find((attribute: any) => attribute.key === "velad.runtime.mode"),
    { key: "velad.runtime.mode", value: { stringValue: "bundled" } },
  );
});

test("local tracer queues spans until velad endpoint is known", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const tracer = new VelaLocalTracer({
    serviceName: "vela-test",
    tracerName: "vela.test",
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ accepted: true, spans: 1, logs: 0 });
    }) as typeof fetch,
  });

  const span = tracer.startSpan("electron.velad.start");
  tracer.endSpan(span);
  await tracer.forceFlush();
  assert.equal(requests.length, 0);

  tracer.setEndpoint("http://127.0.0.1:49321");
  await tracer.forceFlush();

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:49321/v1/traces");
});

test("local tracer reports trace export failures to the host", async () => {
  const errors: Array<{ message: string; kind: string; endpoint: string }> = [];
  const tracer = new VelaLocalTracer({
    endpoint: "http://127.0.0.1:49321",
    serviceName: "vela-test",
    tracerName: "vela.test",
    fetchImpl: (async () => Response.json({ error: "blocked" }, { status: 500 })) as typeof fetch,
    onExportError: (error, context) => {
      errors.push({
        message: error.message,
        kind: context.kind,
        endpoint: context.endpoint,
      });
    },
  });

  const span = tracer.startSpan("vela.desktop.renderer.ready");
  tracer.endSpan(span, { code: SpanStatusCode.OK });
  await tracer.forceFlush();

  assert.deepEqual(errors, [
    {
      message: "velad OTLP trace export returned 500",
      kind: "trace",
      endpoint: "http://127.0.0.1:49321",
    },
  ]);
});

test("local tracer keeps the default browser fetch bound to globalThis", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ thisIsGlobal: boolean; url: string }> = [];
  try {
    globalThis.fetch = function (this: unknown, url: RequestInfo | URL) {
      calls.push({ thisIsGlobal: this === globalThis, url: String(url) });
      return Promise.resolve(Response.json({ accepted: true, spans: 1, logs: 0 }));
    } as typeof fetch;

    const tracer = new VelaLocalTracer({
      endpoint: "http://127.0.0.1:49321",
      serviceName: "vela-test",
      tracerName: "vela.test",
    });
    const span = tracer.startSpan("vela.desktop.renderer.ready");
    tracer.endSpan(span, { code: SpanStatusCode.OK });
    await tracer.forceFlush();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      thisIsGlobal: true,
      url: "http://127.0.0.1:49321/v1/traces",
    },
  ]);
});

test("local tracer exports logs to velad OTLP HTTP JSON", async () => {
  const requests: Array<{ url: string; body: any }> = [];
  const tracer = new VelaLocalTracer({
    endpoint: "http://127.0.0.1:49321",
    serviceName: "vela-test",
    loggerName: "vela.test.logs",
    fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return Response.json({ accepted: true, spans: 0, logs: 1 });
    }) as typeof fetch,
  });

  await tracer.emitLog({
    severityText: "ERROR",
    body: "failed to fetch",
    attributes: {
      "vela.operation": "velad.session.create",
      "backend": "codex",
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://127.0.0.1:49321/v1/logs");
  const resourceLog = requests[0].body.resourceLogs[0];
  assert.deepEqual(resourceLog.resource.attributes[0], {
    key: "service.name",
    value: { stringValue: "vela-test" },
  });
  const log = resourceLog.scopeLogs[0].logRecords[0];
  assert.equal(log.severityText, "ERROR");
  assert.equal(log.body.stringValue, "failed to fetch");
  assert.deepEqual(
    log.attributes.find((attribute: any) => attribute.key === "vela.operation"),
    { key: "vela.operation", value: { stringValue: "velad.session.create" } },
  );
});

test("local tracer reports log export failures to the host", async () => {
  const errors: Array<{ message: string; kind: string; endpoint: string }> = [];
  const tracer = new VelaLocalTracer({
    endpoint: "http://127.0.0.1:49321",
    serviceName: "vela-test",
    loggerName: "vela.test.logs",
    fetchImpl: (async () => Response.json({ error: "blocked" }, { status: 403 })) as typeof fetch,
    onExportError: (error, context) => {
      errors.push({
        message: error.message,
        kind: context.kind,
        endpoint: context.endpoint,
      });
    },
  });

  await assert.rejects(
    () =>
      tracer.emitLog({
        severityText: "ERROR",
        body: "renderer export failed",
      }),
    /log export returned 403/,
  );

  assert.deepEqual(errors, [
    {
      message: "velad OTLP log export returned 403",
      kind: "log",
      endpoint: "http://127.0.0.1:49321",
    },
  ]);
});
