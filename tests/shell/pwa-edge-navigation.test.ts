import assert from "node:assert/strict";
import test from "node:test";
import { bindPwaEdgeNavigation } from "../../apps/workbench-web/src/runtime/pwa-edge-navigation";

function fixture(standalone?: boolean, embedded = false) {
  const target = new EventTarget();
  const view = { navigator: { standalone }, top: null as unknown };
  view.top = embedded ? {} : view;
  const document = Object.assign(target, { defaultView: view }) as unknown as Document;
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
  return { target, release, touch };
}

test("iOS Home Screen left-edge contact is cancelled before native history admission", () => {
  const { target, release, touch } = fixture(true);
  let observed = 0;
  target.addEventListener("touchstart", () => observed++);
  assert.equal(touch([0]).defaultPrevented, true);
  assert.equal(touch([19]).defaultPrevented, true);
  assert.equal(observed, 2, "local owners must still receive the event");
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

test("center/right gestures, multiple contacts and noncancelable events remain native", () => {
  const { release, touch } = fixture(true);
  for (const xs of [[20], [180], [389], [-1], [1, 180], []]) {
    assert.equal(touch(xs).defaultPrevented, false, JSON.stringify(xs));
  }
  assert.equal(touch([1], false).defaultPrevented, false);
  release();
});
