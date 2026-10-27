import assert from "node:assert/strict";
import test from "node:test";
import type { AppServerRequestLifecycleEvent } from "@opencraft/appserver-client";
import { installAppServerDiagnostics } from "../../apps/workbench-web/src/runtime/appserver-diagnostics";

test("diagnostics correlate colliding clients without exposing protocol payloads and release ownership", () => {
  const entries: unknown[] = [];
  const listeners = new Set<(event: AppServerRequestLifecycleEvent) => void>();
  const client = { connectionGeneration: 2, subscribeRequestLifecycle(listener: (event: AppServerRequestLifecycleEvent) => void) {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } };
  const write = (event: string, metadata: Record<string, unknown>) => entries.push({ event, ...metadata });
  const stopProbe = installAppServerDiagnostics(client, "identity-probe", write);
  const stopRuntime = installAppServerDiagnostics(client, "runtime", write);
  const started = { type: "started", hostId: "test-host", id: "test-host:1", method: "initialize", priority: "user-blocking",
    startedAtMs: 0, queueWaitMs: 0, params: { token: "secret-params" }, timeoutMs: 3000 } as const;
  for (const listener of listeners) listener(started);
  assert.equal(entries.filter((entry: any) => entry.event === "request-id-collision").length, 1);
  for (const listener of listeners) listener({ ...started, type: "failed", endedAtMs: 5, durationMs: 5,
    error: Object.assign(new Error("secret-error-message"), { code: -32600 }) });
  assert.doesNotMatch(JSON.stringify(entries), /secret-/);
  stopProbe(); stopRuntime();
  assert.equal(listeners.size, 0);
  entries.length = 0;
  const stop = installAppServerDiagnostics(client, "runtime", write);
  for (const listener of listeners) listener(started);
  assert.equal(entries.filter((entry: any) => entry.event === "request-id-collision").length, 0);
  stop();
});

test("repeated failure diagnostics are bounded per client", () => {
  let receive: (event: AppServerRequestLifecycleEvent) => void = () => {};
  let count = 0;
  const stop = installAppServerDiagnostics({ connectionGeneration: 0, subscribeRequestLifecycle(listener) { receive = listener; return () => {}; } },
    "runtime", () => { count++; });
  for (let i = 0; i < 100; i++) receive({ type: "late-response", hostId: "bounded-host", id: i, receivedAtMs: i });
  assert.equal(count, 20);
  stop();
});
