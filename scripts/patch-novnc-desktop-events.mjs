import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A reviewed public event extension, not runtime access to noVNC internals.
// Keep npm's pinned decoder, encodings and render queue. Never infer first paint
// from canvas size/colour, arbitrary delay, or an independently parsed RFB stream.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = dirname(createRequire(resolve(root, "plugins/cloud-desktop/package.json"))
  .resolve("@novnc/novnc/package.json"));
const originalHash = "690d5506d161d6b8c536f9b1a5b018fcd510c72b4fcf8124d037005d18cff098";
const hash = source => createHash("sha256").update(source).digest("hex");
const mediaAndPointerEdits = [
  ['    key: "clipboardPasteFrom",', `    key: "setPointerInputManaged",
    value: function setPointerInputManaged(managed) { this._opencraftPointerManaged = managed === true; }
  }, {
    key: "getInputCanvas",
    value: function getInputCanvas() { return this._canvas; }
  }, {
    key: "sendPointer",
    value: function sendPointer(x, y, mask, clientX, clientY) {
      // Absolute framebuffer coordinates supplied by the adapter's single owner.
      if (!this._opencraftPointerManaged || this._viewOnly || this._rfbConnectionState !== 'connected') return;
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(mask) ||
          x < 0 || y < 0 || x >= this._fbWidth || y >= this._fbHeight || mask < 0 || mask > 127) return;
      RFB.messages.pointerEvent(this._sock, x, y, mask);
      // Preserve the decoder's touch/fallback cursor without native mouse writers.
      if (Number.isFinite(clientX) && Number.isFinite(clientY)) this._cursor.move(clientX, clientY);
    }
  }, {
    key: "clipboardPasteFrom",`],
  ['    value: function _sendMouse(x, y, mask) {', `    value: function _sendMouse(x, y, mask) {
      if (this._opencraftPointerManaged) return;`],
  ['    value: function _handleGesture(ev) {', `    value: function _handleGesture(ev) {
      if (this._opencraftPointerManaged) return;`],
  ["    key: \"clipboardPasteFrom\",", `    key: "clearClipboard",
    value: function clearClipboard() { this._clipboardText = null; }
  }, {
    key: "clipboardPasteFrom",`],
  ["        this._FBU.rects--;\n        this._FBU.encoding = null;", `        // OpenCraft: only completed pixel rectangles establish a real frame.
        if (this._FBU.encoding >= 0 && this._FBU.width > 0 && this._FBU.height > 0) {
          this._opencraftPixelsDecoded = true;
        }
        this._FBU.rects--;
        this._FBU.encoding = null;`],
  ["      this._display.flip();\n      return true; // We finished this FBU", `      this._display.flip();
      // OpenCraft: flush waits for queued image decoding AND visible-canvas flip.
      if (this._opencraftPixelsDecoded && !this._opencraftFirstFrameQueued) {
        this._opencraftFirstFrameQueued = true;
        this._display.flush().then(function () {
          if (_this6._rfbConnectionState === 'connected') {
            _this6.dispatchEvent(new CustomEvent("firstframe"));
          }
        });
      }
      return true; // We finished this FBU`],
  ["      if (this._clipboardServerCapabilitiesFormats[extendedClipboardFormatText] && this._clipboardServerCapabilitiesActions[extendedClipboardActionNotify]) {\n        this._clipboardText = text;", `      // OpenCraft: never silently replace Unicode text with question marks.
      if (!(this._clipboardServerCapabilitiesFormats[extendedClipboardFormatText] && this._clipboardServerCapabilitiesActions[extendedClipboardActionNotify]) && /[^\\x00-\\xff]/.test(text)) {
        throw new Error("Desktop clipboard encoding unavailable");
      }
      if (this._clipboardServerCapabilitiesFormats[extendedClipboardFormatText] && this._clipboardServerCapabilitiesActions[extendedClipboardActionNotify]) {
        this._clipboardText = text;`],
  ["        RFB.messages.clientCutText(this._sock, data);", `        RFB.messages.clientCutText(this._sock, data);
        // OpenCraft: ordered on the same stream, before any paste keys.
        this.dispatchEvent(new CustomEvent("clipboardready"));`],
  ["              RFB.messages.extendedClipboardProvide(this._sock, [extendedClipboardFormatText], [this._clipboardText]);", `              RFB.messages.extendedClipboardProvide(this._sock, [extendedClipboardFormatText], [this._clipboardText]);
              this.dispatchEvent(new CustomEvent("clipboardready"));`],
];
const surfaceEdits = [
  ['    key: "setPointerInputManaged",', `    key: "setSurfaceActive",
    value: function setSurfaceActive(active) {
      active = active === true;
      if (this._opencraftSurfaceActive === active) return;
      this._opencraftSurfaceActive = active;
      // The touch cursor is a body-level overlay: inert/clip of the media cannot
      // retire it. Detach its listeners and overlay, without closing the stream.
      this._cursor._hideCursor();
      this._cursor.detach();
      if (active && this._canvas.isConnected &&
          (this._rfbConnectionState === 'connecting' || this._rfbConnectionState === 'connected')) {
        this._cursor.attach(this._canvas);
        this._refreshCursor();
      }
    }
  }, {
    key: "setPointerInputManaged",`],
  ['      this._cursor.attach(this._canvas);\n      this._refreshCursor();', `      if (this._opencraftSurfaceActive !== false) {
        this._cursor.attach(this._canvas);
        this._refreshCursor();
      }`],
  ['    value: function _refreshCursor() {', `    value: function _refreshCursor() {
      // Keep the latest decoded shape, but never resurrect a hidden overlay.
      if (this._opencraftSurfaceActive === false) return;`],
  ["      if (!this._opencraftPointerManaged || this._viewOnly || this._rfbConnectionState !== 'connected') return;",
    "      if (!this._opencraftPointerManaged || this._opencraftSurfaceActive === false || this._viewOnly || this._rfbConnectionState !== 'connected') return;"],
];
const controlCursorEdits = [
  ['    key: "setSurfaceActive",', `    key: "_opencraftSyncCursor",
    value: function _opencraftSyncCursor() {
      // viewOnly is the adapter's existing input-grant projection. Cursor is
      // local control feedback, not a second grant or a media-pixel mutation.
      var eligible = this._opencraftSurfaceActive !== false && !this._viewOnly &&
        this._canvas.isConnected &&
        (this._rfbConnectionState === 'connecting' || this._rfbConnectionState === 'connected');
      if (!eligible) {
        this._cursor._hideCursor();
        this._cursor.detach();
        this._canvas.style.cursor = 'auto';
        return;
      }
      // Cursor owns attachment identity: do not clear/recreate it on every
      // repeated readiness/enable notification or while a pointer is held.
      if (this._cursor._target !== this._canvas) {
        this._cursor.attach(this._canvas);
        this._refreshCursor();
      }
    }
  }, {
    key: "setSurfaceActive",`],
  [`      // The touch cursor is a body-level overlay: inert/clip of the media cannot
      // retire it. Detach its listeners and overlay, without closing the stream.
      this._cursor._hideCursor();
      this._cursor.detach();
      if (active && this._canvas.isConnected &&
          (this._rfbConnectionState === 'connecting' || this._rfbConnectionState === 'connected')) {
        this._cursor.attach(this._canvas);
        this._refreshCursor();
      }`, '      this._opencraftSyncCursor();'],
  [`      this._gestures.attach(this._canvas);
      if (this._opencraftSurfaceActive !== false) {
        this._cursor.attach(this._canvas);
        this._refreshCursor();
      }`, '      this._gestures.attach(this._canvas);\n      this._opencraftSyncCursor();'],
  ['      this._viewOnly = viewOnly;', `      this._viewOnly = viewOnly;
      this._opencraftSyncCursor();`],
  ['      if (this._opencraftSurfaceActive === false) return;',
    '      if (this._opencraftSurfaceActive === false || this._viewOnly) return;'],
];
const mediaPauseEdits = [
  ['    key: "setSurfaceActive",', `    key: "_opencraftRequestFrame",
    value: function _opencraftRequestFrame(incremental) {
      if (this._opencraftSurfaceActive === false || this._opencraftFramePending) return;
      this._opencraftFramePending = true;
      RFB.messages.fbUpdateRequest(this._sock, incremental, 0, 0, this._fbWidth, this._fbHeight);
    }
  }, {
    key: "setSurfaceActive",`],
  ['      this._opencraftSurfaceActive = active;', `      this._opencraftSurfaceActive = active;
      // Pause at the producer protocol: do not keep decoding invisible pixels.
      // A frame already in flight is allowed to finish; never corrupt the stream.
      if (this._rfbConnectionState === 'connected') {
        if (!active && this._enabledContinuousUpdates) {
          this._enabledContinuousUpdates = false;
          this._opencraftAwaitingContinuousEnd = true;
          RFB.messages.enableContinuousUpdates(this._sock, false, 0, 0, this._fbWidth, this._fbHeight);
        } else if (active && !this._opencraftAwaitingContinuousEnd) {
          if (this._supportsContinuousUpdates) {
            this._enabledContinuousUpdates = true;
            this._updateContinuousUpdates();
          } else {
            this._opencraftRequestFrame(false);
          }
        }
      }`],
  ['      this._sendEncodings();\n      RFB.messages.fbUpdateRequest(this._sock, false, 0, 0, this._fbWidth, this._fbHeight);',
   '      this._sendEncodings();\n      this._opencraftRequestFrame(false);'],
  [`          if (ret && !this._enabledContinuousUpdates) {
            RFB.messages.fbUpdateRequest(this._sock, true, 0, 0, this._fbWidth, this._fbHeight);
          }`, `          if (ret) {
            this._opencraftFramePending = false;
            if (!this._enabledContinuousUpdates && !this._opencraftAwaitingContinuousEnd) this._opencraftRequestFrame(true);
          }`],
  [`          if (first) {
            this._enabledContinuousUpdates = true;
            this._updateContinuousUpdates();
            Log.Info("Enabling continuous updates.");
          } else {
            // FIXME: We need to send a framebufferupdaterequest here
            // if we add support for turning off continuous updates
          }`, `          this._opencraftAwaitingContinuousEnd = false;
          if (this._opencraftSurfaceActive !== false) {
            this._enabledContinuousUpdates = true;
            this._updateContinuousUpdates();
            if (first) Log.Info("Enabling continuous updates.");
          }`],
];
const edits = [...mediaAndPointerEdits, ...surfaceEdits, ...controlCursorEdits, ...mediaPauseEdits];

export function patchDesktopEvents(source, version) {
  if (version !== "1.5.0") throw new Error("Review the noVNC desktop event patch before upgrading");
  // npm's Babel file has no final newline; tolerate only that packaging detail.
  source = source.replace(/\n$/, "");
  // Reverse all known additions to verify both pristine and already-patched files.
  let original = source;
  for (const [before, after] of [...edits].reverse()) original = original.replace(after, before);
  if (hash(original) !== originalHash) throw new Error("noVNC source differs from the reviewed desktop decoder");
  let patched = original;
  for (const [before, after] of edits) {
    if (patched.split(before).length !== 2) throw new Error("noVNC desktop patch anchor changed");
    patched = patched.replace(before, after);
  }
  // Only complete previous generations can upgrade in place. Do not accept
  // arbitrary subsets of pointer, surface or control-cursor lifecycle changes.
  let legacy = original;
  for (const [before, after] of mediaAndPointerEdits.slice(3)) legacy = legacy.replace(before, after);
  let previous = original;
  for (const [before, after] of mediaAndPointerEdits) previous = previous.replace(before, after);
  let surfaceGeneration = previous;
  for (const [before, after] of surfaceEdits) surfaceGeneration = surfaceGeneration.replace(before, after);
  let controlGeneration = surfaceGeneration;
  for (const [before, after] of controlCursorEdits) controlGeneration = controlGeneration.replace(before, after);
  if (source !== controlGeneration && source !== original && source !== patched && source !== legacy && source !== previous && source !== surfaceGeneration) throw new Error("Incomplete noVNC desktop event patch");
  return patched;
}

// Cursor.move is used by touch/managed input, whereas native mouse movement
// already subtracts the decoded hotspot. Both must position the same image
// hotspot at the input point; the framebuffer coordinates stay untouched.
const cursorHash = "757f13a67d409d87ec4ff8129343b3bc230a8b9215cde1a51603c422b18af631";
const cursorAnchor = "      this._updatePosition();\n      var target = document.elementFromPoint(clientX, clientY);";
const cursorProjection = "      this._position.x -= this._hotSpot.x;\n      this._position.y -= this._hotSpot.y;\n" + cursorAnchor;
export function patchCursorHotspot(source, version) {
  if (version !== "1.5.0") throw new Error("Review the noVNC cursor patch before upgrading");
  source = source.replace(/\n$/, "");
  const original = source.replace(cursorProjection, cursorAnchor);
  if (hash(original) !== cursorHash) throw new Error("noVNC source differs from the reviewed cursor");
  if (original.split(cursorAnchor).length !== 2) throw new Error("noVNC cursor patch anchor changed");
  return original.replace(cursorAnchor, cursorProjection);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const file = resolve(packageRoot, "lib/rfb.js");
  const source = readFileSync(file, "utf8");
  const patched = patchDesktopEvents(source, version);
  if (source !== patched) writeFileSync(file, patched);
  const cursorFile = resolve(packageRoot, "lib/util/cursor.js");
  const cursorSource = readFileSync(cursorFile, "utf8");
  const patchedCursor = patchCursorHotspot(cursorSource, version);
  if (cursorSource !== patchedCursor) writeFileSync(cursorFile, patchedCursor);
  console.log(`noVNC ${version}: reviewed desktop events, managed pointer port and cursor hotspot verified`);
}
