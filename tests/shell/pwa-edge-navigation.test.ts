import assert from "node:assert/strict";
import test from "node:test";
import { bindPwaEdgeNavigation } from "../../apps/workbench-web/src/runtime/pwa-edge-navigation";
import { createEdgeGestureBridge, readEdgeGestureHandoff } from "../../apps/workbench-web/src/runtime/edge-gesture-bridge";

function fixture(standalone?: boolean, embedded = false) {
  const view = Object.assign(new EventTarget(), { navigator: { standalone }, innerWidth: 390, top: null as unknown });
  const target = view;
  view.top = embedded ? {} : view;
  const document = Object.assign(target, { defaultView: view, documentElement: { clientWidth: 390 } }) as unknown as Document;
  const release = bindPwaEdgeNavigation(document);
  const touch = (xs: number[], cancelable = true) => {
    const event = new Event("touchstart", { cancelable, bubbles: true });
    Object.defineProperties(event, {
      touches: { value: xs.map(clientX => ({ clientX })) },
      changedTouches: { value: xs.map(clientX => ({ clientX })) },
    });
    target.dispatchEvent(event);
    return event;
  };
  return { target, release, touch, document };
}

test("iOS Home Screen contacts at both edges is cancelled before native history admission", () => {
  const { target, release, touch } = fixture(true);
  let observed = 0;
  target.addEventListener("touchstart", () => observed++);
  assert.equal(touch([0]).defaultPrevented, true);
  assert.equal(touch([23]).defaultPrevented, true);
  assert.equal(touch([366]).defaultPrevented, true);
  assert.equal(touch([389]).defaultPrevented, true);
  assert.equal(touch([390]).defaultPrevented, true);
  assert.equal(observed, 5, "local owners must still receive the event");
  release();
  assert.equal(touch([0]).defaultPrevented, false, "retired page must release input");
  release();
});

test("normal tabs and embedded documents retain native handling", () => {
  for (const [standalone, embedded] of [[undefined, false], [false, false], [true, true]] as const) {
    const { release, touch } = fixture(standalone, embedded);
    assert.equal(touch([0]).defaultPrevented, false);
    release();
  }
  assert.doesNotThrow(() => bindPwaEdgeNavigation({ defaultView: null } as Document)());
});

test("center gestures, multiple contacts and noncancelable events remain native", () => {
  const { release, touch } = fixture(true);
  for (const xs of [[24], [180], [365], [391], [-1], [1, 180], []]) {
    assert.equal(touch(xs).defaultPrevented, false, JSON.stringify(xs));
  }
  assert.equal(touch([1], false).defaultPrevented, false);
  release();
});


test("the right boundary follows the current viewport after rotation", () => {
  const { release, touch, document } = fixture(true);
  Object.assign(document.documentElement, { clientWidth: 844 });
  assert.equal(touch([389]).defaultPrevented, false);
  assert.equal(touch([819]).defaultPrevented, false);
  assert.equal(touch([820]).defaultPrevented, true);
  assert.equal(touch([844]).defaultPrevented, true);
  assert.equal(touch([845]).defaultPrevented, false);
  release(); assert.equal(touch([820]).defaultPrevented, false);
});

test("reserved original contacts reach application arbitration and retirement revokes the handoff", () => {
  const { target, release, touch } = fixture(true);
  const observed: Event[] = [];
  target.addEventListener("touchstart", event => observed.push(event));
  const left = touch([4]), right = touch([386]);
  assert.deepEqual(observed, [left, right], "one original event, without synthetic replay");
  assert.equal(readEdgeGestureHandoff(left), "left");
  assert.equal(readEdgeGestureHandoff(right), "right");
  assert.equal(readEdgeGestureHandoff(touch([180])), undefined);
  assert.equal(readEdgeGestureHandoff(touch([4], false)), undefined);
  release();
  assert.equal(readEdgeGestureHandoff(left), undefined);
  assert.equal(readEdgeGestureHandoff(right), undefined);
});

test("the shared handoff carries input without depending on a PWA host", () => {
  const bridge = createEdgeGestureBridge();
  const event = new Event("touchstart");
  bridge.handoff(event, "right");
  assert.equal(readEdgeGestureHandoff(event), "right");
  bridge.dispose(); bridge.dispose();
  bridge.handoff(event, "left");
  assert.equal(readEdgeGestureHandoff(event), undefined);
});
