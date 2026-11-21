'use strict';
const { randomUUID } = require('node:crypto');
const kinds = { 1:'text',2:'password',3:'search',4:'email',5:'number',6:'tel',7:'url',14:'textarea',15:'contenteditable' };
const modes = ['text','none','text','tel','url','email','numeric','decimal','search'];
const actions = ['','enter','done','go','next','previous','search','send'];
function keyboardPolicy(state) {
  const kind = kinds[state?.type];
  if (!kind || !state.active || typeof state.targetIdentity !== 'string' || !state.targetIdentity) return null;
  const secure = state.password === true || !!(state.flags & ((1 << 12) | (1 << 14)));
  const mode = Number.isInteger(state.mode) && state.mode > 0 && modes[state.mode] ? modes[state.mode] : ({email:'email',url:'url',tel:'tel',number:'decimal',search:'search'}[kind] || 'text');
  return { kind, secure, inputMode:mode, enterKeyHint:actions[state.action] || (kind === 'search' ? 'search' : 'enter'), multiline:state.type === 14 || state.type === 15, autoKeyboard:mode !== 'none' && !state.alwaysHideIme && state.virtualKeyboardPolicy !== 1 };
}


/** Native capabilities stay inside the worker. The client owns only an input
 * transaction id, never a DOM editor mirror or a reusable native target token. */
function installIme(p, send) {
  const wc = p.window.webContents;
  let retiring = Promise.resolve();
  let transaction = null, generation = 0, lastState = '', editor = null, identity = '';
  const supported = frame => typeof frame?.getNativeImeContextForTesting === 'function'
    && typeof frame?.applyNativeImeForTesting === 'function';
  function retire() {
    ++generation;
    const previous = transaction; transaction = null;
    if (previous?.native.compositionId) {
      retiring = retiring.then(async () => {
        try { await previous.frame.applyNativeImeForTesting({ token: previous.native.token,
          compositionId: previous.native.compositionId, type: 'cancel', text: '', selectionStart: 0, selectionEnd: 0 }); } catch {}
      });
    }
    return retiring;
  }
  const observe = () => {
    if (p.closed || !p.visible) return;
    try {
      const state = wc.getNativeTextInputState?.();
      const policy = supported(wc.mainFrame) ? keyboardPolicy(state) : null;
      const nextIdentity = policy ? JSON.stringify([state.targetIdentity,state.type,policy]) : '';
      if (nextIdentity !== identity) {
        // Observation is a hint, never a reusable native write capability.
        // A focus/type transition retires the old local transaction identity.
        identity = nextIdentity; editor = policy ? { id:randomUUID(), target:state.targetIdentity, type:state.type, policy, frame:wc.focusedFrame } : null;
        void retire();
      }
      const editable = !!editor;
      const b = state?.caretBounds;
      const caret = editable && b && ['x','y','width','height'].every(key => Number.isFinite(b[key]) && Math.abs(b[key]) <= 100000) && b.height > 0
        ? { x: b.x, y: b.y, width: b.width, height: b.height } : undefined;
      const value = { editable, ...(editor ? { editor:editor.id, keyboard:editor.policy } : {}), ...(caret ? { caret } : {}) }, encoded = JSON.stringify(value);
      if (lastState !== encoded) { lastState = encoded; send({ type: 'ime-state', page: p.id, ...value }); }
    } catch {}
  };
  const timer = setInterval(observe, 150); timer.unref();
  const clearTarget = () => { lastState = ''; identity = ''; editor = null; void retire(); };
  const onNavigation = (_event, _url, inPlace, mainFrame, processId, routingId) => {
    if (inPlace) return;
    const frame = transaction?.frame ?? editor?.frame;
    if (mainFrame || frame && Number.isInteger(processId) && Number.isInteger(routingId)
      && frame.processId === processId && frame.routingId === routingId) clearTarget();
  };
  wc.on('did-start-navigation', onNavigation);
  wc.on('render-process-gone', clearTarget);
  return {
    available: () => supported(wc.mainFrame),
    observe() { lastState = ''; observe(); },
    retire,
    async apply(input) {
      if (!/^[a-zA-Z0-9-]{20,100}$/.test(input?.id ?? '') || !['begin','compose','commit','cancel'].includes(input.type)) throw new Error('Invalid input transaction');
      if (input.type === 'cancel') { if (transaction?.id === input.id) await retire(); return; }
      if (p.closed || !p.visible) throw new Error('Input is unavailable');
      if (input.type === 'begin') {
        observe();
        const expected = editor;
        const legacy = input.editor === undefined && expected && [1,14,15].includes(expected.type) && !expected.policy.secure;
        if (!expected || (!legacy && input.editor !== expected.id)) throw new Error('Input target changed; focus the field again');
        await retire();
        const version = generation, document = p.document, frame = wc.focusedFrame;
        if (!supported(frame)) throw new Error('Native input is unavailable in this browser runtime');
        const native = await frame.getNativeImeContextForTesting();
        if (generation !== version || p.closed || !p.visible || document !== p.document || !native?.available || editor !== expected || native.targetIdentity !== expected.target || native.inputType !== expected.type)
          throw new Error('Focus an editable text field before typing');
        transaction = { id: input.id, frame, native, document };
        return;
      }
      const current = transaction;
      if (!current || current.id !== input.id || current.document !== p.document) throw new Error('Input target changed; type again');
      if (typeof input.text !== 'string' || input.text.length > 16384) throw new Error('Invalid input text');
      const version = generation;
      const result = await current.frame.applyNativeImeForTesting({ token: current.native.token,
        compositionId: current.native.compositionId, type: input.type, text: input.text,
        selectionStart: input.text.length, selectionEnd: input.text.length });
      if (p.closed || !p.visible || transaction !== current || version !== generation || current.document !== p.document)
        throw new Error('Input was canceled');
      if (result?.status !== 'processed') { transaction = null; throw new Error('Input target changed or the website rejected input'); }
      if (input.type === 'commit') transaction = null;
      else current.native = result.context;
      observe();
    },
    dispose() { clearInterval(timer); transaction = null; ++generation; wc.off('did-start-navigation', onNavigation); wc.off('render-process-gone', clearTarget); },
  };
}
module.exports = { installIme, keyboardPolicy };
