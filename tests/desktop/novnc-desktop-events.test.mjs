import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { patchCursorHotspot, patchDesktopEvents } from "../../scripts/patch-novnc-desktop-events.mjs";

const novncRoot = dirname(createRequire(new URL("../../plugins/cloud-desktop/package.json", import.meta.url))
  .resolve("@novnc/novnc/package.json"));

test("pinned decoder event patch is complete, idempotent and refuses unreviewed sources", () => {
  const source = readFileSync(join(novncRoot, "lib/rfb.js"), "utf8");
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
  const source = readFileSync(join(novncRoot, "lib/rfb.js"), "utf8");
  // Exercise the reviewed installed implementation, not a copy of its logic.
  const start = source.indexOf('    key: "_opencraftSyncCursor",');
  const end = source.indexOf('  }, {', start);
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

test("installed media lifecycle pauses producer requests and fences rapid continuous-update toggles", () => {
  const source = readFileSync(join(novncRoot, "lib/rfb.js"), "utf8");
  const calls = [];
  const globals = { RFB: { messages: {
    fbUpdateRequest: (_socket, incremental) => calls.push(["frame", incremental]),
    enableContinuousUpdates: (_socket, enabled) => calls.push(["continuous", enabled]),
  } } };
  const method = name => {
    const start = source.indexOf(`    key: "${name}",`);
    const end = source.indexOf('  }, {', start);
    assert.ok(start >= 0 && end > start);
    return runInNewContext(`({${source.slice(start, end)}}).value`, globals);
  };
  const model = { _rfbConnectionState: "connected", _opencraftSurfaceActive: true,
    _supportsContinuousUpdates: false, _enabledContinuousUpdates: false,
    _opencraftSyncCursor() {}, _updateContinuousUpdates() { calls.push(["enable"]); },
    _opencraftRequestFrame: method("_opencraftRequestFrame"),
  };
  const setActive = method("setSurfaceActive");
  setActive.call(model, false);
  model._opencraftRequestFrame(true);
  assert.deepEqual(calls, []);
  setActive.call(model, true);
  assert.deepEqual(calls.splice(0), [["frame", false]]);
  setActive.call(model, false); setActive.call(model, true);
  assert.deepEqual(calls, [], "a pending framebuffer is not requested twice");
  model._supportsContinuousUpdates = true;
  model._enabledContinuousUpdates = true;
  setActive.call(model, false);
  assert.deepEqual(calls.splice(0), [["continuous", false]]);
  setActive.call(model, true);
  assert.deepEqual(calls, [], "wait for EndOfContinuousUpdates before enabling a successor");
  model._opencraftAwaitingContinuousEnd = false;
  setActive.call(model, false); setActive.call(model, true);
  assert.deepEqual(calls, [["enable"]]);
});


test("pinned cursor hotspot patch is installed, idempotent and refuses unknown or partial changes", () => {
  const source = readFileSync(join(novncRoot, "lib/util/cursor.js"), "utf8");
  assert.equal(patchCursorHotspot(source, "1.5.0"), source);
  const original = source.replace("      this._position.x -= this._hotSpot.x;\n      this._position.y -= this._hotSpot.y;\n", "");
  assert.notEqual(original, source);
  assert.equal(patchCursorHotspot(original, "1.5.0"), source);
  assert.throws(() => patchCursorHotspot(source, "1.6.0"));
  assert.throws(() => patchCursorHotspot(source + "// unknown edit", "1.5.0"));
  assert.throws(() => patchCursorHotspot(source.replace("      this._position.y -= this._hotSpot.y;\n", ""), "1.5.0"));
});

test("managed touch cursor renders its decoded hotspot at the sent client point", () => {
  const source = readFileSync(join(novncRoot, "lib/util/cursor.js"), "utf8");
  const start = source.indexOf('    key: "move",');
  const end = source.indexOf('  }, {', start);
  assert.ok(start >= 0 && end > start);
  for (const viewport of [undefined, { offsetLeft: 15, offsetTop: 37 }]) {
    const hitTests = [];
    const move = runInNewContext(`({${source.slice(start, end)}}).value`, {
      useFallback: true, window: { visualViewport: viewport },
      document: { elementFromPoint: (x, y) => { hitTests.push([x, y]); return null; } },
    });
    const model = { _position: {}, _hotSpot: { x: 0, y: 0 }, _updatePosition() {}, _updateVisibility() {} };
    for (const hotspot of [{ x: 0, y: 0 }, { x: 7, y: 13 }, { x: 3, y: 21 }]) {
      model._hotSpot = hotspot; move.call(model, 100, 200);
      assert.equal(model._position.x + hotspot.x, 100 + (viewport?.offsetLeft ?? 0));
      assert.equal(model._position.y + hotspot.y, 200 + (viewport?.offsetTop ?? 0));
      assert.deepEqual(hitTests.at(-1), [100, 200], "hit testing remains in the original client coordinate space");
    }
  }
});
