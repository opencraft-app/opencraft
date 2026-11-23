import assert from "node:assert/strict";
import test from "node:test";
import { codexBridgeStackEnabled } from "../../apps/desktop/src/codex-bridge-default.ts";

test("every desktop platform defaults to the Codex bridge stack, with an explicit way back", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    assert.equal(codexBridgeStackEnabled(platform, undefined), true);
    assert.equal(codexBridgeStackEnabled(platform, ""), true);
    assert.equal(codexBridgeStackEnabled(platform, "1"), true);
    assert.equal(codexBridgeStackEnabled(platform, "0"), false);
    assert.equal(codexBridgeStackEnabled(platform, " 0 "), false);
  }
});
