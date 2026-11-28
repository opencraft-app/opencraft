import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUsageMachineOptions,
  sanitizeEndpointDetail,
} from "../../apps/workbench-web/src/components/agent-usage-machines.ts";

test("sanitizeEndpointDetail strips scheme, userinfo, query, and hash without leaking tokens", () => {
  assert.equal(
    sanitizeEndpointDetail("wss://user:secret-pass@dev.example.com:10100/rpc?token=topsecret#frag"),
    "dev.example.com:10100/rpc",
  );
  assert.equal(
    sanitizeEndpointDetail("https://join.woa.com/servers/mason/?session=abc"),
    "join.woa.com/servers/mason",
  );
  assert.equal(
    sanitizeEndpointDetail("admin:pw@10.0.0.8:8080/ws?api_key=123#top"),
    "10.0.0.8:8080/ws",
  );
  assert.equal(sanitizeEndpointDetail("   "), null);
  assert.equal(sanitizeEndpointDetail(null), null);
});

test("buildUsageMachineOptions disambiguates duplicate names, reflects connection phase, and skips disabled hosts", () => {
  const machines = buildUsageMachineOptions({
    hosts: [
      { hostId: "local", kind: "local", label: "Local Host" },
      { hostId: "remote-a", kind: "remote", label: "Remote A" },
      { hostId: "remote-b", kind: "remote", label: "Remote B" },
      { hostId: "disabled-c", kind: "remote", label: "Disabled C" },
    ],
    profiles: [
      {
        hostId: "local",
        enabled: true,
        displayName: "Local",
        transportEndpoint: null,
        executionLocation: null,
        machineIdentity: null,
      },
      {
        hostId: "remote-a",
        enabled: true,
        displayName: "Mason Dev A",
        transportEndpoint: "wss://user:pass@9.135.102.192:10100/rpc?token=secret",
        executionLocation: "shanghai",
        machineIdentity: { name: "Mason 开发机" },
      },
      {
        hostId: "remote-b",
        enabled: true,
        displayName: "Mason Dev B",
        transportEndpoint: "https://join.woa.com/servers/mason?token=hidden",
        executionLocation: null,
        machineIdentity: { name: "Mason 开发机" },
      },
      {
        hostId: "disabled-c",
        enabled: false,
        displayName: "Disabled",
        transportEndpoint: "https://disabled.example.com",
        executionLocation: null,
        machineIdentity: { name: "Disabled" },
      },
    ],
    getPhase: (hostId) => (hostId === "remote-b" ? "reconnecting" : "ready"),
    localFallbackLabel: "Local",
  });

  assert.deepEqual(machines, [
    {
      hostId: "local",
      label: "Local",
      remote: false,
      connected: true,
      detail: "local",
    },
    {
      hostId: "remote-a",
      label: "Mason 开发机",
      remote: true,
      connected: true,
      detail: "9.135.102.192:10100/rpc",
    },
    {
      hostId: "remote-b",
      label: "Mason 开发机",
      remote: true,
      connected: false,
      detail: "join.woa.com/servers/mason",
    },
  ]);
});
