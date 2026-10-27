import assert from "node:assert/strict";
import test from "node:test";

import { bindTouchInteractionMode } from "../../apps/workbench-web/src/runtime/pointer-modality.js";

test("touch suppresses hover and fallback focus rings until mouse or hardware Tab navigation", () => {
  const listeners = new Map<string, (event: { pointerType?: string; key?: string }) => void>();
  const root = { dataset: {} as Record<string, string> };
  const document = {
    documentElement: root,
    addEventListener(type: string, listener: (event: { pointerType?: string; key?: string }) => void) {
      listeners.set(type, listener);
    },
    removeEventListener(type: string) { listeners.delete(type); },
  } as unknown as Document;
  const dispose = bindTouchInteractionMode(document);
  const emit = (type: string, pointerType: string) => listeners.get(type)?.({ pointerType });
  const key = (value: string) => listeners.get("keydown")?.({ key: value });

  emit("pointerdown", "touch");
  assert.equal(root.dataset.touchInteraction, "true");
  emit("pointermove", "touch");
  assert.equal(root.dataset.touchInteraction, "true");
  emit("pointerdown", "mouse"); // compatibility events must not restore hover
  assert.equal(root.dataset.touchInteraction, "true");
  emit("pointermove", "mouse");
  assert.equal(root.dataset.touchInteraction, undefined);
  emit("pointerdown", "pen");
  assert.equal(root.dataset.touchInteraction, "true");
  key("a"); // virtual-keyboard text entry retains touch presentation
  assert.equal(root.dataset.touchInteraction, "true");
  key("Tab");
  assert.equal(root.dataset.touchInteraction, undefined);
  emit("pointerdown", "touch");
  assert.equal(root.dataset.touchInteraction, "true");

  dispose();
  assert.equal(root.dataset.touchInteraction, undefined);
  assert.equal(listeners.size, 0);
});


test("pointer-origin return stays quiet until intentional keyboard navigation, without blurring", () => {
  const listeners = new Map<string, (event: any) => void>();
  const root = { dataset: {} as Record<string, string> };
  const document = {
    documentElement: root,
    addEventListener(type: string, listener: (event: any) => void) { listeners.set(type, listener); },
    removeEventListener(type: string) { listeners.delete(type); },
  } as unknown as Document;
  const dispose = bindTouchInteractionMode(document);
  const pointer = (type: string, pointerType = "mouse") => listeners.get(type)?.({pointerType});
  const key = (key: string, editing = false) => listeners.get("keydown")?.({key, target: {closest: () => editing ? {} : null}});
  pointer("pointerdown");
  assert.equal(root.dataset.pointerFocus, "true");
  key("Escape"); // mouse-opened Radix menu dismissal does not claim keyboard navigation
  assert.equal(root.dataset.pointerFocus, "true");
  for (const value of ["a", " ", "Enter", "ArrowLeft"]) key(value, true);
  assert.equal(root.dataset.pointerFocus, "true", "text editing must not change presentation of return controls");
  for (const value of ["Tab", "ArrowDown", "Home", "End", "PageDown", "Enter", " "]) {
    pointer("pointerdown"); key(value);
    assert.equal(root.dataset.pointerFocus, undefined, value + " starts keyboard navigation");
    pointer("pointermove");
    assert.equal(root.dataset.pointerFocus, undefined, "moving the mouse must retain the keyboard indicator");
  }
  pointer("pointerdown", "pen");
  key("Tab", true);
  assert.equal(root.dataset.pointerFocus, undefined);
  assert.equal(root.dataset.touchInteraction, undefined);
  pointer("pointerdown"); dispose();
  assert.deepEqual(root.dataset, {});
  assert.equal(listeners.size, 0);
});
