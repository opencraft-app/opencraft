'use strict';
const { ipcRenderer } = require('electron');
const { createAnnotationOverlay } = require('@opencraft/browser-preview-bridge/annotation-overlay');
const overlay = createAnnotationOverlay(window);
// Resolve only unique, bounded paths in accessible documents/open shadow roots.
// Binding happens once; an overlay never adopts a replacement with the same selector.
function resolveTarget(selector, framePath) {
  const unique = (root, value) => {
    if (typeof value !== 'string' || value.length > 500) return null;
    const parts = value.split(' >>> ');
    if (parts.length > 16) return null;
    let element = null;
    for (let index = 0; index < parts.length; index++) {
      const matches = root.querySelectorAll(parts[index]);
      if (matches.length !== 1) return null;
      element = matches[0];
      if (index < parts.length - 1) { root = element.shadowRoot; if (!root) return null; }
    }
    return element;
  };
  if (framePath !== undefined && (!Array.isArray(framePath) || framePath.length > 16)) return null;
  let root = document;
  for (const segment of framePath || []) {
    const frame = unique(root, segment?.selector);
    if (!frame || !['IFRAME', 'FRAME'].includes(frame.tagName)) return null;
    root = frame.contentDocument;
    if (!root) return null;
  }
  return unique(root, selector);
}
ipcRenderer.on('opencraft:annotation', (_event, command) => {
  if (!command || typeof command !== 'object') return;
  if (command.type === 'hit') { ipcRenderer.send('opencraft:annotation-applied', command.requestId, overlay.hit(command.point)); return; }
  if (command.type === 'pause') { overlay.suspend(command.paused === true); return; }
  if (command.type === 'bind-generation') {
    try { const root = resolveTarget('html', command.framePath); if (root) overlay.bindGeneration(command.key, root.ownerDocument); } catch {}
    return;
  }
  if (command.type === 'bind') {
    if (typeof command.key !== 'string' || command.key.length > 100) return;
    let target = null;
    try { target = resolveTarget(command.selector, command.framePath); } catch {}
    overlay.bind(command.key, target); return;
  }
  overlay.draw(command.type === 'boxes' ? command.boxes : [], command.color);
  if (typeof command.requestId === 'string') requestAnimationFrame(() => requestAnimationFrame(() => ipcRenderer.send('opencraft:annotation-applied', command.requestId)));
});
window.addEventListener('pagehide', () => overlay.dispose(), { once: true });
