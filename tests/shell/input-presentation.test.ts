import assert from "node:assert/strict";
import test from "node:test";
import {
  isTouchInteraction,
  isTouchPresentation,
  isTouchTextEntry,
  resolveUiDensity,
} from "../../packages/design-system-web/src/input-presentation.ts";
import { resolveWorkbenchResourceClass } from "../../apps/workbench-web/src/runtime/device-resource-class.ts";
import { bindTouchInteractionMode } from "../../apps/workbench-web/src/runtime/pointer-modality.ts";

function documentWith(dataset: Record<string, string> = {}) {
  const listeners = new Map<string, (event: unknown) => void>();
  const document = {
    documentElement: { dataset },
    addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
  } as unknown as Document;
  return { document, dataset, dispatch: (type: string, event: unknown) => listeners.get(type)?.(event) };
}

test("density resolves the preference against capability", () => {
  assert.equal(resolveUiDensity("auto", true), "touch");
  assert.equal(resolveUiDensity("auto", false), "compact");
  assert.equal(resolveUiDensity("on", false), "touch");
  assert.equal(resolveUiDensity("off", true), "compact");
});

test("touch text entry needs touch presentation and a touch interaction", () => {
  const { document, dispatch } = documentWith({ uiDensity: "touch" });
  const release = bindTouchInteractionMode(document);
  assert.equal(isTouchPresentation(document), true);
  assert.equal(isTouchTextEntry(document), false, "no interaction yet");
  dispatch("pointerdown", { pointerType: "touch" });
  assert.equal(isTouchInteraction(document), true);
  assert.equal(isTouchTextEntry(document), true);
  dispatch("pointermove", { pointerType: "mouse" });
  assert.equal(isTouchTextEntry(document), false, "a trackpad on a touch device keeps hardware Return");
  dispatch("pointerdown", { pointerType: "pen" });
  assert.equal(isTouchTextEntry(document), true);
  dispatch("keydown", { key: "Tab", target: null });
  assert.equal(isTouchTextEntry(document), false, "hardware Tab returns to keyboard ownership");
  release();
});

test("a compact preference keeps hardware Return after a tap", () => {
  const { document, dispatch } = documentWith({ uiDensity: "compact" });
  const release = bindTouchInteractionMode(document);
  dispatch("pointerdown", { pointerType: "touch" });
  assert.equal(isTouchInteraction(document), true);
  assert.equal(isTouchTextEntry(document), false);
  release();
});

test("resource class follows capacity, not touch presentation", () => {
  const view = (memory: number | undefined, coarse: boolean) =>
    ({
      navigator: memory === undefined ? {} : { deviceMemory: memory },
      matchMedia: (query: string) => ({ matches: coarse && query === "(pointer: coarse)" }),
    }) as unknown as Window;
  assert.equal(resolveWorkbenchResourceClass(undefined), "standard");
  assert.equal(resolveWorkbenchResourceClass(view(undefined, false)), "standard");
  assert.equal(
    resolveWorkbenchResourceClass(view(8, false)),
    "standard",
    "touch-capable laptops keep standard budgets",
  );
  assert.equal(resolveWorkbenchResourceClass(view(4, false)), "constrained");
  assert.equal(
    resolveWorkbenchResourceClass(view(undefined, true)),
    "constrained",
    "WebKit handhelds hide device memory",
  );
  assert.equal(resolveWorkbenchResourceClass(view(8, true)), "constrained");
});
