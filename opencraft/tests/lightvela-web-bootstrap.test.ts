import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureBrowserProcessEnv,
  resolveLightVelaWebBootstrapOptions,
} from "../apps/workbench-web/src/runtime/lightvela-web-bootstrap";

test("LightVela Web bootstrap projects the explicit Beijing account authority", () => {
  assert.deepEqual(resolveLightVelaWebBootstrapOptions({
    VITE_LIGHTVELA_API_BASE_URL: "https://lightclaw.tech/",
    VITE_LIGHTVELA_REGION: "cn",
  }), {
    lightVelaApiBase: "https://lightclaw.tech",
    lightVelaRegion: "cn",
  });
});

test("LightVela Web bootstrap leaves account defaults untouched without overrides", () => {
  assert.deepEqual(resolveLightVelaWebBootstrapOptions({}), {});
});

test("LightVela Web bootstrap rejects an invalid region", () => {
  assert.throws(
    () => resolveLightVelaWebBootstrapOptions({ VITE_LIGHTVELA_REGION: "beijing" }),
    /VITE_LIGHTVELA_REGION/u,
  );
});

test("LightVela Web bootstrap rejects a non-HTTP API authority", () => {
  assert.throws(
    () => resolveLightVelaWebBootstrapOptions({
      VITE_LIGHTVELA_API_BASE_URL: "javascript:alert(1)",
    }),
    /VITE_LIGHTVELA_API_BASE_URL/u,
  );
});

test("standalone Web installs process.env without replacing a host-owned process", () => {
  const emptyTarget: { process?: { env?: Record<string, unknown> } } = {};
  ensureBrowserProcessEnv(emptyTarget);
  assert.deepEqual(emptyTarget.process, { env: {} });

  const existingProcess = { env: { HOST_VALUE: "kept" } };
  const existingTarget = { process: existingProcess };
  ensureBrowserProcessEnv(existingTarget);
  assert.equal(existingTarget.process, existingProcess);
  assert.equal(existingTarget.process.env.HOST_VALUE, "kept");
});
