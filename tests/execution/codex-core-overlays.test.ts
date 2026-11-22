import assert from "node:assert/strict";
import test from "node:test";
import { codexCoreOptions } from "../../apps/opencraft-daemon/src/main.ts";

test("the daemon's Codex Host passes through to Core unless overlays are asked for explicitly", () => {
  assert.deepEqual(codexCoreOptions({ authToken: "t" }), { coreEndpoint: undefined, coreAuthToken: "t" });
  assert.deepEqual(codexCoreOptions({ codexCoreEndpoint: "/core.sock", authToken: "t" }), {
    coreEndpoint: "/core.sock",
    coreAuthToken: "t",
  });
  assert.deepEqual(codexCoreOptions({ codexCoreEndpoint: "/core.sock", codexCoreHostOverlays: true, authToken: "t" }), {
    coreEndpoint: "/core.sock",
    coreAuthToken: "t",
    coreHostOverlays: true,
  });
  assert.throws(
    () => codexCoreOptions({ codexCoreHostOverlays: true, authToken: "t" }),
    /require a Codex Core endpoint/u,
  );
});
