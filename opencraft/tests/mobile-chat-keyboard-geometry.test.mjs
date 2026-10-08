import assert from 'node:assert/strict';
import test from 'node:test';

const {
  advanceMobileKeyboard,
  hiddenMobileKeyboard,
  usableMobileKeyboardFrame,
  resolveMobileChatKeyboardShift,
  resolveMobileChatInputMaximumHeight,
  resolveMobileChatComposerMaximumHeight,
} = await import('../apps/workbench-expo/src/runtime/mobile-chat-keyboard-geometry.ts');

const phone = { x: 0, y: 100, width: 390, height: 744 };

test('docked iPhone keyboard moves the composer by its measured overlap after safe area', () => {
  assert.equal(resolveMobileChatKeyboardShift({
    viewport: phone,
    keyboard: { x: 0, y: 510, width: 390, height: 334 },
    composerHeight: 150,
    composerWidth: 342,
    bottomClearance: 34,
    keyboardGap: 12,
  }), 312);
});

test('iPad floating and hardware keyboards do not displace a clear composer', () => {
  const viewport = { x: 150, y: 50, width: 900, height: 680 };
  const base = { viewport, composerHeight: 145, composerWidth: 540, bottomClearance: 20, keyboardGap: 12 };
  assert.equal(resolveMobileChatKeyboardShift({ ...base, keyboard: null }), 0);
  assert.equal(resolveMobileChatKeyboardShift({ ...base, keyboard: { x: 880, y: 400, width: 150, height: 240 } }), 0);
  assert.equal(resolveMobileChatKeyboardShift({ ...base, keyboard: { x: 450, y: 300, width: 360, height: 200 } }), 0);
  assert.equal(resolveMobileChatKeyboardShift({ ...base, keyboard: { x: 150, y: 730, width: 900, height: 0 } }), 0);
});

test('iPad docked keyboard and resized viewport use container geometry', () => {
  assert.equal(resolveMobileChatKeyboardShift({
    viewport: { x: 150, y: 50, width: 900, height: 680 },
    keyboard: { x: 150, y: 450, width: 900, height: 280 },
    composerHeight: 145,
    composerWidth: 540,
    bottomClearance: 20,
    keyboardGap: 12,
  }), 272);
  assert.equal(resolveMobileChatKeyboardShift({
    viewport: { x: 0, y: 0, width: 390, height: 300 },
    keyboard: { x: 0, y: 100, width: 390, height: 200 },
    composerHeight: 130,
    composerWidth: 342,
    bottomClearance: 20,
    keyboardGap: 12,
  }), 170);
});

test('floating keyboard moves the composer only when their rectangles intersect', () => {
  assert.equal(resolveMobileChatKeyboardShift({
    viewport: { x: 150, y: 50, width: 900, height: 680 },
    keyboard: { x: 440, y: 610, width: 350, height: 95 },
    composerHeight: 145,
    composerWidth: 540,
    bottomClearance: 20,
    keyboardGap: 12,
  }), 112);
});

test('a compact tablet window bounds the editor while leaving the action row above the keyboard', () => {
  assert.equal(resolveMobileChatInputMaximumHeight({
    viewport: { x: 200, y: 40, width: 500, height: 300 },
    keyboard: { x: 200, y: 180, width: 500, height: 160 },
    keyboardShift: 160,
    bottomClearance: 20,
    keyboardGap: 12,
    controlsHeight: 54,
    normalMaximumHeight: 240,
  }), 54);
  assert.equal(resolveMobileChatInputMaximumHeight({
    viewport: { x: 200, y: 40, width: 500, height: 300 },
    keyboard: null,
    keyboardShift: 0,
    bottomClearance: 20,
    keyboardGap: 12,
    controlsHeight: 54,
    normalMaximumHeight: 240,
  }), 240);
});

test('an iPad floating keyboard does not force a smaller editor just because it crosses the card', () => {
  assert.equal(resolveMobileChatInputMaximumHeight({
    viewport: { x: 150, y: 50, width: 900, height: 680 },
    keyboard: { x: 440, y: 610, width: 350, height: 95 },
    keyboardShift: 112,
    bottomClearance: 20,
    keyboardGap: 12,
    controlsHeight: 54,
    normalMaximumHeight: 240,
  }), 240);
});

test('keyboard closing preserves its geometry until native motion finishes', () => {
  const frame = { x: 0, y: 510, width: 390, height: 334 };
  const opening = advanceMobileKeyboard(hiddenMobileKeyboard, { type: 'will-change', frame });
  assert.equal(opening.phase, 'opening');
  const open = advanceMobileKeyboard(opening, { type: 'did-show', frame });
  const closing = advanceMobileKeyboard(open, { type: 'will-hide' });
  assert.equal(closing.phase, 'closing');
  assert.deepEqual(closing.frame, frame);
  assert.deepEqual(advanceMobileKeyboard(closing, { type: 'will-change', frame: { ...frame, height: 0 } }), closing);
  assert.deepEqual(advanceMobileKeyboard(closing, { type: 'did-hide' }), hiddenMobileKeyboard);
});

test('floating keyboard reposition keeps the open phase and replaces the measured frame', () => {
  const first = { x: 440, y: 610, width: 350, height: 95 };
  const moved = { x: 440, y: 580, width: 350, height: 95 };
  const open = advanceMobileKeyboard(hiddenMobileKeyboard, { type: 'did-show', frame: first });
  assert.deepEqual(advanceMobileKeyboard(open, { type: 'will-change', frame: moved }), { frame: moved, phase: 'open' });
  assert.deepEqual(advanceMobileKeyboard(open, { type: 'deactivate' }), hiddenMobileKeyboard);
});

test('hardware keyboard accessory bar is ignored using composer control geometry', () => {
  const accessory = { x: 0, y: 780, width: 390, height: 64 };
  const full = { x: 0, y: 510, width: 390, height: 334 };
  assert.equal(usableMobileKeyboardFrame(accessory, 54, 34, 12), null);
  assert.deepEqual(usableMobileKeyboardFrame(full, 54, 34, 12), full);
});

test('compact docked keyboard bounds the whole composer while a floating keyboard does not', () => {
  const viewport = { x: 200, y: 40, width: 500, height: 300 };
  assert.equal(resolveMobileChatComposerMaximumHeight({
    viewport,
    keyboard: { x: 200, y: 180, width: 500, height: 160 },
    keyboardShift: 160,
    keyboardGap: 12,
  }), 128);
  assert.equal(resolveMobileChatComposerMaximumHeight({
    viewport,
    keyboard: { x: 300, y: 180, width: 200, height: 100 },
    keyboardShift: 160,
    keyboardGap: 12,
  }), undefined);
});
