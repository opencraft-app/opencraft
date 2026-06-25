import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

test("desktop host grants microphone capture through Electron media permissions", () => {
  const main = readFileSync(
    join(root, "apps/vela-desktop-electron/electron/main.ts"),
    "utf8",
  );

  assert.match(main, /setPermissionRequestHandler/);
  assert.match(main, /setPermissionCheckHandler/);
  assert.match(main, /permission !== "media"/);
  assert.match(main, /mediaTypes\.includes\("audio"\)/);
});

test("macOS package declares microphone entitlement and usage text", () => {
  const builderConfig = readFileSync(
    join(root, "apps/vela-desktop-electron/electron-builder.yml"),
    "utf8",
  );
  const entitlements = readFileSync(
    join(root, "apps/vela-desktop-electron/build/entitlements.mac.plist"),
    "utf8",
  );
  const inheritedEntitlements = readFileSync(
    join(root, "apps/vela-desktop-electron/build/entitlements.mac.inherit.plist"),
    "utf8",
  );

  assert.match(builderConfig, /entitlements: build\/entitlements\.mac\.plist/);
  assert.match(builderConfig, /entitlementsInherit: build\/entitlements\.mac\.inherit\.plist/);
  assert.match(builderConfig, /NSMicrophoneUsageDescription:/);
  assert.match(entitlements, /com\.apple\.security\.device\.audio-input/);
  assert.match(inheritedEntitlements, /com\.apple\.security\.device\.audio-input/);
});
