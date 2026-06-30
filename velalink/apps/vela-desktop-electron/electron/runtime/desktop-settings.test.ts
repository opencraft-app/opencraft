import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  desktopSettingsPath,
  readDesktopSettings,
  writeDesktopSettings,
} from "./desktop-settings";

test("desktop settings default to no preferred backend", () => {
  const root = mkdtempSync(join(tmpdir(), "vela-desktop-settings-"));
  try {
    assert.deepEqual(readDesktopSettings(root), { defaultBackend: "" });
    assert.equal(desktopSettingsPath(root), join(root, "desktop-settings.json"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop settings persist default backend", () => {
  const root = mkdtempSync(join(tmpdir(), "vela-desktop-settings-"));
  try {
    assert.deepEqual(writeDesktopSettings(root, { defaultBackend: "vela_engine" }), {
      defaultBackend: "vela_engine",
    });
    assert.deepEqual(JSON.parse(readFileSync(desktopSettingsPath(root), "utf8")), {
      defaultBackend: "vela_engine",
    });
    assert.deepEqual(writeDesktopSettings(root, { defaultBackend: "acp" }), {
      defaultBackend: "acp",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop settings ignore unknown backend values", () => {
  const root = mkdtempSync(join(tmpdir(), "vela-desktop-settings-"));
  try {
    writeFileSync(desktopSettingsPath(root), '{"defaultBackend":"archived"}\n', "utf8");
    assert.deepEqual(readDesktopSettings(root), { defaultBackend: "" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
