import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  mkdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalTelemetry } from "../src/adapters/telemetry/local-telemetry.mjs";
import { running, until } from "./helpers.mjs";
import { request } from "../src/adapters/local/unix-socket.mjs";
import { evaluateAssistant } from "../evaluation/assistant-session.mjs";
import { modelRequest } from "../src/adapters/models/model-request.mjs";
import { decodeOutput } from "../src/adapters/models/structured-output.mjs";

function fixture(t, options = {}) {
  const path = mkdtempSync(join(tmpdir(), "otel-test-"));
  const profile = {
    path,
    config: { assistantId: "synthetic-profile", ...options },
  };
  const telemetry = createLocalTelemetry(profile, options.exporter);
  t.after(async () => {
    await telemetry.close();
    rmSync(path, { recursive: true, force: true });
  });
  return { profile, telemetry };
}
function envelopes(path, name) {
  return readFileSync(join(path, "telemetry", name + ".otlp.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
}
const spans = (p) =>
  envelopes(p, "traces").flatMap((x) =>
    x.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)),
  );
const logs = (p) =>
  envelopes(p, "logs").flatMap((x) =>
    x.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords)),
  );
const attributes = (x) =>
  Object.fromEntries(
    (x.attributes ?? []).map((a) => [a.key, Object.values(a.value)[0]]),
  );

test("official OTLP JSON exports correlated logs and concurrent parent/child spans without global state", async (t) => {
  const a = fixture(t),
    b = fixture(t);
  await Promise.all([
    a.telemetry.run("root.a", {}, async () => {
      await delay(5);
      await a.telemetry.run("child.a", {}, async () =>
        a.telemetry.event("inside.a", { "app.phase": "synthetic" }),
      );
    }),
    b.telemetry.run("root.b", {}, () =>
      b.telemetry.run("child.b", {}, async () => {}),
    ),
  ]);
  await Promise.all([a.telemetry.close(), b.telemetry.close()]);
  const sa = spans(a.profile.path),
    sb = spans(b.profile.path);
  assert.equal(sa.length, 2);
  assert.equal(sb.length, 2);
  const root = sa.find((s) => s.name === "root.a"),
    child = sa.find((s) => s.name === "child.a");
  assert.equal(child.parentSpanId, root.spanId);
  assert.equal(child.traceId, root.traceId);
  assert.notEqual(root.traceId, sb[0].traceId);
  const log = logs(a.profile.path).find(
    (l) => l.body.stringValue === "inside.a",
  );
  assert.equal(log.traceId, child.traceId);
  assert.equal(log.spanId, child.spanId);
  assert.ok(BigInt(child.endTimeUnixNano) >= BigInt(child.startTimeUnixNano));
  assert.equal(
    statSync(join(a.profile.path, "telemetry", "logs.otlp.jsonl")).mode & 0o777,
    0o600,
  );
});

test("model timeout is correlated, safely classified, and cannot export prompts or raw failures", async (t) => {
  const { profile, telemetry } = fixture(t);
  let calls = 0;
  const transport = {
    provider: "synthetic",
    modelId: "test",
    complete: async () => {
      calls++;
      const e = new Error("PRIVATE_PAYLOAD_TOKEN");
      e.name = "TimeoutError";
      throw e;
    },
  };
  await assert.rejects(
    modelRequest(
      { configured: { mode: "model" } },
      "reception",
      "PRIVATE_PROMPT_TOKEN",
      { text: "PRIVATE_INPUT_TOKEN" },
      new AbortController().signal,
      { telemetry, transport },
    ),
    /PRIVATE_PAYLOAD_TOKEN/,
  );
  telemetry.event("synthetic", {
    apiKey: "PRIVATE_KEY_TOKEN",
    prompt: "PRIVATE_PROMPT_TOKEN",
    "app.phase": "test",
  });
  await telemetry.close();
  assert.equal(calls, 1);
  assert.equal(spans(profile.path)[0].status.code, 2);
  assert.equal(
    attributes(spans(profile.path)[0])["app.error_type"],
    "TimeoutError",
  );
  const bytes = envelopes(profile.path, "logs").concat(
    envelopes(profile.path, "traces"),
  );
  assert.doesNotMatch(JSON.stringify(bytes), /PRIVATE_.*_TOKEN/);
});

test("structured failures export schema-owned paths and codes without arbitrary model keys or values", async (t) => {
  const { profile, telemetry } = fixture(t);
  try {
    decodeOutput(
      "reception",
      JSON.stringify({
        proposal: {
          kind: "reply",
          text: "PRIVATE_ANSWER_TOKEN",
          PRIVATE_KEY_TOKEN: "PRIVATE_VALUE_TOKEN",
        },
      }),
      {},
    );
    assert.fail("Expected rejection");
  } catch (error) {
    telemetry.event("codex.schema_rejected", {
      "app.schema_stage": error.diagnostic.stage,
      "app.schema_issue": error.diagnostic.code,
      "app.schema_path": error.diagnostic.path,
      output: "PRIVATE_ANSWER_TOKEN",
    });
  }
  await telemetry.close();
  const records = logs(profile.path);
  assert.deepEqual(attributes(records[0]), {
    "app.schema_stage": "wire",
    "app.schema_issue": "unexpected",
    "app.schema_path": "$.proposal.<unknown>",
  });
  assert.doesNotMatch(JSON.stringify(records), /PRIVATE_/);
});

test("bounded rotation retains valid OTLP envelopes and never grows without a limit", async (t) => {
  const { profile, telemetry } = fixture(t, { exporter: { maxBytes: 4096 } });
  for (let i = 0; i < 30; i++)
    await telemetry.run("rotation", { "app.attempt": i }, async () => {});
  await telemetry.close();
  const files = readdirSync(join(profile.path, "telemetry"));
  assert.ok(files.length <= 8);
  assert.ok(files.some((f) => f.endsWith(".3")));
  for (const file of files) {
    const p = join(profile.path, "telemetry", file);
    assert.ok(statSync(p).size <= 4096);
    readFileSync(p, "utf8").trim().split("\n").forEach(JSON.parse);
  }
});

test("unsafe destinations and exporter failures never retry or replace a business result", async (t) => {
  const { profile, telemetry } = fixture(t);
  const file = join(profile.path, "telemetry", "logs.otlp.jsonl");
  symlinkSync(join(profile.path, "missing"), file);
  let calls = 0;
  const result = await telemetry.run("effect", {}, async () => {
    calls++;
    return "original-result";
  });
  await telemetry.close();
  assert.equal(result, "original-result");
  assert.equal(calls, 1);
  assert.ok(telemetry.health().exportErrors > 0);
  assert.equal(existsSync(join(profile.path, "missing")), false);
});

test("telemetry is explicitly disableable without creating local export files", async (t) => {
  const { profile, telemetry } = fixture(t, { telemetry: { enabled: false } });
  await telemetry.run("test", {}, async () => {});
  await telemetry.close();
  assert.equal(existsSync(join(profile.path, "telemetry")), false);
  assert.equal(telemetry.health().enabled, false);
});

test("real runner flushes correlated reception logs on shutdown and reports telemetry health", async (t) => {
  const { profile, runner } = await running(t);
  await request(profile, {
    op: "say",
    id: "otel-chat",
    params: { text: "你好" },
  });
  await until(
    async () =>
      (
        await request(profile, {
          op: "turn",
          id: "get",
          params: { inputId: "otel-chat" },
        })
      ).status === "settled",
  );
  await runner.close();
  assert.ok(spans(profile.path).some((s) => s.name === "reception.process"));
  assert.ok(logs(profile.path).some((l) => l.traceId && l.spanId));
});

test("evaluation replay uses the same local exporter and preserves its outcome", async (t) => {
  const path = mkdtempSync(join(tmpdir(), "otel-eval-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  const result = await evaluateAssistant(
    {
      history: [
        {
          at: Date.UTC(2026, 0, 1),
          messages: [
            { role: "user", content: "我喜欢茶。" },
            { role: "assistant", content: "记住了。" },
          ],
        },
      ],
      queryAt: Date.UTC(2026, 0, 2),
      question: "你好",
    },
    { directory: path, mode: "fixture" },
  );
  assert.ok(result.hypothesis);
  assert.ok(spans(path).some((s) => s.name === "memory.prepare"));
  assert.equal(
    JSON.stringify(envelopes(path, "logs")).includes("我喜欢茶"),
    false,
  );
});

test('native failure diagnosis reaches OTLP without provider error bodies',async t=>{
  const {nativeTurnFailure}=await import('../src/adapters/codex/turn-failure.mjs');
  const {profile,telemetry}=fixture(t);
  await assert.rejects(telemetry.run('codex.turn',{'app.queue_wait_ms':1200},async()=>{
    throw nativeTurnFailure({status:'failed',error:{message:'private-provider-prompt',additionalDetails:'Bearer private-secret',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:429}}}},telemetry,'reception');
  }),/HTTP 429/);
  await telemetry.close();
  const entries=logs(profile.path),event=entries.find(v=>v.body.stringValue==='codex.turn_failed');
  assert.equal(attributes(event)['app.native_error'],'httpConnectionFailed');
  assert.equal(Number(attributes(event)['http.response.status_code']),429);
  assert.ok(spans(profile.path).some(v=>attributes(v)['app.error_type']==='native_turn_failed'));
  assert.ok(spans(profile.path).some(v=>Number(attributes(v)['app.queue_wait_ms'])===1200));
  assert.doesNotMatch(JSON.stringify(entries),/private-provider-prompt|private-secret/);
});
