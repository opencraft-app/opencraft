import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// A reviewed public event extension, not runtime access to noVNC internals.
// Keep npm's pinned decoder, encodings and render queue. Never infer first paint
// from canvas size/colour, arbitrary delay, or an independently parsed RFB stream.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = resolve(root, "node_modules/@novnc/novnc");
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
const edits = [...mediaAndPointerEdits, ...surfaceEdits, ...controlCursorEdits];

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
  if (source !== original && source !== patched && source !== legacy && source !== previous && source !== surfaceGeneration) throw new Error("Incomplete noVNC desktop event patch");
  return patched;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const file = resolve(packageRoot, "lib/rfb.js");
  const source = readFileSync(file, "utf8");
  const patched = patchDesktopEvents(source, version);
  if (source !== patched) writeFileSync(file, patched);
  console.log(`noVNC ${version}: reviewed desktop events and managed pointer port verified`);
}
