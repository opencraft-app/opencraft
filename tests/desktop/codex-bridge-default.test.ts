import assert from "node:assert/strict";
import test from "node:test";
import { codexBridgeStackEnabled } from "../../apps/desktop/src/codex-bridge-default.ts";

test("macOS and Linux default to the Codex bridge stack, with an explicit way back", () => {
  for (const platform of ["darwin", "linux"] as const) {
    assert.equal(codexBridgeStackEnabled(platform, undefined), true);
    assert.equal(codexBridgeStackEnabled(platform, ""), true);
    assert.equal(codexBridgeStackEnabled(platform, "1"), true);
    assert.equal(codexBridgeStackEnabled(platform, "0"), false);
    assert.equal(codexBridgeStackEnabled(platform, " 0 "), false);
  }
});

test("Windows keeps the bridge stack opt-in", () => {
  assert.equal(codexBridgeStackEnabled("win32", undefined), false);
  assert.equal(codexBridgeStackEnabled("win32", "0"), false);
  assert.equal(codexBridgeStackEnabled("win32", "1"), true);
});
