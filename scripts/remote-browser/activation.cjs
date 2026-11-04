'use strict';
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{20,100}$/.test(id);
const changed = () => Object.assign(new Error('Input target changed; focus the field again'), { code:'INPUT_TARGET_CHANGED', retryable:true });
const supported = frame => frame?.nativeImeContextVersionForTesting >= 2
  && typeof frame.getNativeImeFocusForInputForTesting === 'function'
  && typeof frame.getNativeImeFocusForTesting === 'function'
  && typeof frame.getNativeImeContextForTesting === 'function'
  && typeof frame.applyNativeImeForTesting === 'function';
const focusIdentity = context => context?.available === true
  && typeof context.focusIdentity === 'string' && context.focusIdentity.length > 0 && context.focusIdentity.length <= 256;

// A click/key binds editor focus, not a frozen value or a reusable write grant.
// Only the worker retains native identities; every transaction gets a fresh
// single-use native context after checking its controller/document lifetime.
function createImeActivation(p) {
  const wc = p.window.webContents;
  let activation = null;
  const current = state => state && state === activation && !p.closed && p.visible
    && state.document === p.document && state.control === p.controlToken;
  const available = () => typeof wc.sendInputEventWithNativeInputTicket === 'function' && supported(wc.mainFrame);
  return {
    available,
    get frame() { return activation?.frame; },
    reset() { activation = null; },
    start(id) {
      if (!validId(id) || !available() || p.closed || !p.visible) throw changed();
      activation = { id, document:p.document, control:p.controlToken, frame:null, focus:null, target:null, type:null };
    },
    async bind(id, receipt) {
      const state = activation;
      if (!current(state) || state.id !== id) return false;
      const frame = wc.focusedFrame;
      if (!supported(frame) || typeof receipt?.nativeInputTicket !== 'string') { return false; }
      const native = await frame.getNativeImeFocusForInputForTesting(receipt.nativeInputTicket);
      if (!current(state)) return false;
      if (!focusIdentity(native) || wc.focusedFrame !== frame) { return false; }
      state.frame = frame; state.focus = native.focusIdentity; state.target = native.targetIdentity; state.type = native.inputType;
      // This native read-only query does not return or invalidate edit tokens.
      return true;
    },
    async capture(id, expected) {
      const state = activation;
      if (!validId(id) || !current(state) || state.id !== id) throw changed();
      // A scroll has no native tap receipt. It may continue only the exact
      // already-observed editor captured by the client before this request.
      // An unknown target never acquires authority from a later observation.
      const fallback = !state.focus && expected?.focus;
      const frame = state.frame ?? (fallback ? expected.frame : null);
      if (!frame || wc.focusedFrame !== frame) throw changed();
      const native = await frame.getNativeImeContextForTesting();
      if (!current(state) || wc.focusedFrame !== frame || !focusIdentity(native)
        || native.focusIdentity !== (state.focus ?? expected?.focus)
        || native.targetIdentity !== (state.target ?? expected?.target)
        || native.inputType !== (state.type ?? expected?.type)) throw changed();
      if (!state.focus) {
        state.frame = frame; state.focus = native.focusIdentity;
        state.target = native.targetIdentity; state.type = native.inputType;
      }
      return { frame, native };
    },
    observation(observed, nativeFocus) {
      const state = activation;
      return current(state) && state.focus && wc.focusedFrame === state.frame
        && observed?.targetIdentity === state.target && observed?.type === state.type
        && nativeFocus?.focusIdentity === state.focus ? state.id : undefined;
    },
    // A terminal native operation can hand focus to another editor in its own
    // renderer task. Its returned context is causal evidence, not an excuse to
    // replay old text there. A later independent focus change fails capture().
    completed(id, frame, originalFocus, result, origin) {
      const state = activation;
      if (!validId(id) || !current(state) || state.frame !== frame || state.focus !== originalFocus || result?.dispatched !== true
        || origin?.control !== state.control || origin?.document !== state.document) return;
      const next = result.context;
      if (!focusIdentity(next)) { activation = null; return; }
      state.focus = next.focusIdentity; state.target = next.targetIdentity; state.type = next.inputType;
    },
  };
}
module.exports = { createImeActivation };
