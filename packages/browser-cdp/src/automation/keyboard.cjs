'use strict';
const { failure } = require('./errors.cjs');
const keys = {
  Enter: ['Enter', 13, '\r'], Tab: ['Tab', 9, '\t'], Escape: ['Escape', 27],
  Backspace: ['Backspace', 8], Delete: ['Delete', 46], Space: ['Space', 32, ' '],
  ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39], ArrowDown: ['ArrowDown', 40],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34],
};
const modifiers = { Alt: [1, 18, 'AltLeft'], Control: [2, 17, 'ControlLeft'], Meta: [4, 91, 'MetaLeft'], Shift: [8, 16, 'ShiftLeft'] };
function parseKey(chord, platform) {
  if (typeof chord !== 'string' || chord.length > 100) throw failure('INVALID_ARGUMENT', 'Invalid browser key');
  const parts = chord.split('+'); const key = parts.pop();
  const held = parts.map(part => part === 'Ctrl' ? 'Control' : ['Cmd', 'Command'].includes(part) ? 'Meta'
    : ['ControlOrMeta', 'Mod'].includes(part) ? (platform === 'darwin' ? 'Meta' : 'Control') : part);
  if (new Set(held).size !== held.length || held.some(part => !modifiers[part])) throw failure('INVALID_ARGUMENT', 'Unsupported key modifier');
  let descriptor = keys[key];
  if (!descriptor && /^[a-z]$/i.test(key)) descriptor = [`Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0), key];
  if (!descriptor && /^[0-9]$/.test(key)) descriptor = [`Digit${key}`, key.charCodeAt(0), key];
  if (!descriptor) throw failure('INVALID_ARGUMENT', 'Unsupported browser key');
  const [code, windowsVirtualKeyCode, text] = descriptor;
  const mask = held.reduce((sum, name) => sum | modifiers[name][0], 0);
  return { held, mask, key: key === 'Space' ? ' ' : mask & 8 && key.length === 1 ? key.toUpperCase() : key, code, windowsVirtualKeyCode,
    text: mask & 7 ? undefined : mask & 8 ? text?.toUpperCase() : text };
}
async function press(send, cleanup, chord, platform) {
  const parsed = parseKey(chord, platform), pressed = []; let mask = 0, keyPressed = false;
  const main = { key: parsed.key, code: parsed.code, windowsVirtualKeyCode: parsed.windowsVirtualKeyCode };
  let primaryError;
  try {
    for (const name of parsed.held) {
      const [bit, windowsVirtualKeyCode, code] = modifiers[name]; mask |= bit; pressed.push(name);
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode, modifiers: mask });
    }
    keyPressed = true;
    await send('Input.dispatchKeyEvent', { type: parsed.text ? 'keyDown' : 'rawKeyDown', ...main,
      modifiers: mask, ...(parsed.text ? { text: parsed.text, unmodifiedText: parsed.text } : {}) });
  } catch (error) { primaryError = error; throw error; }
  finally {
    // Releases are cleanup, including after navigation/abort. Never replay a down.
    const releases = [];
    if (keyPressed) releases.push({ type: 'keyUp', ...main, modifiers: mask });
    for (const name of pressed.reverse()) {
      const [bit, windowsVirtualKeyCode, code] = modifiers[name]; mask &= ~bit;
      releases.push({ type: 'keyUp', key: name, code, windowsVirtualKeyCode, modifiers: mask });
    }
    let releaseError;
    for (const event of releases) { try { await cleanup('Input.dispatchKeyEvent', event); } catch (error) { releaseError ??= error; } }
    if (releaseError && !primaryError) throw releaseError;
  }
}
module.exports = { press, parseKey };
