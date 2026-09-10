import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MemoryTransport } from "@opencraft/appserver-transport-memory";
import { preflightHostConnection, type HostConnectionProvider } from "@opencraft/workbench-runtime";

const context = { platform: "electron", hostId: "test", profileRevision: 0 } as const;
function fixture(mode: "ok" | "invalid" | "silent" | "reject") {
  const methods: string[] = [];
  const transport = new MemoryTransport({
    connected() { if (mode === "reject") throw new Error("Connection refused"); },
    receive(frame, peer) {
      const request = JSON.parse(frame);
      methods.push(request.method);
      if (mode !== "silent") peer.send(JSON.stringify({ id: request.id, result: mode === "ok" ? { userAgent: "test-server" } : {} }));
    },
  });
  const provider: HostConnectionProvider = { id: "test", label: "Test", configVersion: 1,
    targets: ["electron"], validate: c => c, createTransport: () => transport };
  return { transport, methods, provider };
}
test("preflight performs initialize and disposes without creating domain resources", async () => {
  const f = fixture("ok");
  await preflightHostConnection(f.provider, {}, context);
  assert.deepEqual(f.methods, ["initialize"]);
  assert.equal(f.transport.status.state, "closed");
});
test("provider-owned preflight verifies control-plane state without allocating a physical transport", async () => {
  let preflightCalls = 0;
  const provider: HostConnectionProvider = {
    id: "control-plane",
    label: "Control plane",
    configVersion: 1,
    targets: ["electron"],
    validate: value => value,
    preflight(config, receivedContext, { signal }) {
      preflightCalls += 1;
      assert.deepEqual(config, { binding: "bot-1" });
      assert.equal(receivedContext, context);
      assert.equal(signal.aborted, false);
    },
    createTransport() {
      throw new Error("provider-owned preflight must not allocate a physical transport");
    },
  };
  await preflightHostConnection(provider, { binding: "bot-1" }, context);
  assert.equal(preflightCalls, 1);
});
for (const mode of ["invalid", "silent", "reject"] as const) {
  test(`preflight rejects ${mode} endpoint and closes the transport`, async () => {
    const f = fixture(mode);
    await assert.rejects(preflightHostConnection(f.provider, {}, context, { timeoutMs: 20 }), /Connection verification failed/);
    assert.equal(f.transport.status.state, "closed");
  });
}
test("preflight cancellation releases its temporary connection", async () => {
  const f = fixture("silent"); const abort = new AbortController();
  const pending = preflightHostConnection(f.provider, {}, context, { signal: abort.signal });
  abort.abort(); await assert.rejects(pending);
  assert.equal(f.transport.status.state, "closed");
});
test("provisioning verifies before persisting, while holding the provider lease", () => {
  const source = readFileSync(new URL("../apps/workbench-web/src/runtime/appserver-runtime-context.tsx", import.meta.url), "utf8");
  const provision = source.slice(source.indexOf("async function persistProvisionedHost("), source.indexOf("function provisionWebSocketHost("));
  const probe = provision.indexOf("await preflightHostConnection(");
  assert.ok(probe > 0 && probe < provision.indexOf("providerLease.release()"));
  assert.ok(probe < provision.indexOf("await hostProfiles.put(profile)"));
});
