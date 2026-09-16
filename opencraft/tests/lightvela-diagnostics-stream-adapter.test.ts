import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { LightVelaAccountService } from "../plugins/lightvela-platform/src/account/lightvela-account-service";
import type { LightVelaRuntimeCommandPort } from "../plugins/lightvela-platform/src/account/lightvela-runtime-command-port";

type Stream = (botId: string, command: string, onChunk: (event: { stream: string; chunk: string }) => void) => Promise<{ status: string; exitCode: number; output: string }>;

// Execute the actual callback passed to the generated panel. Only the account's
// external command/fetch ports are substituted; no reset controller is imported.
function streamAdapter(account: LightVelaAccountService): Stream {
  const file = new URL("../plugins/lightvela-hermes/src/settings/hermes-diagnostics-management-view.tsx", import.meta.url);
  const source = ts.createSourceFile(file.pathname, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === "AgentDiagnosticsPanel") {
      const prop = node.attributes.properties.find((attribute) => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "execDebugCommandStream");
      if (prop && ts.isJsxAttribute(prop) && prop.initializer && ts.isJsxExpression(prop.initializer)) expression = prop.initializer.expression;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(expression, "the generated diagnostics panel requires the real account stream callback");
  const callback = ts.transpileModule(`(${expression.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("account", `return ${callback}`)(account) as Stream;
}

const memoryStorage = () => {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
};

test("diagnostics forwards exact target, command, chunk callback and timeout to the native account stream", async () => {
  const chunks: Array<{ stream: string; chunk: string }> = [];
  const onChunk = (event: { stream: string; chunk: string }) => chunks.push(event);
  const result = { status: "SUCCESS", exitCode: 0, output: "native final" };
  let calls = 0;
  const account = new LightVelaAccountService({ storage: memoryStorage(),
    fetchImpl: async () => { throw new Error("an admitted native command must not be replayed through HTTP"); },
    runtimeCommands: { async execIfAvailable(botId, command, callback, options) {
      calls += 1;
      assert.equal(botId, "target/bot");
      assert.equal(command, "hermes -p 'main' logs --since 3h -n 100000");
      assert.equal(callback, onChunk);
      assert.equal(options?.timeoutMs, 120_000);
      assert.equal(options?.signal?.aborted, false);
      callback?.({ stream: "stdout", chunk: "first" });
      callback?.({ stream: "stderr", chunk: "second" });
      return result;
    } },
  });
  try {
    assert.equal(await streamAdapter(account)("target/bot", "hermes -p 'main' logs --since 3h -n 100000", onChunk), result);
    assert.equal(calls, 1);
    assert.deepEqual(chunks, [{ stream: "stdout", chunk: "first" }, { stream: "stderr", chunk: "second" }]);
  } finally { account.dispose(); }
});

test("diagnostics preserves the account SSE fallback, encoded target and streamed output", async () => {
  const chunks: Array<{ stream: string; chunk: string }> = [];
  let requests = 0;
  const account = new LightVelaAccountService({ storage: memoryStorage(), apiBase: "https://api.invalid", runtimeCommands: { async execIfAvailable() { return null; } },
    fetchImpl: async (input, init) => {
      requests += 1;
      assert.equal(String(input), "https://api.invalid/v1/instances/bot%2F2/debug/exec");
      assert.equal(init?.credentials, "include");
      assert.deepEqual(JSON.parse(String(init?.body)), { command: "logs-command", run_as_user: "agentuser" });
      assert.equal(new Headers(init?.headers).get("accept"), "text/event-stream");
      return new Response('event: stdout\ndata: {"type":"stdout","chunk":"first"}\n\nevent: stderr\ndata: {"type":"stderr","chunk":" second"}\n\nevent: finished\ndata: {"type":"finished","response":{"status":"SUCCESS","exit_code":0,"output":"first second"}}\n\n', { headers: { "Content-Type": "text/event-stream" } });
    },
  });
  try {
    assert.deepEqual(await streamAdapter(account)("bot/2", "logs-command", (event) => chunks.push(event)), { status: "SUCCESS", exitCode: 0, output: "first second" });
    assert.equal(requests, 1);
    assert.deepEqual(chunks, [{ stream: "stdout", chunk: "first" }, { stream: "stderr", chunk: " second" }]);
  } finally { account.dispose(); }
});

test("diagnostics retains account authority invalidation and the 120-second timeout", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  for (const cause of ["authority", "timeout"] as const) {
    let signal: AbortSignal | undefined;
    const runtimeCommands: LightVelaRuntimeCommandPort = { execIfAvailable(_botId, _command, _onChunk, options) {
      signal = options?.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }));
    } };
    const account = new LightVelaAccountService({ storage: memoryStorage(), runtimeCommands, fetchImpl: async () => { throw new Error("no HTTP replay"); } });
    try {
      const pending = streamAdapter(account)("bot-1", "logs", () => {});
      const rejected = assert.rejects(pending, cause === "timeout" ? /debug_exec_timeout:120000/ : { name: "AbortError" });
      assert.equal(signal?.aborted, false);
      if (cause === "authority") account.dispose();
      else {
        context.mock.timers.tick(119_999);
        assert.equal(signal?.aborted, false);
        context.mock.timers.tick(1);
      }
      assert.equal(signal?.aborted, true);
      await rejected;
    } finally { account.dispose(); }
  }
});
