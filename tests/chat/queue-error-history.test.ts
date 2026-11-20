import assert from "node:assert/strict";
import test from "node:test";
import { createQueueErrorHistory } from "../../apps/workbench-web/src/runtime/queue-error-history";

test("queue errors persist without detailed diagnostics and are bounded and scrubbed", () => {
  let raw: string | null = null;
  const storage = () => ({ getItem: () => raw, setItem: (_key: string, value: string) => { raw = value; } });
  const history = createQueueErrorHistory(storage, () => 1000);
  for (let i = 0; i < 120; i++) history.record({ action: "steer", rpcCode: -32600, reason: "queue-unavailable", input: "secret", token: "secret" });
  const restored = createQueueErrorHistory(storage, () => 1001).capture();
  assert.equal(restored.samples.length, 100);
  assert.equal(restored.persisted, true);
  assert.equal(JSON.stringify(restored).includes("secret"), false);
  assert.equal(restored.samples[0].fields.action, "steer");
  assert.ok(new TextEncoder().encode(raw!).length <= restored.byteLimit);
  assert.equal(createQueueErrorHistory(storage, () => 8 * 86400000).capture().samples.length, 0);
});
test("blocked or corrupt storage falls back to memory without throwing", () => {
  const blocked = createQueueErrorHistory(() => { throw new Error("denied"); });
  blocked.record({ action: "steer" });
  assert.equal(blocked.capture().samples.length, 1);
  assert.equal(blocked.capture().persisted, false);
  const corrupt = createQueueErrorHistory(() => ({ getItem: () => "broken", setItem: () => {} }));
  assert.equal(corrupt.capture().samples.length, 0);
});
