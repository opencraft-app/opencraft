import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../packages/codex-composer/src/codex-composer.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("../packages/codex-composer/src/attachment-preview-session.ts", import.meta.url), "utf8");
const append = source.slice(source.indexOf("  const appendFiles ="), source.indexOf("  const openAttachmentPicker ="));

test("attachment input restores editor focus synchronously, never on upload settlement", () => {
  const asyncStart = append.indexOf("attachmentSession.addFiles(files, onResolveAttachment)");
  const asyncEnd = append.indexOf("// Focus belongs to the initiating interaction");
  assert.ok(asyncStart > 0 && asyncEnd > asyncStart);
  assert.doesNotMatch(append.slice(asyncStart, asyncEnd), /\.focus\(/);
  assert.match(append.slice(asyncEnd), /view\.focus\(\)/);
  assert.match(sessionSource, /void Promise\.resolve\(\)\.then\(\(\) => resolve\(/);
  assert.doesNotMatch(sessionSource, /\.focus\(/);
  assert.doesNotMatch(append, /queueMicrotask|setTimeout|requestAnimationFrame|setSelection/);
  assert.match(append, /files\.length === 0 \|\| disabledRef\.current/);
  assert.match(append, /editorControllerRef\.current !== controller/);
  assert.match(append, /editorViewRef\.current === view && !view\.isDestroyed && view\.dom\.isConnected/);
});

test("paste, drop and both picker buttons share the attachment interaction", () => {
  assert.match(source, /handlePaste[\s\S]*?appendFiles\(files\)/);
  assert.match(source, /handleDrop[\s\S]*?appendFiles\(files\)/);
  assert.equal(source.match(/onClick=\{openAttachmentPicker\}/g)?.length, 2);
  assert.match(source, /attachmentPickerOwnerRef\.current = editorViewRef\.current/);
  assert.match(source, /owner !== null && owner === editorViewRef\.current/);
  assert.match(source, /const owner = attachmentPickerOwnerRef\.current;\s*attachmentPickerOwnerRef\.current = null;/);
});
