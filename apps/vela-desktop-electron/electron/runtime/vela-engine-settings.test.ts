import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readVelaEngineSettings,
  velaEngineSettingsEnv,
  velaEngineSettingsPath,
  writeVelaEngineSettings,
} from "./vela-engine-settings";

test("vela engine settings default to empty local-only config", () => {
  const root = mkdtempSync(join(tmpdir(), "vela-engine-settings-"));
  try {
    assert.deepEqual(readVelaEngineSettings(root), {
      endpoint: "",
      apiKey: "",
      model: "",
    });
    assert.equal(velaEngineSettingsPath(root), join(root, "vela-engine-settings.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vela engine settings persist partial updates", () => {
  const root = mkdtempSync(join(tmpdir(), "vela-engine-settings-"));
  try {
    assert.deepEqual(
      writeVelaEngineSettings(root, {
        endpoint: " https://example.test/v1 ",
        model: "gpt-local",
      }),
      {
        endpoint: " https://example.test/v1 ",
        apiKey: "",
        model: "gpt-local",
      },
    );
    assert.deepEqual(writeVelaEngineSettings(root, { apiKey: "secret" }), {
      endpoint: " https://example.test/v1 ",
      apiKey: "secret",
      model: "gpt-local",
    });
    assert.deepEqual(JSON.parse(readFileSync(velaEngineSettingsPath(root), "utf8")), {
      endpoint: " https://example.test/v1 ",
      apiKey: "secret",
      model: "gpt-local",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("vela engine settings env only exports configured values", () => {
  assert.deepEqual(
    velaEngineSettingsEnv({
      endpoint: " https://example.test/v1 ",
      apiKey: " secret ",
      model: " gpt-local ",
    }),
    {
      VELAD_VELA_ENGINE_ENDPOINT: "https://example.test/v1",
      VELAD_VELA_ENGINE_API_KEY: "secret",
      VELAD_VELA_ENGINE_MODEL: "gpt-local",
    },
  );

  assert.deepEqual(
    velaEngineSettingsEnv({
      endpoint: "",
      apiKey: " ",
      model: "gpt-local",
    }),
    {
      VELAD_VELA_ENGINE_MODEL: "gpt-local",
    },
  );
});
