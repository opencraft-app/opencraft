'use strict';
const { randomUUID } = require('node:crypto');

/** One native selection capability per attached page. Never consult the host
 * clipboard or a DOM selection; the owned runtime returns the real Copy data. */
function installClipboard(p, send) {
  const wc = p.window.webContents;
  let context = null, capturing = null, generation = 0, busy = false;
  const retire = () => { context = null; capturing = null; ++generation; };
  const supported = frame => typeof frame?.getNativeClipboardContextForTesting === 'function'
    && typeof frame?.copyNativeClipboardForTesting === 'function';
  async function capture(frame) {
    retire();
    const version = generation, document = p.document;
    if (!p.visible || p.closed || !supported(frame)) return null;
    capturing = { processId: frame.processId, routingId: frame.routingId };
    const identity = capturing;
    const native = await frame.getNativeClipboardContextForTesting();
    if (generation !== version || p.document !== document || !p.visible || p.closed || !native?.available
      || typeof native.token !== 'string' || native.token.length > 128) return null;
    return context = { id: randomUUID(), frame, ...identity, token: native.token, document, expires: Date.now() + 15_000 };
  }
  const onMenu = async (_event, params) => {
    const version = generation + 1;
    const intent = p.contextIntent;
    try {
      // Electron emits this only after Chromium accepts the native context
      // menu. A website's preventDefault keeps its own menu in the video.
      const current = await capture(params.frame);
      if (version !== generation || !p.visible || p.closed) return;
      let link;
      try { const url = new URL(params.linkURL); if (['http:', 'https:'].includes(url.protocol)) link = url.href; } catch {}
      if (!current && !link) return;
      send({ type: 'context-menu', page: p.id, intent, context: current?.id ?? null,
        x: params.x, y: params.y, copy: !!current && params.editFlags?.canCopy === true,
        ...(link ? { link } : {}) });
    } catch { /* A destroyed or unsupported frame has no actionable menu. */ }
  };
  const onNavigation = (_event, _url, inPlace, mainFrame, processId, routingId) => {
    if (inPlace) return;
    const target = context ?? capturing;
    if (mainFrame || target && target.processId === processId && target.routingId === routingId) retire();
  };
  wc.on('context-menu', onMenu);
  wc.on('did-start-navigation', onNavigation);
  wc.on('render-process-gone', retire);
  return {
    available: () => supported(wc.mainFrame),
    retire,
    async copy(id) {
      if (busy || !p.visible || p.closed) throw new Error('Copy is unavailable');
      busy = true;
      try {
        const current = id === undefined ? await capture(wc.focusedFrame) : context;
        context = null; // Single use, including rejected and unknown outcomes.
        if (!current || (id !== undefined && id !== current.id) || current.document !== p.document
          || current.expires < Date.now()) throw new Error('Selection changed; select it again');
        const version = generation;
        const result = await current.frame.copyNativeClipboardForTesting(current.token);
        if (p.closed || !p.visible || current.document !== p.document || version !== generation)
          throw new Error('Copy was canceled');
        if (result?.status !== 'ok') throw new Error(result?.status === 'unsupported-format'
          ? 'This clipboard format is not supported yet' : 'Selection changed or produced no clipboard data');
        const valid = value => value === undefined || typeof value === 'string' && value.length <= 65536;
        if (!valid(result.text) || !valid(result.html) || result.text === undefined && result.html === undefined)
          throw new Error('Invalid copy result');
        return { ...(result.text !== undefined ? { text: result.text } : {}),
          ...(result.html !== undefined ? { html: result.html } : {}) };
      } finally { busy = false; }
    },
    dispose() { retire(); wc.off('context-menu', onMenu); wc.off('did-start-navigation', onNavigation); wc.off('render-process-gone', retire); },
  };
}
module.exports = { installClipboard };
