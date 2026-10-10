import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMobileShellSwipeTarget, resolveMobileShellSwipeAdmission } from '../apps/workbench-expo/src/runtime/mobile-shell-swipe.ts';

const closed = { navigationProgress: 0, docked: false, panelAvailable: true, panelOpen: false, contentOwned: false };
test('a closed phone shell opens opposite panels with opposite strokes', () => {
  assert.equal(resolveMobileShellSwipeTarget({ ...closed, translationX: 25 }), 'navigation');
  assert.equal(resolveMobileShellSwipeTarget({ ...closed, translationX: -25 }), 'panel');
  assert.equal(resolveMobileShellSwipeTarget({ ...closed, panelAvailable: false, translationX: -25 }), 'none');
});
test('closing a navigation stroke never becomes a right panel stroke', () => {
  for (const progress of [1, 0.7, 0.1]) {
    assert.equal(resolveMobileShellSwipeTarget({ ...closed, navigationProgress: progress, translationX: -30 }), 'navigation');
  }
});
test('an open right panel returns to chat without opening left navigation', () => {
  assert.equal(resolveMobileShellSwipeTarget({ ...closed, panelOpen: true, translationX: 30 }), 'panel');
  assert.equal(resolveMobileShellSwipeTarget({ ...closed, panelOpen: true, translationX: -30 }), 'panel');
});
test('content-owned touches and docked navigation are excluded', () => {
  for (const translationX of [-30, 30]) assert.equal(resolveMobileShellSwipeTarget({ ...closed, contentOwned: true, translationX }), 'none');
  assert.equal(resolveMobileShellSwipeTarget({ ...closed, docked: true, translationX: 30 }), 'none');
  assert.equal(resolveMobileShellSwipeTarget({ ...closed, docked: true, translationX: -30 }), 'panel');
});

const admission = { ...closed, owner: 'pending', touchCount: 1, translationY: 0 };
test('vertical and diagonal scrolling never activate either Shell pane', () => {
  for (const [translationX, translationY] of [[3, 11], [-5, -14], [20, 15], [-20, -15], [40, 39]]) {
    assert.equal(resolveMobileShellSwipeAdmission({ ...admission, translationX, translationY }), 'content');
  }
  assert.equal(resolveMobileShellSwipeAdmission({ ...admission, translationX: 8, translationY: 5 }), 'pending');
});
test('clear horizontal intent can open either pane but unavailable intent yields', () => {
  assert.equal(resolveMobileShellSwipeAdmission({ ...admission, translationX: 20, translationY: 3 }), 'navigation');
  assert.equal(resolveMobileShellSwipeAdmission({ ...admission, translationX: -20, translationY: 3 }), 'panel');
  assert.equal(resolveMobileShellSwipeAdmission({ ...admission, translationX: -20, panelAvailable: false }), 'content');
  assert.equal(resolveMobileShellSwipeAdmission({ ...admission, translationX: 20, docked: true }), 'content');
});
test('ownership is sticky through direction reversal and resets only for a new touch', () => {
  let owner = resolveMobileShellSwipeAdmission({ ...admission, translationX: 5, translationY: 15 });
  owner = resolveMobileShellSwipeAdmission({ ...admission, owner, translationX: -80, translationY: 15 });
  assert.equal(owner, 'content');
  assert.equal(resolveMobileShellSwipeAdmission({ ...admission, translationX: -25 }), 'panel');
  assert.equal(resolveMobileShellSwipeAdmission({ ...admission, owner: 'panel', translationX: 30, translationY: 50 }), 'panel');
  assert.equal(resolveMobileShellSwipeAdmission({ ...admission, owner: 'navigation', translationX: -60 }), 'navigation');
});
test('controls and multiple contacts yield without activating a no-op pan', () => {
  assert.equal(resolveMobileShellSwipeAdmission({ ...admission, contentOwned: true, translationX: 50 }), 'content');
  for (const touchCount of [0, 2]) assert.equal(resolveMobileShellSwipeAdmission({ ...admission, touchCount, translationX: 50 }), 'content');
});
