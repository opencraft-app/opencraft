import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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
  assert.ok(patched.includes('key: "sendPointer"'));
  assert.ok(patched.includes('key: "getInputCanvas"'));
  assert.ok(patched.includes('key: "setSurfaceActive"'));
  assert.ok(patched.includes('if (this._opencraftSurfaceActive === false || this._viewOnly) return;'));
  assert.ok(patched.includes('key: "_opencraftSyncCursor"'));
  assert.ok(patched.includes('if (this._opencraftPointerManaged) return;'));
  assert.throws(() => patchDesktopEvents(source, "1.6.0"));
  assert.throws(() => patchDesktopEvents(source + "// unknown edit", "1.5.0"));
  assert.throws(() => patchDesktopEvents(patched.replace('new CustomEvent("firstframe")', 'new CustomEvent("wrong")'), "1.5.0"));
  assert.throws(() => patchDesktopEvents(patched.replace('if (this._opencraftPointerManaged) return;', ''), "1.5.0"));
  assert.throws(() => patchDesktopEvents(patched.replace('if (this._opencraftSurfaceActive === false || this._viewOnly) return;', ''), "1.5.0"));
});

test("installed decoder cursor lifecycle projects activity and input eligibility without duplicate attachment state", () => {
  const source = readFileSync(new URL("../node_modules/@novnc/novnc/lib/rfb.js", import.meta.url), "utf8");
  // Exercise the reviewed installed implementation, not a copy of its logic.
  const start = source.indexOf('    key: "_opencraftSyncCursor",');
  const end = source.indexOf('  }, {\n    key: "setSurfaceActive",', start);
  assert.ok(start >= 0 && end > start);
  const sync = runInNewContext(`({${source.slice(start, end)}}).value`);
  const calls = [];
  const model = {
    _opencraftSurfaceActive: true, _viewOnly: true, _rfbConnectionState: "connected",
    _canvas: { isConnected: true, style: { cursor: "url(remote)" } },
    _cursor: {
      _target: null,
      _hideCursor() { calls.push("hide"); },
      detach() { calls.push("detach"); this._target = null; },
      attach(target) { calls.push("attach"); this._target = target; },
    },
    _refreshCursor() { calls.push("refresh"); this._canvas.style.cursor = "url(latest)"; },
  };
  sync.call(model);
  assert.deepEqual(calls.splice(0), ["hide", "detach"]);
  assert.equal(model._canvas.style.cursor, "auto");
  model._viewOnly = false;
  sync.call(model);
  assert.deepEqual(calls.splice(0), ["attach", "refresh"]);
  sync.call(model);
  assert.deepEqual(calls.splice(0), [], "repeated confirmation cannot clear an active cursor");
  for (const [object, key, invalid, valid] of [
    [model, "_viewOnly", true, false],
    [model, "_opencraftSurfaceActive", false, true],
    [model._canvas, "isConnected", false, true],
    [model, "_rfbConnectionState", "disconnecting", "connected"],
  ]) {
    object[key] = invalid; sync.call(model);
    assert.deepEqual(calls.splice(0), ["hide", "detach"]);
    assert.equal(model._cursor._target, null);
    assert.equal(model._canvas.style.cursor, "auto");
    object[key] = valid; sync.call(model);
    assert.deepEqual(calls.splice(0), ["attach", "refresh"]);
  }
});
