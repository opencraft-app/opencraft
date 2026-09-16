import assert from "node:assert/strict";
import test from "node:test";
import { LocalAgentSettingsService, type HostProtocolRequest } from "../plugins/builtin-agents/src/local-agent-settings-service.js";

function fixture() {
  const writes: any[] = [];
  const request = (async (_host: string, method: string, params: unknown) => {
    if (method === "runtime/settings/describe") return { writable: true, namespaces: [{ ns: "agent-default-model", revision: 3, value: { provider: "custom", model: "hy4-preview", reasoningEffort: "off" } }] };
    if (method === "runtime/models/list") return { groups: [{ id: "custom", models: [
      { id: "hy4-preview", name: "HY" },
      { id: "reasoner", name: "Reasoner", reasoning: { efforts: [{ id: "off", name: "Off" }, { id: "high", name: "High" }] } },
    ] }], failures: [] };
    if (method === "runtime/settings/mutate") { writes.push(params); return {}; }
    return {};
  }) as HostProtocolRequest;
  return { service: new LocalAgentSettingsService(request, "local"), writes };
}

test("model default unsets a previously stored effort in the same model mutation", async () => {
  const { service, writes } = fixture();
  await service.refresh();
  await service.saveDefaultModel("custom", "hy4-preview", undefined, 3);
  assert.deepEqual(writes, [{ ns: "agent-default-model", expectedRevision: 3, ops: [
    { op: "set", path: ["provider"], value: "custom" },
    { op: "set", path: ["model"], value: "hy4-preview" },
    { op: "unset", path: ["reasoningEffort"] },
  ] }]);
  service.dispose();
});

test("off is preserved only when explicitly supported, never treated as absence", async () => {
  const { service, writes } = fixture();
  await service.refresh();
  await assert.rejects(service.saveDefaultModel("custom", "hy4-preview", "off", 3), /does not support/);
  await assert.rejects(service.saveDefaultModel("custom", "reasoner", "medium", 3), /does not support/);
  assert.equal(writes.length, 0);
  await service.saveDefaultModel("custom", "reasoner", "off", 3);
  assert.deepEqual(writes[0].ops[2], { op: "set", path: ["reasoningEffort"], value: "off" });
  await service.saveDefaultModel("custom", "reasoner", undefined, 3);
  assert.deepEqual(writes[1].ops[2], { op: "unset", path: ["reasoningEffort"] });
  service.dispose();
});

test("an unavailable model cannot write settings", async () => {
  const { service, writes } = fixture();
  await service.refresh();
  await assert.rejects(service.saveDefaultModel("custom", "missing", undefined, 3), /unavailable/);
  assert.equal(writes.length, 0);
  service.dispose();
});
