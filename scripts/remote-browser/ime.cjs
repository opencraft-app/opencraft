'use strict';
const { randomUUID } = require('node:crypto');
const { createImeActivation } = require('./activation.cjs');
const kinds = { 1:'text',2:'password',3:'search',4:'email',5:'number',6:'tel',7:'url',14:'textarea',15:'contenteditable' };
const modes = ['text','none','text','tel','url','email','numeric','decimal','search'];
const actions = ['','enter','done','go','next','previous','search','send'];
const editCommands = { undo: 'Undo', redo: 'Redo', deleteWordBackward: 'DeleteWordBackward', deleteWordForward: 'DeleteWordForward' };
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
  const activation = createImeActivation(p);
  let retiring = Promise.resolve();
  let transaction = null, generation = 0, lastState = '', editor = null, identity = '';
  let timer = null, nativeObservation = false, disposed = false;
  let observationRevision = 0, observationFlight = null, observationDirty = false;
  const supported = frame => typeof frame?.getNativeImeContextForTesting === 'function'
    && typeof frame?.applyNativeImeForTesting === 'function';
  function retire() {
    ++generation;
    const previous = transaction; transaction = null;
    if (previous?.native.compositionId) {
      retiring = retiring.then(async () => {
        try { const result = await previous.frame.applyNativeImeForTesting({ token: previous.native.token,
          compositionId: previous.native.compositionId, type: 'cancel', text: '', selectionStart: 0, selectionEnd: 0 });
          if (previous.activation) activation.completed(previous.activation, previous.frame, previous.native.focusIdentity, result, {document:previous.document,control:previous.control}); } catch {}
      });
    }
    return retiring;
  }
  function pauseObservation() {
    clearInterval(timer); timer = null;
    if (nativeObservation) {
      nativeObservation = false;
      try { wc.setNativeTextInputStateObservation(false); } catch {}
    }
  }
  function syncObservation() {
    if (disposed) return;
    if (!p.visible) { pauseObservation(); return; }
    if (!nativeObservation && typeof wc.setNativeTextInputStateObservation === 'function') {
      try { nativeObservation = wc.setNativeTextInputStateObservation(true) === true; } catch {}
    }
    if (nativeObservation || typeof wc.getNativeTextInputState !== 'function') {
      clearInterval(timer); timer = null;
    } else if (!timer) {
      // Compatibility for retained older runtimes. Native notification runtimes
      // have no polling timer, including while their page is hidden.
      timer = setInterval(observe, 150); timer.unref();
    }
  }
  function publishObservation(state, metadata) {
    const policy = supported(wc.mainFrame) ? keyboardPolicy(state) : null;
    if (metadata && policy && (!metadata.available || metadata.targetIdentity !== state.targetIdentity || metadata.inputType !== state.type)) return;
    const focus = metadata?.available ? metadata.focusIdentity : undefined;
    const nextIdentity = policy ? JSON.stringify([state.targetIdentity,state.type,focus,policy]) : '';
    if (nextIdentity !== identity) {
      identity = nextIdentity;
      editor = policy ? { id:randomUUID(), target:state.targetIdentity, type:state.type, focus, policy, frame:wc.focusedFrame } : null;
      if (transaction && (!transaction.activation || metadata && transaction.native.focusIdentity !== focus)) void retire();
    }
    const editable = !!editor, b = state?.caretBounds;
    const caret = editable && b && ['x','y','width','height'].every(key => Number.isFinite(b[key]) && Math.abs(b[key]) <= 100000) && b.height > 0
      ? { x:b.x, y:b.y, width:b.width, height:b.height } : undefined;
    const association = activation.observation(state, metadata);
    const value = { editable, ...(editor ? {editor:editor.id,keyboard:editor.policy} : {}),
      ...(association ? {activation:association} : {}), ...(caret ? {caret} : {}) }, encoded = JSON.stringify(value);
    if (lastState !== encoded) { lastState = encoded; send({type:'ime-state',page:p.id,...value}); }
  }
  function observe() {
    if (disposed || p.closed) return;
    syncObservation();
    const revision = ++observationRevision;
    if (!p.visible) return;
    // Retained old runtimes keep their synchronous hint path. The new native
    // path pairs browser keyboard policy with read-only renderer focus identity.
    if (!activation.available()) {
      try { publishObservation(wc.getNativeTextInputState?.()); } catch {}
      return;
    }
    if (observationFlight) { observationDirty = true; return observationFlight; }
    const frame = wc.focusedFrame, document = p.document, control = p.controlToken;
    let state;
    try { state = wc.getNativeTextInputState?.(); } catch { return; }
    const fingerprint = value => JSON.stringify([value?.targetIdentity,value?.type,keyboardPolicy(value)]);
    const snapshot = fingerprint(state);
    observationFlight = (async () => {
      try {
        const metadata = await frame?.getNativeImeFocusForTesting();
        if (disposed || p.closed || !p.visible || revision !== observationRevision || document !== p.document
          || control !== p.controlToken || wc.focusedFrame !== frame || !metadata) return;
        const latest = wc.getNativeTextInputState?.();
        if (fingerprint(latest) !== snapshot) { observationDirty = true; return; }
        publishObservation(latest,metadata);
      } catch {} // A disconnected frame cannot grant input authority.
      finally {
        observationFlight = null;
        if (observationDirty) { observationDirty = false; queueMicrotask(observe); }
      }
    })();
    return observationFlight;
  }
  const clearTarget = () => { ++observationRevision; activation.reset(); lastState = ''; identity = ''; editor = null; void retire(); };
  const onNavigation = (_event, _url, inPlace, mainFrame, processId, routingId) => {
    if (inPlace) return;
    const frame = transaction?.frame ?? activation.frame ?? editor?.frame;
    if (mainFrame || frame && Number.isInteger(processId) && Number.isInteger(routingId)
      && frame.processId === processId && frame.routingId === routingId) clearTarget();
  };
  wc.on('did-start-navigation', onNavigation);
  wc.on('render-process-gone', clearTarget);
  wc.on('native-text-input-state-changed', observe);
  syncObservation();
  return {
    available: () => supported(wc.mainFrame),
    activationAvailable: activation.available,
    startActivation: id => activation.start(id),
    resetActivation: () => activation.reset(),
    async bindActivation(id, receipt) { const bound = await activation.bind(id, receipt); await observe(); return bound; },
    observe() { lastState = ''; return observe(); },
    retire,
    async edit(input, checkCurrent = () => {}) {
      if (!Object.hasOwn(editCommands, input?.command)) throw new Error('Invalid editing command');
      const document = p.document, control = p.controlToken;
      await observe();
      const expected = editor;
      if (document !== p.document || control !== p.controlToken) throw new Error('Browser control or document changed');
      if (p.closed || !p.visible || !expected || input.editor !== expected.id) throw new Error('Input target changed; focus the field again');
      // These are keyboard editing intents, not replacement text. Retire
      // preedit first and recheck the observed focus after that async boundary.
      await retire(); await observe(); checkCurrent();
      if (p.closed || !p.visible || document !== p.document || control !== p.controlToken || editor !== expected || wc.focusedFrame !== expected.frame)
        throw new Error('Input target changed; focus the field again');
      // Chromium executes a bounded native command on its current selection,
      // with normal keydown/beforeinput handlers. No OS shortcut or DOM mirror.
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', commands: [editCommands[input.command]] });
      observe();
    },
    async apply(input) {
      if (!/^[a-zA-Z0-9-]{20,100}$/.test(input?.id ?? '') || !['begin','compose','commit','cancel'].includes(input.type)) throw new Error('Invalid input transaction');
      if (input.type === 'cancel') { if (transaction?.id === input.id) await retire(); return; }
      if (p.closed || !p.visible) throw new Error('Input is unavailable');
      if (input.type === 'begin') {
        const document = p.document, control = p.controlToken;
        await observe();
        const expected = editor, causal = input.activation !== undefined;
        if (document !== p.document || control !== p.controlToken) throw new Error('Browser control or document changed');
        const legacy = input.editor === undefined && expected && [1,14,15].includes(expected.type) && !expected.policy.secure;
        if (!causal && (!expected || (!legacy && input.editor !== expected.id))) throw new Error('Input target changed; focus the field again');
        await retire();
        const version = generation;
        if (document !== p.document || control !== p.controlToken) throw new Error('Browser control or document changed');
        let frame, native;
        if (causal) ({frame,native} = await activation.capture(input.activation, input.editor === expected?.id ? expected : undefined));
        else {
          frame = wc.focusedFrame;
          if (!supported(frame)) throw new Error('Native input is unavailable in this browser runtime');
          native = await frame.getNativeImeContextForTesting();
        }
        if (generation !== version || p.closed || !p.visible || document !== p.document || control !== p.controlToken || !native?.available
          || !causal && (editor !== expected || native.targetIdentity !== expected.target || native.inputType !== expected.type
            || expected.focus && native.focusIdentity !== expected.focus))
          throw new Error('Focus an editable text field before typing');
        transaction = { id: input.id, frame, native, document, control, ...(causal ? {activation:input.activation} : {}) };
        return;
      }
      const current = transaction;
      if (!current || current.id !== input.id || current.document !== p.document || current.control !== p.controlToken) throw new Error('Input target changed; type again');
      if (typeof input.text !== 'string' || input.text.length > 16384) throw new Error('Invalid input text');
      // The native capability deliberately rejects empty compose. Clearing
      // preedit cancels only our owned composition while keeping the local
      // transaction and the returned single-use context for its next update.
      const type = input.type === 'compose' && input.text === '' ? 'cancel' : input.type;
      if (type === 'cancel' && !current.native.compositionId) return;
      const version = generation;
      const result = await current.frame.applyNativeImeForTesting({ token: current.native.token,
        compositionId: current.native.compositionId, type, text: input.text,
        selectionStart: input.text.length, selectionEnd: input.text.length });
      if (p.closed || !p.visible || transaction !== current || version !== generation || current.document !== p.document || current.control !== p.controlToken)
        throw new Error('Input was canceled');
      if (input.type === 'commit' && current.activation) activation.completed(current.activation, current.frame, current.native.focusIdentity, result, {document:current.document,control:current.control});
      // The site may focus another editor inside beforeinput/input. A terminal
      // native dispatch is complete even when that handler changes focus; its
      // remote result remains authoritative. This acknowledges dispatch, never
      // promises insertion, retries text, or redirects an ongoing composition.
      const terminalFocusChange = input.type === 'commit' && result?.dispatched === true
        && result.status === 'target-changed-during-operation';
      if (!terminalFocusChange && result?.status !== 'processed' || current.activation && input.type !== 'commit' && result.context?.focusIdentity !== current.native.focusIdentity) { transaction = null; throw new Error('Input target changed or the website rejected input'); }
      if (input.type === 'commit') transaction = null;
      else current.native = result.context;
      observe();
    },
    dispose() {
      ++observationRevision; activation.reset(); disposed = true;
      wc.off('native-text-input-state-changed', observe); pauseObservation();
      transaction = null; ++generation;
      wc.off('did-start-navigation', onNavigation); wc.off('render-process-gone', clearTarget);
    },
  };
}
module.exports = { installIme, keyboardPolicy };
