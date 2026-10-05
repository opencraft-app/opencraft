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
const edits = [
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

export function patchDesktopEvents(source, version) {
  if (version !== "1.5.0") throw new Error("Review the noVNC desktop event patch before upgrading");
  // npm's Babel file has no final newline; tolerate only that packaging detail.
  source = source.replace(/\n$/, "");
  // Reverse all known additions to verify both pristine and already-patched files.
  let original = source;
  for (const [before, after] of edits) original = original.replace(after, before);
  if (hash(original) !== originalHash) throw new Error("noVNC source differs from the reviewed desktop decoder");
  let patched = original;
  for (const [before, after] of edits) {
    if (patched.split(before).length !== 2) throw new Error("noVNC desktop patch anchor changed");
    patched = patched.replace(before, after);
  }
  if (source !== original && source !== patched) throw new Error("Incomplete noVNC desktop event patch");
  return patched;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { version } = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  const file = resolve(packageRoot, "lib/rfb.js");
  const source = readFileSync(file, "utf8");
  const patched = patchDesktopEvents(source, version);
  if (source !== patched) writeFileSync(file, patched);
  console.log(`noVNC ${version}: reviewed firstframe/clipboardready events verified`);
}
