import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { patchDesktopEvents } from "../scripts/patch-novnc-desktop-events.mjs";

test("pinned decoder event patch is complete, idempotent and refuses unreviewed sources", () => {
  const source = readFileSync(new URL("../node_modules/@novnc/novnc/lib/rfb.js", import.meta.url), "utf8");
  const patched = patchDesktopEvents(source, "1.5.0");
  assert.equal(source, patched, "installed decoder must contain the reviewed events before verification/build");
  assert.equal(patchDesktopEvents(patched, "1.5.0"), patched);
  assert.ok(patched.includes('new CustomEvent("firstframe")'));
  assert.ok(patched.includes("this._opencraftPixelsDecoded = true;"));
  assert.ok(patched.includes('new CustomEvent("clipboardready")'));
  assert.ok(patched.includes('key: "clearClipboard"'));
  assert.throws(() => patchDesktopEvents(source, "1.6.0"));
  assert.throws(() => patchDesktopEvents(source + "// unknown edit", "1.5.0"));
  assert.throws(() => patchDesktopEvents(patched.replace('new CustomEvent("firstframe")', 'new CustomEvent("wrong")'), "1.5.0"));
});
