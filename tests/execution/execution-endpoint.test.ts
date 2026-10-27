import assert from "node:assert/strict";
import test from "node:test";
import { executionEndpoint } from "../../apps/workbench-web/src/components/execution-endpoint";

const base = "https://workbench.example.invalid/settings/execution-demo";
const privateAddress = "wss://demo-user:demo-password@example.invalid/rpc?token=demo-token#demo-fragment";

test("configuration URL and provider fallback expose only the public connection address", () => {
  for (const profile of [
    { providerConfig: { url: privateAddress }, transportEndpoint: "Server" },
    { providerConfig: { instanceId: "demo" }, transportEndpoint: privateAddress },
  ]) assert.equal(executionEndpoint(profile, base), "wss://example.invalid/rpc");
});

test("relative connection URLs redact authentication parameters on both paths", () => {
  for (const profile of [
    { providerConfig: { url: "/codex-appserver?token=demo-token#demo" }, transportEndpoint: null },
    { providerConfig: {}, transportEndpoint: "/codex-appserver?token=demo-token#demo" },
  ]) assert.equal(executionEndpoint(profile, base), "wss://workbench.example.invalid/codex-appserver");
});

test("native transport labels and missing addresses remain understandable", () => {
  assert.equal(executionEndpoint({ providerConfig: {}, transportEndpoint: "OpenCraft Daemon" }, base), "OpenCraft Daemon");
  assert.equal(executionEndpoint({ providerConfig: {}, transportEndpoint: null }, base), "由宿主提供");
});


test("every relative fallback form redacts query and fragment credentials", () => {
  for (const endpoint of ["./rpc?token=synthetic-secret#private", "../rpc?token=synthetic-secret#private", "rpc?token=synthetic-secret#private", "rpc#synthetic-secret"]) {
    const result = executionEndpoint({ providerConfig: { instanceId: "demo" }, transportEndpoint: endpoint }, base);
    assert.equal(result.includes("synthetic-secret"), false);
    assert.equal(result.includes("?"), false);
    assert.equal(result.includes("#"), false);
    assert.equal(result.startsWith("wss://workbench.example.invalid/"), true);
  }
});
