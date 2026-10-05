import assert from "node:assert/strict";
import test from "node:test";

import { bindTouchInteractionMode } from "../apps/workbench-web/src/runtime/pointer-modality.js";

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
